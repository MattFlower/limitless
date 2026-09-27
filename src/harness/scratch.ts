import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentSpec } from "./types.ts";

function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve symlinks before checking: TMPDIR can itself be inside the checkout. */
export function createScratch(cwd: string): string {
  const root = realpathSync(cwd);
  for (const candidate of [...new Set([tmpdir(), "/tmp"])]) {
    const base = realpathSync(candidate);
    if (!within(root, base)) return mkdtempSync(join(base, "limitless-reader-"));
  }
  throw new Error("No temporary directory outside the worktree is available");
}

export function scratchEnv(spec: AgentSpec): Record<string, string> {
  return spec.scratchDir ? { TMPDIR: spec.scratchDir, TMP: spec.scratchDir, TEMP: spec.scratchDir } : {};
}

export function validateScratch(spec: AgentSpec): string {
  if (!spec.scratchDir) throw new Error("Tool-enabled reading invocation requires a scratch directory");
  const path = realpathSync(spec.scratchDir);
  const cwd = realpathSync(spec.cwd);
  if (within(cwd, path) || within(path, cwd)) throw new Error("Scratch must be separate from the worktree");
  if (spec.addDirs?.length) throw new Error("Reading invocations cannot grant additional directories");
  return path;
}

/** The callback must await process termination; cleanup also covers thrown errors and cancellation. */
export async function withScratch<T>(cwd: string, run: (scratchDir: string) => Promise<T>): Promise<T> {
  const scratchDir = createScratch(cwd);
  try {
    return await run(scratchDir);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
