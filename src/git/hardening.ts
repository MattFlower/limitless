import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sh } from "../util/proc.ts";

type Options = Parameters<typeof sh>[1];

/** What `worktreeGit` adds to a command: hooks to blank and the empty tree for `--attr-source`. */
export interface Hardening {
  /** Every config-defined hook key git sees. */
  hooks: string[];
  /** The empty tree's id in the repository's object format; null when it must be hashed. */
  emptyTree: string | null;
}

/** The empty tree's id is fixed per object format. */
const EMPTY_TREES: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};
/** Per directory, git prefix and environment; valid only while every config source is unchanged. */
const entries = new Map<string, Hardening & { sources: Map<string, string | null> }>();
const listings = new Map<string, Promise<unknown>>();
/** System and global config files (`git var`) per environment; null where git can't name them. */
const configFiles = new Map<string, Promise<string[] | null>>();

/** A regular file's bytes and identity; "dir", null when missing, undefined when unsafe to read. */
function read(path: string): { data: Buffer; id: string } | "dir" | null | undefined {
  let fd: number;
  try {
    // Non-blocking: a FIFO planted where config is read must not stall the daemon.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    // A `.git` directory's own times change with every lock file; the files git reads are tracked.
    if (stat.isDirectory()) return "dir";
    if (!stat.isFile() || stat.size > 1_000_000n) return undefined;
    // ctime changes with every write, so even a change that was reverted is noticed.
    return { data: readFileSync(fd), id: `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}` };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function snapshot(path: string): string | null | undefined {
  const file = read(path);
  if (!file || file === "dir") return file;
  return `${file.id}:${createHash("sha256").update(file.data).digest("base64")}`;
}

/** Variables that choose the repository or the config git reads (GIT_INDEX_FILE does neither). */
function configEnv(env: Record<string, string>): string {
  const relevant = (name: string) =>
    (name.startsWith("GIT_") && name !== "GIT_INDEX_FILE") ||
    ["HOME", "XDG_CONFIG_HOME", "PATH"].includes(name);
  return Object.keys(env)
    .filter(relevant)
    .sort()
    .map((name) => `${name}=${env[name]}`)
    .join("\0");
}

/** Files git will probably read, guessed before asking it so that a first listing can be cached. */
function likelySources(cwd: string, git: string[]): string[] {
  const explicit = git
    .filter((arg) => arg.startsWith("--git-dir="))
    .map((arg) => resolve(cwd, arg.slice(10)));
  const dotGit = read(join(cwd, ".git"));
  const pointer = dotGit && dotGit !== "dir" && /^gitdir: (.+)$/m.exec(dotGit.data.toString())?.[1];
  const dirs = [...explicit, join(cwd, ".git"), cwd, ...(pointer ? [resolve(cwd, pointer)] : [])];
  for (const dir of [...dirs]) {
    const common = read(join(dir, "commondir"));
    if (common && common !== "dir") dirs.push(resolve(dir, common.data.toString().trim()));
  }
  const files = dirs.flatMap((dir) =>
    ["config", "HEAD", "commondir", "config.worktree"].map((f) => join(dir, f)),
  );
  return [join(cwd, ".git"), ...files];
}

/**
 * Hooks and empty tree for the command prefix `git` in `opts.cwd`. A cached result is reused only
 * while every config source git reads is the same file with the same bytes; any doubt re-lists.
 * `lookup` is the uncached hook lookup, for when the listing can't be parsed.
 */
export async function harden(
  git: string[],
  opts: Options,
  lookup: () => Promise<string[]>,
): Promise<Hardening> {
  const env = opts.env ?? (process.env as Record<string, string>);
  const vars = configEnv(env);
  const key = [opts.cwd, ...git, vars].join("\0");
  const cached = entries.get(key);
  if (cached && [...cached.sources].every(([path, seen]) => snapshot(path) === seen)) return cached;
  // A caller arriving during another's listing waits for it, then checks the cache like any caller.
  const listing = listings.get(key);
  const retry = () => harden(git, opts, lookup);
  if (listing) return listing.then(retry, retry);
  entries.delete(key);
  const pending = refresh(git, opts, lookup, env, vars, key, cached?.sources.keys() ?? []);
  listings.set(key, pending);
  return pending.finally(() => listings.delete(key));
}

async function refresh(
  git: string[],
  opts: Options,
  lookup: () => Promise<string[]>,
  env: Record<string, string>,
  vars: string,
  key: string,
  previous: Iterable<string>,
): Promise<Hardening> {
  const files = await (configFiles.get(vars) ?? gitConfigFiles(vars, opts));
  if (!files) return { hooks: await lookup(), emptyTree: null };
  let known = [...files, ...likelySources(opts.cwd, git), ...previous];
  for (let attempt = 0; ; attempt++) {
    // Sources must read the same before and after the listing, or a concurrent edit could hide.
    const before = new Map(known.map((path) => [path, snapshot(path)]));
    const listed = await list(git, opts, env, files);
    if (!listed.parsed) return { hooks: await lookup(), emptyTree: listed.emptyTree };
    const { sources, hooks, emptyTree } = listed;
    if (sources?.every((path) => before.get(path) !== undefined && snapshot(path) === before.get(path))) {
      const entry = {
        hooks,
        emptyTree,
        sources: new Map(sources.map((path) => [path, before.get(path) ?? null])),
      };
      entries.set(key, entry);
      if (entries.size > 256) entries.delete(entries.keys().next().value ?? "");
      return entry;
    }
    // Uncacheable, but still git's current view, as the uncached lookup would have been.
    if (!sources || attempt > 0) return { hooks, emptyTree };
    known = sources;
  }
}

function gitConfigFiles(vars: string, opts: Options): Promise<string[] | null> {
  const query = (name: string) => sh(["git", "var", name], { ...opts, signal: undefined, allowFail: false });
  const files = Promise.all([query("GIT_CONFIG_SYSTEM"), query("GIT_CONFIG_GLOBAL")]).then(
    (outs) => outs.flatMap(({ stdout }) => stdout.split("\n").filter(Boolean)),
    () => null,
  );
  configFiles.set(vars, files);
  return files;
}

/** One listing of every config entry with its origin; `sources` is null when the result can't be pinned. */
async function list(git: string[], opts: Options, env: Record<string, string>, files: string[]) {
  const rev = [
    "rev-parse",
    "--path-format=absolute",
    "--absolute-git-dir",
    "--git-common-dir",
    "--show-object-format",
  ];
  const [revParse, config] = await Promise.all([
    // Outside a repository git still reads system and global config, but nothing pins the result.
    sh([...git, ...rev], { ...opts, allowFail: true }),
    sh([...git, "config", "--list", "--show-origin", "--show-scope", "--includes", "-z"], opts),
  ]);
  const lines = revParse.stdout.split("\n");
  const [gitDir = "", commonDir = "", format = ""] = lines;
  const located = revParse.exitCode === 0 && lines.length === 4 && lines[3] === "" && isAbsolute(gitDir);
  const fields = config.stdout.split("\0");
  const parsed = fields.length % 3 === 1 && fields.at(-1) === "";
  const hooks = new Set<string>();
  const sources = new Set([...files, join(opts.cwd, ".git"), join(commonDir, "config")]);
  for (const file of ["commondir", "HEAD", "config.worktree"]) sources.add(join(gitDir, file));
  // Pinned only when git stopped at `cwd` (its `.git`, a gitfile there, or `cwd` itself) or was told
  // where to look: a repository found further up could be replaced by one created at `cwd`.
  const same = (path: string) => {
    try {
      return realpathSync(path) === realpathSync(gitDir);
    } catch {
      return false;
    }
  };
  const gitFile = read(join(opts.cwd, ".git"));
  const explicit = git.some((arg) => arg.startsWith("--git-dir=")) || "GIT_DIR" in env;
  let pinned =
    located &&
    (explicit || same(join(opts.cwd, ".git")) || same(opts.cwd) || (!!gitFile && gitFile !== "dir"));
  for (let i = 0; parsed && i + 2 < fields.length; i += 3) {
    const [origin = "", entry = ""] = [fields[i + 1], fields[i + 2]];
    const name = entry.split("\n", 1)[0] ?? "";
    const value = entry.includes("\n") ? entry.slice(name.length + 1) : undefined;
    if (name.startsWith("hook.")) hooks.add(name);
    const file = origin.startsWith("file:") ? resolve(opts.cwd, origin.slice(5)) : undefined;
    if (file) sources.add(file);
    else if (origin !== "command line:") pinned = false;
    if (!/^include(if\..+)?\.path$/.test(name)) continue;
    // Include targets count even while missing: creating one later must invalidate the cache.
    if (value?.startsWith("~/") && env.HOME) sources.add(join(env.HOME, value.slice(2)));
    else if (value && isAbsolute(value)) sources.add(value);
    else if (value && file && !/^[~%]/.test(value)) sources.add(resolve(dirname(file), value));
    else pinned = false;
  }
  const emptyTree = (located && EMPTY_TREES[format]) || null;
  return { parsed, hooks: [...hooks], emptyTree, sources: parsed && pinned ? [...sources] : null };
}
