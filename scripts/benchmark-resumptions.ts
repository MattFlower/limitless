/** Preloaded by producer workers before any module loads: scheduling and I/O that revision code imports or captures
 * resumes through `resumptions.own`, owned before its continuation runs, whatever its CPU use. Rest: idle. */
type Fn = (...args: unknown[]) => unknown;
type Own = <T>(phase: string, fn: () => T) => T;
export const resumptions = { setImmediate } as { own?: Own; setImmediate: typeof setImmediate };
const resume = (f: () => unknown) => (resumptions.own ? resumptions.own("resumed", f) : f());
const dispatch = (f: Fn) =>
  function (this: unknown, ...a: unknown[]) {
    return resume(() => f.apply(this, a));
  };
const later = (f: Fn) =>
  function (this: unknown, cb: unknown, ...a: unknown[]) {
    return f.call(this, typeof cb === "function" ? dispatch(cb as Fn) : cb, ...a);
  };
const settle = (f: Fn, map = (v: unknown) => v) =>
  function (this: unknown, ...a: unknown[]) {
    const [p, back] = [f.apply(this, a), (v: unknown) => resume(() => map(v))];
    return p instanceof Promise ? p.then(back, (e) => resume(() => Promise.reject(e))) : p;
  };
export function trackResumptions() {
  const undo: (() => void)[] = [];
  let active = true;
  const handles = new WeakSet<object>();
  const patch = (o: object, wrap: (f: Fn) => Fn, keys: PropertyKey[]) => {
    for (const k of keys.filter((k) => typeof Reflect.get(o, k) === "function")) {
      const [f, g] = [Reflect.get(o, k), wrap(Reflect.get(o, k))];
      for (const p of Reflect.ownKeys(f).filter((p) => p !== "prototype"))
        Object.defineProperty(g, p, Reflect.getOwnPropertyDescriptor(f, p) ?? {});
      undo.push(() => Reflect.set(o, k, f));
      Reflect.set(o, k, g);
    }
  };
  for (const o of [globalThis, require("node:timers")])
    patch(o, later, ["setTimeout", "setInterval", "setImmediate"]);
  patch(require("node:timers/promises"), settle, ["setTimeout", "setImmediate"]);
  const opened = (h: unknown) => {
    // Hook both instance methods (close on Node) and the shared FileHandle prototype before returning it.
    for (const o of [h as object, Object.getPrototypeOf(h)]) {
      if (!active || handles.has(o)) continue;
      handles.add(o);
      const keys = Reflect.ownKeys(o).filter((k) => k !== "constructor");
      patch(o, settle, keys);
    }
    return h;
  };
  const io = require("node:fs/promises");
  patch(io, (f) => settle(f, f === io.open ? opened : undefined), Object.keys(io));
  patch(Bun, settle, ["sleep"]);
  patch(Blob.prototype, settle, ["text", "arrayBuffer", "json", "bytes"]);
  patch(require("node:events").EventEmitter.prototype, dispatch, ["emit"]);
  return () => {
    active = false;
    undo.reverse().forEach((f) => void f());
  };
}
if (process.argv[2] === "--worker" && Bun.main.endsWith("/benchmark-gate-output.ts")) trackResumptions();
