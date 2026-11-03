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
const settle = (f: Fn) =>
  function (this: unknown, ...a: unknown[]) {
    const [p, back] = [f.apply(this, a), (v: unknown) => resume(() => v)];
    return p instanceof Promise ? p.then(back, (e) => back(Promise.reject(e))) : p;
  };
export function trackResumptions() {
  const undo: (() => void)[] = [];
  const patch = (o: object, wrap: (f: Fn) => Fn, keys: string[]) => {
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
  patch(require("node:fs/promises"), settle, Object.keys(require("node:fs/promises")));
  patch(Bun, settle, ["sleep"]);
  patch(Blob.prototype, settle, ["text", "arrayBuffer", "json", "bytes"]);
  patch(require("node:events").EventEmitter.prototype, dispatch, ["emit"]);
  return () => undo.reverse().forEach((f) => void f());
}
if (process.argv[2] === "--worker" && Bun.main.endsWith("/benchmark-gate-output.ts")) trackResumptions();
