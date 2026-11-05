import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
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
export function collectVerifierCaptures(
  scratch: string,
  store: Store,
  runId: string,
  invocationId: number,
  onEvent: AgentSpec["onEvent"],
  privacy?: ReturnType<typeof screenshotPrivacy>,
): void {
  const record = outputs.get(scratch);
  if (!record) return;
  // Held verifier events learn every trusted root even when collection itself cannot run.
  for (const root of record.roots) privacy?.remember(root.path, false);
  assertProcessesStopped();
  const saved = new Set(store.listArtifacts(runId).flatMap((a) => (a.kind === "screenshot" ? [a.name] : [])));
  const rejected: Record<string, number> = {};
  const reject = (code: string) => (rejected[code] = (rejected[code] ?? 0) + 1);
  let index = 0;
  for (const root of record.roots) {
    const checkRoot = () => {
      const stat = fs.lstatSync(root.path);
      requireCapture(
        stat.isDirectory() && identity(stat) === root.identity && fs.realpathSync(root.path) === root.path,
        "escaped",
      );
    };
    try {
      checkRoot();
      const entries = fs
        .readdirSync(root.path)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const entry of entries) {
        let fd: number | undefined;
        try {
          const path = join(root.path, entry);
          privacy?.remember(path);
          checkRoot();
          fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          const stat = fs.fstatSync(fd);
          requireCapture(stat.isFile(), "not-regular");
          requireCapture(stat.nlink === 1, "multiply-linked");
          requireCapture(stat.size <= LIMIT, "too-large");
          checkRoot();
          const same = identity(fs.lstatSync(path)) === identity(stat);
          requireCapture(same && dirname(fs.realpathSync(path)) === root.path, "escaped");
          const bytes = Buffer.alloc(LIMIT + 1);
          let size = 0,
            read = 0;
          do {
            read = fs.readSync(fd, bytes, size, bytes.length - size, null);
            size += read;
          } while (read && size < bytes.length);
          requireCapture(size <= LIMIT, "too-large");
          const png = bytes.subarray(0, size);
          requireCapture(isInertMedia("x.png", png), "invalid-png");
          const name = `screenshot-${invocationId}-${index++}.png`;
          requireCapture(saved.has(name) || saved.size < 8, "over-limit");
          store.putArtifact(runId, name, "screenshot", png.toString("base64"));
          saved.add(name);
        } catch (error) {
          reject(error instanceof RejectedCapture ? error.message : "unsafe-or-unreadable");
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    } catch {
      reject("escaped-or-unreadable-root");
    }
  }
  if (!record.diagnosed && Object.keys(rejected).length) {
    record.diagnosed = true;
    onEvent({ type: "status", text: `Screenshot collection rejected: ${JSON.stringify(rejected)}` });
  }
}
/** Holds browser verifier events until every screenshot locator is known, then sanitizes them. */
export function screenshotPrivacy() {
  const locators = new Set<string>(),
    calls = new Set<string>(),
    held: AgentEvent[] = [];
  const remember = (path: string, filename = true) => {
    for (const locator of [path, filename ? basename(path) : ""]) if (locator) locators.add(locator);
  };
  // Serialized tool results carry locators JSON-escaped, possibly nested: sanitize decoded strings too.
  const escapes = (locator: string) =>
    [1, 2, 3].reduce((all) => [...all, JSON.stringify(all.at(-1)).slice(1, -1)], [locator]);
  const text = (value: string): string => {
    try {
      if (/^\s*[[{"]/.test(value)) return JSON.stringify(data(JSON.parse(value)));
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
      JSON.stringify(value, (key, v: unknown) =>
        typeof v === "string" && !literal.test(`${key}:${v}`)
          ? text(v)
          : key === "covering_tests" && Array.isArray(v)
            ? v.filter((test) => JSON.stringify(test) === JSON.stringify(data(test)))
            : v,
      ),
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
  return { remember, data, hold, drain: () => held.splice(0).map(data) };
}
