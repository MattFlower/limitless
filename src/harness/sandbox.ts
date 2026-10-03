import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, type ProcOptions, type ProcResult, runProcess } from "../util/proc.ts";
import { type WriteRoots, withScratch, writeRoots } from "./scratch.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A command could not run confined: an operational failure, never a gate or grading result. */
export class ConfinementError extends Error {}

/** Seatbelt: everything as usual except writes, which only the roots minus `protect` take; the last match wins. */
export function seatbeltProfile(roots: WriteRoots): string {
  const paths = (list: string[]) =>
    list
      .map((path) => {
        if (/["\\]/.test(path) || [...path].some((c) => c < " "))
          throw new ConfinementError("Cannot confine writes to an unusual path");
        return `(subpath "${path}")`;
      })
      .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${paths(roots.write)} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/(fd/|tty|ptmx$)"))`,
    ...(roots.protect.length ? [`(deny file-write* ${paths(roots.protect)})`] : []),
  ].join("\n");
}

const observed = (roots: WriteRoots): WriteRoots => ({ ...roots, write: [...roots.write, ...observerRoots] });

const verified = new Map<string, Promise<void>>();

/**
 * Before anything runs confined, Seatbelt must allow a write to a granted root and deny one beside it.
 * Only success is remembered, per platform and executable; anything else fails closed and retries.
 * Other platforms have no backend yet, so gates and hidden commands refuse to run there.
 */
export function verifySeatbelt(
  run: typeof runProcess = runProcess,
  executable = SANDBOX_EXEC,
  platform: string = process.platform,
): Promise<void> {
  const key = `${platform}\0${executable}`;
  let check = verified.get(key);
  if (!check) {
    check = probeSeatbelt(run, executable, platform);
    verified.set(key, check);
    check.catch(() => verified.delete(key));
  }
  return check;
}

const WRITE_BOTH = 'printf ok > "$1"; printf no > "$2"';

async function probeSeatbelt(run: typeof runProcess, executable: string, platform: string) {
  if (platform !== "darwin" || !existsSync(executable))
    throw new ConfinementError(`Write confinement unavailable: ${platform} has no Seatbelt (${executable})`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "limitless-seatbelt-")));
  try {
    const allowed = join(root, "allowed");
    mkdirSync(allowed);
    const [inside, outside] = [join(allowed, "file"), join(root, "denied")];
    const proc = await run({
      cmd: [
        executable,
        "-p",
        seatbeltProfile({ write: [allowed], protect: [] }),
        "/bin/sh",
        "-c",
        WRITE_BOTH,
      ].concat(["sh", inside, outside]),
      cwd: root,
      env: agentEnv(),
      timeoutMs: 30_000,
    });
    const wrote = existsSync(inside) && readFileSync(inside, "utf8") === "ok";
    if (proc.exitCode === null || !wrote || existsSync(outside))
      throw new ConfinementError("Write confinement not verified: Seatbelt did not enforce its profile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Extra roots confined commands may write: only test fixtures that observe gate runs add any. */
export const observerRoots = new Set<string>();

/**
 * Run a shell command able to write only `cwd`'s roots and a private scratch, which is also its
 * HOME and TMPDIR (so tool caches can't be shared with, or poisoned for, later commands).
 */
export async function runConfined(
  opts: Omit<ProcOptions, "cmd"> & { command: string },
  verify: () => Promise<void> = verifySeatbelt,
): Promise<ProcResult> {
  await verify();
  opts.signal?.throwIfAborted();
  return withScratch(opts.cwd, (scratch) =>
    runProcess({
      ...opts,
      cmd: [
        SANDBOX_EXEC,
        "-p",
        seatbeltProfile(observed(writeRoots(opts.cwd, scratch))),
        "/bin/sh",
        "-c",
        opts.command,
      ],
      env: { ...opts.env, HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    }),
  );
}
