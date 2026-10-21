import { type CredentialMatcher, credentialMatcher, type MatchState } from "./credential-matcher.ts";

/** Fixed allowance, in string-index units: terminal strings longer than this end as malformed text, and
 * held raw text never exceeds the longest credential variant plus this allowance plus one. */
export const TERMINAL_HOLD = 4_096;
const MARKER = "[redacted]";
// Each credential is matched in four readings of the raw text: A drops only control bytes; B strips
// strictly (ECMA-48: strings run until their terminator); C strips leniently and is what is published
// (a line break, another escape or the hold ends a string as visible text); D is C that also keeps the
// final byte of a bare introducer (ESC x, ESC [ x), so a stray introducer never consumes a credential.
const [A, B, C, D] = [1, 2, 4, 8];
const [GROUND, ESC, ESC_INTER, CSI, CSI_PARAMS, STRING, STRING_ESC] = [0, 1, 2, 3, 4, 5, 6];
const [TEXT, DROP, BARE, BREAK] = [0, 1, 2, 3];
type Parser = { state: number; osc: boolean; body: number };
type View = { state: MatchState; count: number; ring: number[] };

// Bulk processing stops at controls, and inside a lenient string also at line breaks.
const STOPS = ["", "\\n\\r"].map(
  (breaks) =>
    new RegExp(`[${["\\0-\\x08", "\\x0b\\x0c", "\\x0e-\\x1f", "\\x7f-\\x9f", breaks].join("")}]`, "g"),
);
const control = (c: number) => (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f);
/** Classify one character; BREAK ends a malformed string before it, and the caller rereads it. */
function advance(p: Parser, c: number, pos: number, strict: boolean): number {
  switch (p.state) {
    case ESC:
      if (c === 0x5b) p.state = CSI;
      else if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f)
        Object.assign(p, { state: STRING, osc: c === 0x5d, body: pos });
      else if (c >= 0x20 && c <= 0x2f) p.state = ESC_INTER;
      else {
        p.state = GROUND;
        if (c >= 0x30 && c <= 0x7e) return BARE;
        break;
      }
      return DROP;
    case ESC_INTER:
    case CSI:
    case CSI_PARAMS:
      if (c >= 0x20 && (c <= 0x2f || (p.state !== ESC_INTER && c <= 0x3f))) {
        if (p.state === CSI) p.state = CSI_PARAMS;
        return DROP;
      }
      if (c >= (p.state === ESC_INTER ? 0x30 : 0x40) && c <= 0x7e) {
        const bare = p.state === CSI;
        p.state = GROUND;
        return bare ? BARE : DROP;
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
  const reset = () => {
    views = [A, B, C, D].map(() => ({ state: matcher.root, count: 0, ring: [] }));
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
  const feed = (mask: number, char: string, pos: number) => {
    if (!size) return;
    let from: MatchState | undefined;
    let to = matcher.root;
    for (let v = 0; v < 4; v++) {
      const view = views[v];
      if (!view || !(mask & (1 << v))) continue;
      // Readings that agree share one transition.
      if (view.state !== from) {
        from = view.state;
        to = matcher.step(from, char);
      }
      view.state = to;
      view.ring[view.count++ % size] = pos;
      if (to.output) addSpan(matchStart(view, view.count - to.output.depth, pos), pos + 1);
    }
  };
  // Plain text kept by every reading in `mask`: one scan once those readings agree.
  const bulk = (from: number, to: number, mask: number) => {
    marks.fill(mask, from - bufBase, to - bufBase);
    shown.fill(mask & C ? 1 : 0, from - bufBase, to - bufBase);
    if (!size) return;
    const active = views.filter((_, v) => mask & (1 << v));
    for (; from < to && active.some((view) => view.state !== active[0]?.state); from++)
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
      for (let pos = Math.max(from, to - size); pos < to; pos++)
        view.ring[(view.count + pos - from) % size] = pos;
      view.count += to - from;
      view.state = scanned.state;
    }
  };
  const reveal = (from: number, to: number) => {
    for (let pos = from; pos < to; pos++) {
      if (control(buf.charCodeAt(pos - bufBase))) continue;
      marks[pos - bufBase] = (marks[pos - bufBase] ?? 0) | C | D;
      shown[pos - bufBase] = 1;
      feed(C | D, buf.charAt(pos - bufBase), pos);
    }
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
    let safe = Math.min(stop - pad, string);
    for (const view of views)
      if (view.state.depth) safe = Math.min(safe, view.ring[(view.count - view.state.depth) % size] ?? 0);
    // Only the per-character bound forces a release, so its position is independent of chunking.
    if (stop - safe <= limit || stop - base <= limit) return emit(Math.max(base, safe));
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
    kind = advance(lenient, c, pos, false);
    if (kind === BREAK) {
      reveal(lenient.body, pos);
      kind = advance(lenient, c, pos, false);
    }
    if (kind === TEXT) mask |= C | D;
    else if (kind === BARE) mask |= D;
    marks[pos - bufBase] = mask;
    shown[pos - bufBase] = mask & C ? 1 : 0;
    feed(mask, buf.charAt(pos - bufBase), pos);
    if (pos + 1 - base > limit) release(pos + 1);
  };
  return {
    /** Held raw characters and pending spans; the view rings hold at most 4 × the longest variant. */
    get retained() {
      return { text: end - base, spans: spans.length - head };
    },
    push(chunk: string, flush = false): string {
      const latest = current();
      if (latest !== matcher) {
        // Rematch decided held text, including terminal state, against the new registrations.
        matcher = latest;
        reset();
        for (let pos = base; pos < end; pos++)
          feed(marks[pos - bufBase] ?? 0, buf.charAt(pos - bufBase), pos);
      }
      const held = [marks, shown].map((array) => {
        const next = new Uint8Array(end - base + chunk.length);
        next.set(array.subarray(base - bufBase, end - bufBase));
        return next;
      });
      [marks = new Uint8Array(), shown = new Uint8Array()] = held;
      buf = buf.slice(base - bufBase) + chunk;
      bufBase = base;
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
            bulk(end, stop, (strict.state === GROUND ? A | B : A) | (inString ? 0 : C | D));
            end = stop;
            continue;
          }
        }
        step(end++);
      }
      if (flush) {
        if (lenient.state >= STRING) reveal(lenient.body, end);
        strict.state = lenient.state = GROUND;
        emit(end);
        reset();
      } else release(end);
      spans.splice(0, head);
      head = 0;
      return out;
    },
  };
}
