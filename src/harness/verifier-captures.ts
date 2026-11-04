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
  const saved = new Set(
    store
      .listArtifacts(runId)
      .filter((a) => a.kind === "screenshot")
      .map((a) => a.name),
  );
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
  const text = (value: string) =>
    [...locators]
      .sort((a, b) => b.length - a.length)
      .reduce(
        (safe, locator) => safe.replaceAll(locator, "[screenshot]"),
        value.replace(/iVBORw0KGgo[\w+/=]*|screenshot-\d+-\d+\.png|\/screenshots\/\S*/g, "[screenshot]"),
      );
  // Exact identifiers (statuses, criterion ids, covering-test files and titles) are never rewritten.
  const exact = /^(type|code|id|name|file|status|overall|blockedReason|requirement|failureClass)$/;
  const data = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (key, v: unknown) => (typeof v === "string" && !exact.test(key) ? text(v) : v)),
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
