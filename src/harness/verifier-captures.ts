import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { decodeHTMLStrict } from "entities";
import type { Store } from "../db/store.ts";
import { isInertMedia } from "../gates/media.ts";
import { assertProcessesStopped } from "../util/proc.ts";
import type { AgentEvent, AgentSpec } from "./types.ts";

const LIMIT = 5 * 1024 * 1024;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
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
export const forgetBrowserOutputs = (scratch: string) => outputs.delete(scratch);
/** Resolves a child through the recorded root's descriptor, so a swapped root pathname cannot redirect it. */
export const anchored = {
  open(rootFd: number, name: string): number {
    libc ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }).symbols;
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
      const checkRoot = (fd: number) =>
        requireCapture(
          [fs.lstatSync(root.path), fs.fstatSync(fd)].every((stat) => identity(stat) === root.identity) &&
            fs.realpathSync(root.path) === root.path,
          "escaped",
        );
      try {
        rootFd = fs.openSync(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
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
const payloads = /iVBORw0KGgo[\w+/=]*|screenshot-\d+-\d+\.png|\/screenshots\/\S*/.source;
const unit = /\\+([!-/:-@[-`{-~])|(?:%[\da-f]{2})+|&#?\w{1,32};|[\s\S]/gi;
const utf8 = (percent: string) => Buffer.from(percent.replaceAll("%", ""), "hex").toString();
/** One linear scan decodes Markdown escapes, percent-encoding and character references, keeping source spans. */
const decode = (value: string, spans: number[][] = []) => ({
  plain: value.replace(unit, (raw: string, punct: string | undefined, at: number) => {
    const char = punct ?? (raw[0] === "%" ? utf8(raw) : decodeHTMLStrict(raw));
    spans.push(...Array(char.length).fill([at, at + raw.length]));
    return char;
  }),
  spans,
});
/** Holds browser verifier events until every screenshot locator is known, then sanitizes them. */
export function screenshotPrivacy() {
  const [locators, calls] = [new Set<string>(), new Set<string>()];
  const [held, logs] = [[] as AgentEvent[], [] as string[]];
  const remember = (path: string, filename = true) => {
    for (const locator of [path, filename ? basename(path) : ""]) if (locator) locators.add(locator);
  };
  const escapes = (locator: string) =>
    [1, 2, 3].reduce((all) => [...all, JSON.stringify(all.at(-1)).slice(1, -1)], [locator]);
  const text = (value: string, parse = true): string => {
    const { plain, spans } = decode(value);
    // Filenames are literal: match them both as written and as decoded, so encoded spellings of either still match.
    const keys = [...locators]
      .flatMap(escapes)
      .flatMap((locator) => [locator, decode(locator).plain])
      .map((locator) => RegExp.escape(locator));
    const matcher = new RegExp([payloads, ...keys.sort((a, b) => b.length - a.length)].join("|"), "g");
    let [safe, end] = ["", 0];
    for (const m of plain.matchAll(matcher)) {
      safe += `${value.slice(end, spans[m.index]?.[0])}[screenshot]`;
      end = spans[m.index + m[0].length - 1]?.[1] ?? value.length;
    }
    safe += value.slice(end);
    if (safe === "[screenshot]") return safe;
    try {
      if (parse && /^\s*[[{"]/.test(value)) return JSON.stringify(data(JSON.parse(value)));
    } catch {}
    return safe;
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
  const hold = (ev: AgentEvent) => {
    if (ev.type === "tool_call" && ev.name.endsWith("browser_take_screenshot")) {
      calls.add(ev.id);
      JSON.stringify(ev.input, (key, v: unknown) => {
        if ((key === "filename" || key === "path") && typeof v === "string") remember(v);
        return v;
      });
      held.push({ ...ev, input: {} });
    } else held.push(ev.type === "tool_result" && calls.has(ev.id) ? { ...ev, output: "[screenshot]" } : ev);
  };
  const holdTranscript = (line: string) => logs.push(line);
  const publicLine = (line: string) =>
    !line.includes("browser_take_screenshot") && ![...calls].some((id) => line.includes(JSON.stringify(id)));
  const logLine = (line: string) =>
    `${line.startsWith("[stderr] ") ? `[stderr] ${text(line.slice(9))}` : text(line)}\n`;
  const drainLogs = () => logs.splice(0).filter(publicLine).map(logLine).join("");
  return { remember, data, hold, holdTranscript, drainLogs, drain: () => held.splice(0).map(data) };
}
