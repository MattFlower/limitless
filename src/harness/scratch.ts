import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertProcessesStopped, processScope } from "../util/proc.ts";
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
  assertProcessesStopped();
  const root = basename(scratchDir) === SCRATCH_NAME ? dirname(scratchDir) : scratchDir;
  const remove = () => rmSync(root, { recursive: true, force: true });
  try {
    remove();
  } catch {
    // Candidate code can leave read-only directories. Never chmod through symlinks.
    const writable = (path: string) => {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) return;
      chmodSync(path, stat.mode | 0o700);
      for (const entry of readdirSync(path)) writable(join(path, entry));
    };
    writable(root);
    remove();
  }
}

export function scratchEnv(spec: AgentSpec): Record<string, string> {
  return spec.scratchDir ? { TMPDIR: spec.scratchDir, TMP: spec.scratchDir, TEMP: spec.scratchDir } : {};
}

export function validateScratch(spec: AgentSpec): string {
  if (!spec.scratchDir) throw new Error("Tool-enabled invocation requires a scratch directory");
  const path = realpathSync(spec.scratchDir);
  const cwd = realpathSync(spec.cwd);
  if (within(cwd, path) || within(path, cwd)) throw new Error("Scratch must be separate from the worktree");
  if (spec.addDirs?.length)
    throw new Error(
      `${spec.mode === "edit" ? "Edit" : "Reading"} invocations cannot grant additional directories`,
    );
  return path;
}

export interface WriteRoots {
  /** Writable, as given and canonical: the worktree, scratch. */
  write: string[];
  /** Read-only inside them: the worktree's `.git`, so it can't be pointed at another git directory. */
  protect: string[];
}

/**
 * Where an edit agent, gate or hidden command may write. The shared common directory (config,
 * info/, hooks, objects, other worktrees) and the private admin directory stay read-only.
 */
export function writeRoots(cwd: string, scratchDir: string): WriteRoots {
  const root = realpathSync(cwd);
  const scratch = realpathSync(scratchDir);
  if (within(root, scratch) || within(scratch, root))
    throw new Error("Scratch must be separate from the worktree");
  const dotGit = join(root, ".git");
  const stat = lstatSync(dotGit, { throwIfNoEntry: false });
  const granted = [cwd, scratchDir];
  const protectedPaths = [join(cwd, ".git"), dotGit];
  if (stat?.isFile()) {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    let gitDir: string | null = null;
    try {
      const dir = realpathSync(resolve(root, pointer ?? ""));
      const back = readFileSync(join(dir, "gitdir"), "utf8").trim();
      if (pointer && realpathSync(resolve(dir, back)) === dotGit) gitDir = dir;
    } catch {
      gitDir = null;
    }
    const overlaps = (dir: string) => [root, scratch].some((p) => within(p, dir) || within(dir, p));
    if (!gitDir || basename(dirname(gitDir)) !== "worktrees" || overlaps(gitDir))
      throw new Error("Worktree .git does not name its own linked worktree directory");
    protectedPaths.push(gitDir);
  } else if (stat && !stat.isDirectory()) throw new Error("Worktree .git must be a file or directory");
  return { write: spellings(granted), protect: spellings(protectedPaths) };
}

/** Each path as given and, when it exists, canonical: what a confined profile actually denies. */
export function spellings(paths: string[]): string[] {
  return [...new Set(paths.flatMap((p) => [resolve(p), ...(existsSync(p) ? [realpathSync(p)] : [])]))];
}

/** `denyRead` as given and canonical (either spelling reaches it); cwd and scratch must stay readable. */
export function validateDenyRead(spec: AgentSpec, scratch: string): string[] {
  const cwd = realpathSync(spec.cwd);
  const paths = spellings(spec.denyRead ?? []);
  for (const path of paths)
    if (within(path, cwd) || within(path, scratch))
      throw new Error(`Reader cwd and scratch must be outside ${path}`);
  return paths;
}

/**
 * Where user, factory and other runs' data live: home directories, temporary directories (other
 * invocations' scratch and private logs) and mounted volumes. System files stay readable.
 */
export function privateReadRoots(): string[] {
  const platform =
    process.platform === "darwin"
      ? ["/Users", "/Volumes", "/var/folders", "/private/var/folders", "/private/tmp", "/private/var/tmp"]
      : ["/home", "/root", "/mnt", "/media", "/run/user"];
  return spellings([homedir(), tmpdir(), "/tmp", "/var/tmp", ...platform]);
}

export interface ReadConfinement {
  /** The reader's cwd, both spellings: readable. */
  cwd: string[];
  /** Its scratch, both spellings: readable and writable. */
  scratch: string[];
  /** Private roots plus `denyRead`; cwd and scratch take precedence inside them. */
  deny: string[];
}

/** A confined reader sees its cwd and scratch only; `denyRead` must not overlap them either. */
export function readConfinement(spec: AgentSpec, scratch: string): ReadConfinement {
  const explicit = validateDenyRead(spec, scratch);
  return {
    cwd: spellings([spec.cwd]),
    scratch: spellings([scratch, ...(spec.scratchDir ? [spec.scratchDir] : [])]),
    deny: [...new Set([...privateReadRoots(), ...explicit])],
  };
}

/** The callback must await process termination; cleanup also covers thrown errors and cancellation. */
export async function withScratch<T>(cwd: string, run: (scratchDir: string) => Promise<T>): Promise<T> {
  const scratchDir = createScratch(cwd);
  const scope = processScope.getStore();
  scope?.scratchDirs.add(scratchDir);
  try {
    return await run(scratchDir);
  } finally {
    removeScratch(scratchDir);
    scope?.scratchDirs.delete(scratchDir);
  }
}
