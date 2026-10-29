// Failure links retain only the longest output; shorter suffixes are resolved lazily.
class Node {
  next = new Map<string, Node>();
  fail: Node = this;
  rank = -1;
  output?: Node;
  all?: Node;
  jump: Node[] = [];
  // Characters still needed to complete the longest variant through this prefix.
  rest = 0;
  constructor(readonly depth = 0) {}
}
export type MatchState = Node;
type Hit = { end: number; node: Node };
type Match = Hit;
type RedactionWindow = { start: number; end: number };
export type MatchingWork = { transitions: number; outputs: number; boundaries: number };

export class CredentialMatcher {
  readonly root: Node;
  readonly maxLength: number;
  constructor(private variants: ReadonlyMap<string, boolean>) {
    this.root = new Node();
    this.maxLength = 0;
    let rank = 0;
    for (const [text, substring] of variants) {
      this.maxLength = Math.max(this.maxLength, text.length);
      let node = this.root;
      for (const char of text.split("")) {
        node.rest = Math.max(node.rest, text.length - node.depth);
        let next = node.next.get(char);
        if (!next) {
          next = new Node(node.depth + 1);
          next.fail = this.root;
          node.next.set(char, next);
        }
        node = next;
      }
      node.all = node;
      if (substring) {
        node.output = node;
        node.rank = rank;
      }
      rank++;
    }
    const queue = [...this.root.next.values()];
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      if (!node) continue;
      node.all ??= node.fail.all;
      const suffix = node.fail.output;
      node.output ??= suffix;
      // Binary lifting skips all suffix outputs too long for an unoccupied span.
      if (node.output === node && suffix) {
        node.jump.push(suffix);
        for (let j = 0; ; j++) {
          const ancestor = node.jump[j]?.jump[j];
          if (!ancestor) break;
          node.jump.push(ancestor);
        }
      }
      for (const [char, child] of node.next) {
        let fail = node.fail;
        while (fail !== this.root && !fail.next.has(char)) fail = fail.fail;
        child.fail = fail.next.get(char) ?? this.root;
        queue.push(child);
      }
    }
  }
  scan(text: string, state = this.root, offset = 0, work?: MatchingWork) {
    const hits: Hit[] = [];
    if (!this.maxLength) return { state, hits };
    for (let i = 0; i < text.length; i++) {
      const char = text.charAt(i);
      while (true) {
        if (work) work.transitions++;
        const next = state.next.get(char);
        if (next || state === this.root) {
          state = next ?? this.root;
          break;
        }
        state = state.fail;
      }
      if (work) work.outputs++;
      if (state.all) hits.push({ end: offset + i + 1, node: state });
    }
    return { state, hits };
  }
  step(state: Node, char: string): Node {
    for (;;) {
      const next = state.next.get(char);
      if (next || state === this.root) return next ?? this.root;
      state = state.fail;
    }
  }
  has(text: string): boolean {
    return this.variants.has(text);
  }
  redact(text: string, work?: MatchingWork, window?: RedactionWindow): string {
    if (!this.maxLength || !text) return render(text, [], window);
    return this.replace(text, this.scan(text, undefined, 0, work).hits, 0, work, window);
  }
  private replace(
    text: string,
    hits: Hit[],
    offset: number,
    work?: MatchingWork,
    window?: RedactionWindow,
  ): string {
    if (this.variants.has(text)) return render(text, [{ start: 0, end: text.length }], window);
    if (!hits.some((hit) => hit.node.output)) return render(text, [], window);
    const heap: Match[] = [];
    const better = (a: Match, b: Match) => {
      if (work) work.outputs++;
      return (
        a.node.depth > b.node.depth ||
        (a.node.depth === b.node.depth &&
          (a.node.rank < b.node.rank || (a.node.rank === b.node.rank && a.end < b.end)))
      );
    };
    const push = (match: Match) => {
      let i = heap.length;
      heap.push(match);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        const above = heap[parent];
        if (!above || !better(match, above)) break;
        heap[i] = above;
        i = parent;
      }
      heap[i] = match;
    };
    const pop = () => {
      const first = heap[0];
      const last = heap.pop();
      if (last && heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          const right = heap[child + 1];
          const left = heap[child];
          if (right && left && better(right, left)) child++;
          const below = heap[child];
          if (!below || !better(below, last)) break;
          heap[i] = below;
          i = child;
        }
        heap[i] = last;
      }
      return first;
    };
    for (const { end, node } of hits) {
      if (work) work.outputs++;
      if (node.output) push({ end: end - offset, node: node.output });
    }
    // Prefix maxima locate the last occupied span. Each rejected candidate jumps over
    // every suffix that cannot fit, rather than enumerating dictionary outputs.
    // Each further rejection at an endpoint halves its available span: a blocker
    // must fit that span and have at least the rejected candidate's length.
    const occupied = new Int32Array(text.length + 1);
    const selected: Match[] = [];
    for (let match = pop(); match; match = pop()) {
      if (work) work.outputs++;
      let blocked = 0;
      for (let i = match.end; i > 0; i -= i & -i) {
        if (work) work.outputs++;
        blocked = Math.max(blocked, occupied[i] ?? 0);
      }
      const limit = match.end - blocked;
      let node = match.node;
      if (node.depth > limit) {
        for (let j = node.jump.length - 1; j >= 0; j--) {
          if (work) work.outputs++;
          const ancestor = node.jump[j];
          if (ancestor && ancestor.depth > limit) node = ancestor;
        }
        if (work) work.outputs++;
        const suffix = node.jump[0];
        if (suffix) push({ end: match.end, node: suffix });
        continue;
      }
      selected.push(match);
      for (let i = match.end - node.depth + 1; i < occupied.length; i += i & -i) {
        if (work) work.outputs++;
        occupied[i] = Math.max(occupied[i] ?? 0, match.end);
      }
    }
    selected.sort((a, b) => a.end - b.end);
    return render(
      text,
      selected.map(({ end, node }) => ({ start: end - node.depth, end })),
      window,
    );
  }
  stream(work?: MatchingWork) {
    let pending = "";
    let offset = 0;
    let state = this.root;
    let hits: Hit[] = [];
    let components: { start: number; end: number }[] = [];
    return {
      get pending() {
        return pending;
      },
      push: (chunk: string, flush = false): string => {
        const scanned = this.scan(chunk, state, offset + pending.length, work);
        pending += chunk;
        state = scanned.state;
        for (const hit of scanned.hits) {
          if (work) work.boundaries++;
          hits.push(hit);
          let start = hit.end - (hit.node.all?.depth ?? 0);
          // Union overlapping matches once; suffix outputs are contained in the longest.
          while (components.length) {
            if (work) work.boundaries++;
            const last = components[components.length - 1];
            if (!last || last.end <= start) break;
            start = Math.min(start, last.start);
            components.pop();
          }
          components.push({ start, end: hit.end });
        }
        let cut = flush ? pending.length : Math.max(0, pending.length - Math.max(0, this.maxLength - 1));
        if (!flush) {
          let lo = 0;
          let hi = components.length;
          while (lo < hi) {
            if (work) work.boundaries++;
            const mid = (lo + hi) >>> 1;
            if ((components[mid]?.end ?? 0) <= offset + cut) lo = mid + 1;
            else hi = mid;
          }
          cut = Math.min(cut, (components[lo]?.start ?? offset + cut) - offset);
        }
        if (!cut && !flush) return "";
        let count = 0;
        while (count < hits.length && (hits[count]?.end ?? Infinity) <= offset + cut) {
          if (work) work.boundaries++;
          count++;
        }
        const result = this.replace(pending.slice(0, cut), hits.slice(0, count), offset, work);
        if (count) hits = hits.slice(count);
        let consumed = 0;
        while (consumed < components.length && (components[consumed]?.end ?? Infinity) <= offset + cut) {
          if (work) work.boundaries++;
          consumed++;
        }
        if (consumed) components = components.slice(consumed);
        pending = pending.slice(cut);
        offset += cut;
        return result;
      },
    };
  }
}

