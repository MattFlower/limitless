import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../db/store.ts";
import { isInertMedia } from "../gates/media.ts";
import type { AgentSpec } from "./types.ts";

const LIMIT = 5 * 1024 * 1024;
const outputs = new Map<
  string,
  { roots: { path: string; dev: number; ino: number }[]; diagnosed: boolean }
>();

/** Only browser setup may register collection roots; model replies never supply paths. */
export function registerBrowserOutput(scratch: string, path: string): void {
  const { dev, ino } = lstatSync(path);
  const record = outputs.get(scratch) ?? { roots: [], diagnosed: false };
  record.roots.push({ path, dev, ino });
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
  const reject = (code: string) => {
    rejected[code] = (rejected[code] ?? 0) + 1;
  };
  let index = 0;
  for (const root of record.roots) {
    const checkRoot = () => {
      const stat = lstatSync(root.path);
      if (
        !stat.isDirectory() ||
        stat.dev !== root.dev ||
        stat.ino !== root.ino ||
        realpathSync(root.path) !== root.path
      )
        throw new Error("escaped");
    };
    try {
      checkRoot();
      const entries = readdirSync(root.path).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const entry of entries) {
        let fd: number | undefined;
        try {
          checkRoot();
          const path = join(root.path, entry);
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = fstatSync(fd);
          if (!stat.isFile()) {
            reject("not-regular");
            continue;
          }
          if (stat.nlink !== 1) {
            reject("multiply-linked");
            continue;
          }
          if (stat.size > LIMIT) {
            reject("too-large");
            continue;
          }
          checkRoot();
          const current = lstatSync(path);
          if (
            dirname(realpathSync(path)) !== root.path ||
            current.dev !== stat.dev ||
            current.ino !== stat.ino
          )
            throw new Error("escaped");
          const bytes = Buffer.alloc(LIMIT + 1);
          let size = 0,
            read = 0;
          do {
            read = readSync(fd, bytes, size, bytes.length - size, null);
            size += read;
          } while (read && size < bytes.length);
          if (size > LIMIT) {
            reject("too-large");
            continue;
          }
          const png = bytes.subarray(0, size);
          if (!isInertMedia("x.png", png)) {
            reject("invalid-png");
            continue;
          }
          const name = `screenshot-${invocationId}-${index++}.png`;
          if (!saved.has(name) && saved.size >= 8) {
            reject("over-limit");
            continue;
          }
          store.putArtifact(runId, name, "screenshot", png.toString("base64"));
          saved.add(name);
        } catch {
          reject("unsafe-or-unreadable");
        } finally {
          if (fd !== undefined) closeSync(fd);
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
