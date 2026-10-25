import { type CredentialMatcher, credentialMatcher, type MatchState } from "./credential-matcher.ts";

/** Fixed allowance, in string-index units: terminal strings longer than this end as malformed text, and
 * held raw text and its maps never exceed the longest credential variant plus this allowance plus one.
 * Output held as a possible whole short credential never exceeds the longest variant. */
export const TERMINAL_HOLD = 4_096;
const MARKER = "[redacted]";
// Each credential is matched in five readings of the raw text: A drops only control bytes; B strips
// strictly (ECMA-48: strings run until their terminator); C strips leniently and is what is published
// (a line break, another escape or the hold ends a string as visible text). D is C in which the latest
// ESC or CSI introducer is stray, so its parameters and final byte stay text; E is C in which an earlier
// one was. A stray introducer therefore never consumes a credential, even one holding formatting.
const [A, B, C, D, E, FORK] = [1, 2, 4, 8, 16, 32];
const [GROUND, ESC, ESC_INTER, CSI, STRING, STRING_ESC] = [0, 1, 2, 3, 4, 5];
const [TEXT, DROP, BODY, BREAK] = [0, 1, 2, 3];
type Parser = { state: number; osc: boolean; body: number };
// held: a backslash not yet matched, since a following slash reads with it as one escaped slash.
type View = { state: MatchState; count: number; ring: number[]; held?: number };

// Bulk processing stops at controls and backslashes, and inside a lenient string also at line breaks.
const STOPS = ["", "\\n\\r"].map(
  (breaks) =>
    new RegExp(
      `[${["\\0-\\x08", "\\x0b\\x0c", "\\x0e-\\x1f", "\\x7f-\\x9f", "\\\\", breaks].join("")}]`,
      "g",
    ),
);
const control = (c: number) => (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f);
/** Classify one character; BREAK ends a malformed string before it, and the caller rereads it. */
function advance(p: Parser, c: number, pos: number, strict: boolean): number {
  switch (p.state) {
    case ESC:
      if (c === 0x5b) p.state = CSI;
      else if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f)
        Object.assign(p, { state: STRING, osc: c === 0x5d, body: pos });
      else if (c >= 0x20 && c <= 0x2f) {
        p.state = ESC_INTER;
        return BODY;
      } else {
        p.state = GROUND;
        if (c >= 0x30 && c <= 0x7e) return BODY;
        break;
      }
      return DROP;
    case ESC_INTER:
    case CSI:
      if (c >= 0x20 && (c <= 0x2f || (p.state === CSI && c <= 0x3f))) return BODY;
      if (c >= (p.state === ESC_INTER ? 0x30 : 0x40) && c <= 0x7e) {
        p.state = GROUND;
        return BODY;
      }
      p.state = GROUND;
      break;
    case STRING:
      if (c === 0x1b) p.state = STRING_ESC;
      else if (c === 0x9c || (c === 0x07 && p.osc)) p.state = GROUND;
      else if (
        (c >= 0x80 && c <= 0x9f) ||
        (!strict && (c === 10 || c === 13 || pos - p.body >= TERMINAL_HOLD))
      ) {
        p.state = GROUND;
        return BREAK;
      }
      return DROP;
    case STRING_ESC:
      p.state = c === 0x5c ? GROUND : ESC;
      return c === 0x5c ? DROP : BREAK;
  }
  if (c === 0x1b) p.state = ESC;
  else if (c === 0x9b) p.state = CSI;
  else if (c === 0x90 || c === 0x98 || c === 0x9d || c === 0x9e || c === 0x9f)
    Object.assign(p, { state: STRING, osc: c === 0x9d, body: pos + 1 });
  return control(c) ? DROP : TEXT;
}

/** Strip terminal sequences and redact credentials found in any reading over their raw spans. Output is
 * the same for every chunking; matching runs through the shared automaton, never per credential. */