function render(text: string, spans: RedactionWindow[], window?: RedactionWindow): string {
  const bounds = window ? { ...window } : undefined;
  const marker = "[redacted]";
  const pieces: string[] = [];
  let cursor = 0;
  for (const { start, end } of spans) {
    pieces.push(text.slice(cursor, start), marker);
    cursor = end;
    // Map the original cuts through each replacement, retaining any intersected marker whole.
    if (bounds && window) {
      if (start < window.start)
        bounds.start += end <= window.start ? marker.length - (end - start) : start - window.start;
      if (start < window.end)
        bounds.end += end <= window.end ? marker.length - (end - start) : start + marker.length - window.end;
    }
  }
  const result = pieces.length ? pieces.join("") + text.slice(cursor) : text;
  return bounds ? result.slice(bounds.start, bounds.end) : result;
}

/** The original length controls substring eligibility, including shortened CRLF variants. */
export function credentialVariants(credentials: readonly string[]): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const secret of credentials.filter(Boolean)) {
    const values = [secret, secret.replace(/\r\n/g, "\n")];
    for (const value of values) {
      const json = JSON.stringify(value).slice(1, -1);
      for (const variant of value.includes("/") ? [value, json, json.replaceAll("/", "\\/")] : [value, json])
        result.set(variant, result.get(variant) === true || secret.length >= 8);
    }
  }
  return result;
}

const variants = new Map<string, boolean>();
let compiled: CredentialMatcher | undefined;
export function registerCredentialVariant(text: string, substring: boolean): void {
  if (variants.has(text) && (!substring || variants.get(text))) return;
  variants.set(text, substring);
  compiled = undefined;
}
export const credentialMatcher = (): CredentialMatcher =>
  (compiled ??= new CredentialMatcher(new Map(variants)));
