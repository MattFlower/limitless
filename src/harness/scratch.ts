import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentSpec } from "./types.ts";

function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Claude Code's sandbox points its commands' TMPDIR at $CLAUDE_CODE_TMPDIR/claude-<uid>, so the
 * scratch directory carries that name inside a private parent: every process then sees one TMPDIR.
 * Short bases come first because Claude falls back to a shared directory when the path is too
 * long for AF_UNIX sockets.
 */
export const SCRATCH_NAME = `claude-${process.getuid?.() ?? 0}`;

/** Resolve symlinks before checking: TMPDIR can itself be inside the checkout. */
export function createScratch(cwd: string, candidates = [...new Set(["/tmp", tmpdir()])]): string {
  const root = realpathSync(cwd);
  for (const candidate of candidates) {
    let base: string;
    try {
      base = realpathSync(candidate);
    } catch {
      continue;
    }
    if (within(root, base)) continue;
    let parent: string;
    try {
      parent = mkdtempSync(join(base, "lr-"));
    } catch (error) {
      // Sandboxes (e.g. an agent's verify session) may deny /tmp but allow their own TMPDIR.
      if (["EPERM", "EACCES", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    const scratch = join(parent, SCRATCH_NAME);
    mkdirSync(scratch, { mode: 0o700 });
    return scratch;
  }
  throw new Error("No temporary directory outside the worktree is available");
}

/** The private parent created by createScratch; Claude derives the scratch path from it. */
export function scratchParent(scratchDir: string): string {
  if (basename(scratchDir) !== SCRATCH_NAME) throw new Error(`Scratch must be named ${SCRATCH_NAME}`);
  return dirname(scratchDir);
}

export function removeScratch(scratchDir: string): void {
  rmSync(basename(scratchDir) === SCRATCH_NAME ? dirname(scratchDir) : scratchDir, {
    recursive: true,
    force: true,
  });
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
    removeScratch(scratchDir);
  }
}