export function terminalRedactor(current: () => CredentialMatcher = credentialMatcher) {
  let matcher = current();
  let views: View[] = [];
  let [size, pad, limit] = [0, 0, 0];
  // A discarded partial match: the published reading stays redacted until it could have completed.
  let taint: { start: number; left: number } | undefined;
  const reset = () => {
    taint = undefined;
    views = [A, B, C, D, E].map(() => ({ state: matcher.root, count: 0, ring: [] }));
    size = matcher.maxLength;
    pad = Math.max(0, size - 1);
    limit = size + TERMINAL_HOLD;
  };
  reset();
  const strict: Parser = { state: GROUND, osc: false, body: 0 };
  const lenient: Parser = { state: GROUND, osc: false, body: 0 };
  // marks: the readings keeping each held character; shown: whether the published reading keeps it.
  let [marks, shown] = [new Uint8Array(), new Uint8Array()];
  let [buf, out, entered] = ["", "", false];
  // Published output while it could still equal a whole short credential, which only matches whole.
  let lead: string | undefined = "";
  let [bufBase, base, end, head] = [0, 0, 0, 0];
  const spans: { start: number; end: number }[] = [];
  const addSpan = (start: number, stop: number) => {
    let k = spans.length;
    while (k > head && (spans[k - 1]?.start ?? 0) >= stop) k--;
    let j = k;
    while (j > head && (spans[j - 1]?.end ?? 0) > start) j--;
    start = Math.min(start, spans[j]?.start ?? start);
    stop = Math.max(stop, j < k ? (spans[k - 1]?.end ?? stop) : stop);
    spans.splice(j, k - j, { start, end: stop });
  };
  // After a forced release, only the unreleased part of a match remains to be replaced.
  const matchStart = (view: View, k: number, fallback: number) => {
    while (k < view.count && (view.ring[k % size] ?? fallback) < base) k++;
    return k < view.count ? (view.ring[k % size] ?? fallback) : fallback;
  };
  const settle = (view: View) => {
    const held = view.held;
    if (held === undefined) return;
    view.held = undefined;
    view.state = matcher.step(view.state, "\\");
    view.ring[view.count++ % size] = held;
    const output = view.state.output;
    if (output) addSpan(matchStart(view, view.count - output.depth, held), held + 1);
  };
  const feed = (mask: number, char: string, pos: number) => {
    if (!size) return;
    let from: MatchState | undefined;
    let to = matcher.root;
    for (let v = 0; v < 5; v++) {
      const view = views[v];
      if (!view || !(mask & (1 << v))) continue;
      const start = char === "/" ? (view.held ?? pos) : pos;
      if (char === "/") view.held = undefined;
      settle(view);
      if (char === "\\") {
        view.held = pos;
        continue;
      }
      // Readings that agree share one transition.
      if (view.state !== from) {
        from = view.state;
        to = matcher.step(from, char);
      }
      view.state = to;
      view.ring[view.count++ % size] = start;
      if (to.output) addSpan(matchStart(view, view.count - to.output.depth, pos), pos + 1);
    }
  };
  const spread = (mask: number, from: number, to: number) => {
    if (!taint || !(mask & C) || from >= to) return;
    const stop = Math.min(to, from + taint.left);
    taint.left -= stop - from;
    addSpan(taint.start, stop);
    if (!taint.left) taint = undefined;
  };
  // Plain text kept by every reading in `mask`: one scan once those readings agree.
  const bulk = (from: number, to: number, mask: number) => {
    spread(mask, from, to);
    marks.fill(mask, from - bufBase, to - bufBase);
    shown.fill(mask & C ? 1 : 0, from - bufBase, to - bufBase);
    if (!size) return;
    const active = views.filter((_, v) => mask & (1 << v));
    for (
      ;
      from < to && active.some((view) => view.state !== active[0]?.state || view.held !== undefined);
      from++
    )
      feed(mask, buf.charAt(from - bufBase), from);
    if (from === to) return;
    const scanned = matcher.scan(buf.slice(from - bufBase, to - bufBase), active[0]?.state, from);
    for (const { end: stop, node } of scanned.hits)
      if (node.output)
        for (const view of active) {
          const start = stop - node.output.depth;
          addSpan(start < from ? matchStart(view, view.count + start - from, from) : start, stop);
        }
    for (const view of active) {
      for (let pos = Math.max(from, to - scanned.state.depth); pos < to; pos++)
        view.ring[(view.count + pos - from) % size] = pos;
      view.count += to - from;
      view.state = scanned.state;
    }
  };
  const reveal = (from: number, to: number) => {
    for (let pos = from; pos < to; pos++) {
      if (control(buf.charCodeAt(pos - bufBase))) continue;
      marks[pos - bufBase] = (marks[pos - bufBase] ?? 0) | C | D | E;
      shown[pos - bufBase] = 1;
      feed(C | D | E, buf.charAt(pos - bufBase), pos);
      spread(C, pos, pos + 1);
    }
  };
  // At a new introducer, E keeps the longer partial match of D and E, and D restarts from C.
  const fork = (pos: number) => {
    const [plain, stray, earlier] = [views[2], views[3], views[4]];
    if (!plain || !stray || !earlier || !size) return;
    const [kept, restart] = stray.state.depth >= earlier.state.depth ? [stray, earlier] : [earlier, stray];
    // Kept and C both read C's text from here, so either continues the other's partial match if that is a
    // suffix of its own; a match then starts at the earlier position. Otherwise it is redacted conservatively.
    const absorb = (into: View) => {
      let node = into.state;
      while (node !== restart.state && node !== matcher.root) node = node.fail;
      for (let i = 1; node === restart.state && i <= node.depth; i++) {
        const k = (into.count - i) % size;
        into.ring[k] = Math.min(into.ring[k] ?? pos, restart.ring[(restart.count - i) % size] ?? pos);
      }
      return node === restart.state;
    };
    if (!absorb(kept) && !absorb(plain)) {
      const start = Math.min(
        matchStart(restart, restart.count - restart.state.depth, pos),
        taint?.start ?? pos,
      );
      // Shorter partial matches in the discarded reading may belong to longer variants.
      let left = taint?.left ?? 0;
      for (let node = restart.state; node !== matcher.root; node = node.fail)
        left = Math.max(left, node.rest);
      taint = { start, left };
      if (start < pos) addSpan(start, pos);
    }
    [views[3], views[4]] = [restart, kept];
    [restart.state, restart.count, restart.held] = [plain.state, plain.count, plain.held];
    // Later matches start within the current depth, so only those positions are copied.
    for (let k = plain.count - plain.state.depth; k < plain.count; k++)
      restart.ring[k % size] = plain.ring[k % size] ?? 0;
  };
  const emit = (cut: number) => {
    while (base < cut) {
      const span = spans[head];
      if (span && span.start <= base) {
        if (!entered) out += MARKER;
        base = Math.min(span.end, cut);
        entered = base < span.end;
        if (!entered) head++;
        continue;
      }
      const stop = Math.min(span?.start ?? cut, cut);
      for (let pos = base; pos < stop; ) {
        const hidden = shown.subarray(pos - bufBase, stop - bufBase).indexOf(0);
        const next = hidden < 0 ? stop : pos + hidden;
        out += buf.slice(pos - bufBase, next - bufBase);
        const visible = shown.subarray(next - bufBase, stop - bufBase).indexOf(1);
        pos = visible < 0 ? stop : next + visible;
      }
      base = stop;
    }
  };
  // Release what no reading can still extend; past the bound, hide pending prefixes and release anyway.
  const release = (stop: number) => {
    const string = lenient.state >= STRING ? lenient.body : stop;
    let safe = Math.min(stop - pad, string, taint?.start ?? stop);
    for (const view of views) {
      if (view.state.depth) safe = Math.min(safe, view.ring[(view.count - view.state.depth) % size] ?? 0);
      safe = Math.min(safe, view.held ?? safe);
    }
    // Only the per-character bound forces a release, so its position is independent of chunking.
    if (stop - safe <= limit || stop - base <= limit) return emit(Math.max(base, safe));
    for (const view of views) settle(view);
    let [from, to] = [Infinity, -1];
    for (const view of views)
      for (let k = view.count - view.state.depth; k < view.count; k++) {
        const pos = view.ring[k % size] ?? -1;
        if (pos >= base && pos < string) [from, to] = [Math.min(from, pos), Math.max(to, pos)];
      }
    if (to >= 0) addSpan(from, to + 1);
    emit(string);
  };
  const step = (pos: number) => {
    const c = buf.charCodeAt(pos - bufBase);
    let mask = control(c) ? 0 : A;
    let kind = advance(strict, c, pos, true);
    if (kind === BREAK) kind = advance(strict, c, pos, true);
    if (kind === TEXT) mask |= B;
    const prior = lenient.state;
    kind = advance(lenient, c, pos, false);
    if (kind === BREAK) {
      reveal(lenient.body, pos);
      kind = advance(lenient, c, pos, false);
    }
    if (kind === TEXT) mask |= C | D | E;
    else if (kind === BODY) mask |= D;
    // Forks follow any reveal, so replaying held text in position order repeats them exactly.
    if (
      (c === 0x1b || c === 0x9b || prior === STRING_ESC) &&
      (lenient.state === ESC || lenient.state === CSI)
    ) {
      mask |= FORK;
      fork(pos);
    }
    marks[pos - bufBase] = mask;
    shown[pos - bufBase] = mask & C ? 1 : 0;
    feed(mask, buf.charAt(pos - bufBase), pos);
    spread(mask, pos, pos + 1);
    if (pos + 1 - base > limit) release(pos + 1);
  };
  return {
    /** Backing storage between pushes: held raw text and its maps, pending spans and held whole-value
     * output. The view rings hold at most 5 × the longest variant. */
    get retained() {
      return {
        text: buf.length,
        maps: Math.max(marks.length, shown.length),
        spans: spans.length,
        output: lead?.length ?? 0,
      };
    },
    push(chunk: string, flush = false): string {
      const latest = current();
      if (latest !== matcher) {
        // Rematch decided held text, including terminal state, against the new registrations.
        matcher = latest;
        reset();
        for (let pos = base; pos < end; pos++) {
          const mask = marks[pos - bufBase] ?? 0;
          if (mask & FORK) fork(pos);
          feed(mask, buf.charAt(pos - bufBase), pos);
          spread(mask, pos, pos + 1);
        }
      }
      const grow = (array: Uint8Array) => {
        const next = new Uint8Array(array.length + chunk.length);
        next.set(array);
        return next;
      };
      [marks, shown, buf] = [grow(marks), grow(shown), buf + chunk];
      out = "";
      const total = bufBase + buf.length;
      const next = [-1, -1];
      while (end < total) {
        // Plain text inside a string is dropped (or, leniently, deferred) by that reading alone.
        const inString = lenient.state === STRING;
        if ((inString || lenient.state === GROUND) && (strict.state === GROUND || strict.state === STRING)) {
          const [i, stops] = inString ? [1, STOPS[1]] : [0, STOPS[0]];
          if (stops && (next[i] ?? end) < end) {
            stops.lastIndex = end - bufBase;
            next[i] = (stops.exec(buf)?.index ?? total - bufBase) + bufBase;
          }
          // No release or string bound falls due inside the block, so it matches per-character processing.
          const bound = inString ? lenient.body + TERMINAL_HOLD : total;
          const stop = Math.min(next[i] ?? end, base + limit, bound);
          if (stop > end) {
            bulk(end, stop, (strict.state === GROUND ? A | B : A) | (inString ? 0 : C | D | E));
            end = stop;
            continue;
          }
        }
        step(end++);
      }
      if (flush) {
        if (lenient.state >= STRING) reveal(lenient.body, end);
        strict.state = lenient.state = GROUND;
        for (const view of views) settle(view);
        emit(end);
        reset();
      } else release(end);
      spans.splice(0, head);
      head = 0;
      // Keep only the carry: joining copies it, where a slice would retain the whole chunk.
      [buf, marks, shown] = [
        [buf.slice(base - bufBase), ""].join(""),
        marks.slice(base - bufBase),
        shown.slice(base - bufBase),
      ];
      bufBase = base;
      if (lead !== undefined)
        [out, lead] =
          lead.length + out.length > matcher.maxLength ? [lead + out, undefined] : ["", lead + out];
      if (flush) [out, lead] = [lead !== undefined && matcher.has(lead) ? MARKER : (lead ?? out), ""];
      return out;
    },
  };
}
