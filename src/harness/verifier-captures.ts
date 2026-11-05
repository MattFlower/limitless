import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import type { Store } from "../db/store.ts";
import { isInertMedia } from "../gates/media.ts";
import { assertProcessesStopped } from "../util/proc.ts";
import type { AgentEvent, AgentSpec } from "./types.ts";

const LIMIT = 5 * 1024 * 1024;
class RejectedCapture extends Error {}
const requireCapture = (ok: boolean, code: string) => {
  if (!ok) throw new RejectedCapture(code);
};
const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;
const outputs = new Map<string, { roots: { path: string; identity: string }[]; diagnosed: boolean }>();
/** Only browser setup may register collection roots; model replies never supply paths. */
export function registerBrowserOutput(scratch: string, path: string): void {
  const record = outputs.get(scratch) ?? { roots: [], diagnosed: false };
  record.roots.push({ path, identity: identity(fs.lstatSync(path)) });
  outputs.set(scratch, record);
}
export function forgetBrowserOutputs(scratch: string): void {
  outputs.delete(scratch);
}
/** Resolves a child through the recorded root's descriptor, so a swapped root pathname cannot redirect it. */
export const anchored = {
  open(rootFd: number, name: string): number {
    libc ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }).symbols;
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    const cloexec = process.platform === "darwin" ? 0x1000000 : 0o2000000;
    const fd = libc.openat(
      rootFd,
      ptr(Buffer.from(`${name}\0`)),
      O_RDONLY | O_NOFOLLOW | O_NONBLOCK | cloexec,
    );
    requireCapture(fd >= 0, "unsafe-or-unreadable");
    return fd;
  },
};
let libc: { openat: (...args: [number, Pointer, number]) => number } | undefined;
export function collectVerifierCaptures(
  store: Store,
  runId: string,
  invocationId: number,
  onEvent: AgentSpec["onEvent"],
  privacy?: ReturnType<typeof screenshotPrivacy>,
) {
  return (scratch: string): void => {
    const record = outputs.get(scratch);
    if (!record) return;
    for (const root of record.roots) privacy?.remember(root.path, false);
    assertProcessesStopped();
    const saved = new Set(store.listScreenshots(runId).map((a) => a.name));
    const rejected: Record<string, number> = {};
    const reject = (code: string) => (rejected[code] = (rejected[code] ?? 0) + 1);
    let index = 0;
    for (const root of record.roots) {
      let rootFd: number | undefined;
      const checkRoot = (fd: number) => {
        requireCapture(
          identity(fs.lstatSync(root.path)) === root.identity &&
            identity(fs.fstatSync(fd)) === root.identity &&
            fs.realpathSync(root.path) === root.path,
          "escaped",
        );
      };
      try {
        const flags = fs.constants;
        rootFd = fs.openSync(root.path, flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW);
        checkRoot(rootFd);
        const names = fs.readdirSync(root.path);
        for (const name of names) privacy?.remember(join(root.path, name));
        const entries = names
          .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .map((name) => ({ name, id: identity(fs.lstatSync(join(root.path, name))) }));
        for (const entry of entries) {
          let fd: number | undefined;
          try {
            fd = anchored.open(rootFd, entry.name);
            const stat = fs.fstatSync(fd);
            requireCapture(identity(stat) === entry.id, "escaped");
            requireCapture(stat.isFile(), "not-regular");
            requireCapture(stat.nlink === 1, "multiply-linked");
            requireCapture(stat.size <= LIMIT, "too-large");
            checkRoot(rootFd);
            const bytes = Buffer.alloc(LIMIT + 1);
            let size = 0;
            for (let read = 1; read && size < bytes.length; size += read)
              read = fs.readSync(fd, bytes, size, bytes.length - size, null);
            requireCapture(size <= LIMIT, "too-large");
            const png = bytes.subarray(0, size);
            requireCapture(isInertMedia("x.png", png), "invalid-png");
            const name = `screenshot-${invocationId}-${index++}.png`;
            requireCapture(saved.has(name) || saved.size < 8, "over-limit");
            store.putScreenshot(runId, name, png.toString("base64"));
            saved.add(name);
          } catch (error) {
            reject(error instanceof RejectedCapture ? error.message : "unsafe-or-unreadable");
          } finally {
            if (fd !== undefined) fs.closeSync(fd);
          }
        }
      } catch {
        reject("escaped-or-unreadable-root");
      } finally {
        if (rootFd !== undefined) fs.closeSync(rootFd);
      }
    }
    if (!record.diagnosed && Object.keys(rejected).length) {
      record.diagnosed = true;
      onEvent({ type: "status", text: `Screenshot collection rejected: ${JSON.stringify(rejected)}` });
    }
  };
}
/** Holds browser verifier events until every screenshot locator is known, then sanitizes them. */
export function screenshotPrivacy() {
  const locators = new Set<string>(),
    calls = new Set<string>(),
    held: AgentEvent[] = [];
  const remember = (path: string, filename = true) => {
    for (const locator of [path, filename ? basename(path) : ""]) if (locator) locators.add(locator);
  };
  const escapes = (locator: string) =>
    [1, 2, 3].reduce((all) => [...all, JSON.stringify(all.at(-1)).slice(1, -1)], [locator]);
  const text = (value: string, parse = true): string => {
    if (locators.has(value)) return "[screenshot]";
    try {
      if (parse && /^\s*[[{"]/.test(value)) return JSON.stringify(data(JSON.parse(value)));
    } catch {}
    return [...locators]
      .flatMap(escapes)
      .sort((a, b) => b.length - a.length)
      .reduce(
        (safe, locator) => safe.replaceAll(locator, "[screenshot]"),
        value.replace(/iVBORw0KGgo[\w+/=]*|screenshot-\d+-\d+\.png|\/screenshots\/\S*/g, "[screenshot]"),
      );
  };
  // Only enum literals keep their fields verbatim; locator-bearing covering tests are withheld, not rewritten.
  const literal =
    /^(type|code|status|overall|blockedReason|requirement|failureClass):(met|unmet|unclear|blocked|pass|fail|sandbox|environment|request|spec|not_required|ok|error|cancelled|timeout|stuck|quota|unavailable|declined|running|authentication|malformed|browser_unavailable|init|text|thinking|tool_call|tool_result|rate_limit|stderr|status|warning)$/;
  const data = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (key, v: unknown) => {
        if (typeof v === "string") return literal.test(`${key}:${v}`) ? v : text(v);
        if (key === "covering_tests" && Array.isArray(v))
          return v.filter((item) => JSON.stringify(item) === JSON.stringify(data(item)));
        if (!v || typeof v !== "object" || Array.isArray(v)) return v;
        const entries = Object.entries(v).map(([k, item]) => ({ k, safe: text(k, false), item }));
        return Object.fromEntries(
          entries
            .filter((e) => e.k === e.safe || entries.filter((o) => o.safe === e.safe).length === 1)
            .map(({ safe, item }) => [safe, item]),
        );
      }),
    );
  const hold = (value: AgentEvent) => {
    if (value.type === "tool_call" && value.name.endsWith("browser_take_screenshot")) {
      calls.add(value.id);
      JSON.stringify(value.input, (key, v: unknown) => {
        if ((key === "filename" || key === "path") && typeof v === "string") remember(v);
        return v;
      });
      held.push({ ...value, input: {} });
    } else if (value.type === "tool_result" && calls.has(value.id))
      held.push({ ...value, output: "[screenshot]" });
    else held.push(value);
  };
  const logs: string[] = [];
  const drainLogs = () => {
    const privateLine = (line: string) =>
      line.includes("browser_take_screenshot") || [...calls].some((id) => line.includes(JSON.stringify(id)));
    return logs
      .splice(0)
      .filter((line) => !privateLine(line))
      .map((line) => `${line.startsWith("[stderr] ") ? `[stderr] ${text(line.slice(9))}` : text(line)}\n`)
      .join("");
  };
  return {
    remember,
    data,
    hold,
    holdTranscript: (line: string) => logs.push(line),
    drainLogs,
    drain: () => held.splice(0).map(data),
  };
}
