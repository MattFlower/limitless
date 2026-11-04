import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Store } from "../db/store.ts";
import { isInertMedia } from "../gates/media.ts";
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
      privacy?.remember(root.path, false);
      const entries = fs
        .readdirSync(root.path)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const entry of entries) {
        let fd: number | undefined;
        try {
          checkRoot();
          const path = join(root.path, entry);
          privacy?.remember(path);
          fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          const stat = fs.fstatSync(fd);
          requireCapture(stat.isFile(), "not-regular");
          requireCapture(stat.nlink === 1, "multiply-linked");
          requireCapture(stat.size <= LIMIT, "too-large");
          checkRoot();
          const current = fs.lstatSync(path);
          requireCapture(
            dirname(fs.realpathSync(path)) === root.path && identity(current) === identity(stat),
            "escaped",
          );
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
/** Screenshot tool metadata stays in the verifier session, never in later text consumers. */
export function screenshotPrivacy() {
  const locators = new Set<string>(),
    calls = new Set<string>();
  const remember = (path: string, filename = true) => {
    locators.add(path);
    if (filename) locators.add(basename(path));
  };
  const text = (value: string) =>
    /\.png\b|iVBORw0KGgo|\/screenshots\//i.test(value) || [...locators].some((s) => s && value.includes(s))
      ? "[local screenshot evidence omitted]"
      : value;
  const control = /^(status|overall|blockedReason|requirement|failureClass)$/;
  const data = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (key, v: unknown) => (typeof v === "string" && !control.test(key) ? text(v) : v)),
    );
  const event = (value: AgentEvent): AgentEvent => {
    if (value.type === "tool_call" && value.name.endsWith("browser_take_screenshot")) {
      calls.add(value.id);
      JSON.stringify(value.input, (key, v: unknown) => {
        if ((key === "filename" || key === "path") && typeof v === "string") remember(v);
        return v;
      });
      return { ...value, input: {} };
    }
    if (value.type === "tool_result" && calls.has(value.id))
      return { ...value, output: "[local screenshot evidence omitted]" };
    return data(value);
  };
  return { remember, text, data, event };
}
