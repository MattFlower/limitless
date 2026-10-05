import { strict as assert } from "node:assert";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { worktreeGit } from "./command.ts";
import { withRepoLock } from "./repos.ts";

/** Discover only through the protected cache, never through the candidate's Git pointer. */
export async function recordLegacyWorktree(cwd: string, cache: string): Promise<boolean> {
  return withRepoLock(cache, () => registerLegacyWorktree(cwd, cache));
}

async function registerLegacyWorktree(cwd: string, cache: string): Promise<boolean> {
  const record = `${resolve(cwd)}.git-paths`;
  if (lstatSync(record, { throwIfNoEntry: false })) return false;
  const unsafe = "Unsafe worktree Git administration";
  try {
    const uid = process.getuid?.();
    assert(uid !== undefined, unsafe);
    const inspect = (path: string, recursive = false) => {
      const stat = lstatSync(path);
      assert(stat.uid === uid && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)), unsafe);
      if (recursive && stat.isDirectory())
        for (const name of readdirSync(path)) {
          assert(!/^config(?:\.worktree)?$/.test(name), unsafe);
          inspect(join(path, name), true);
        }
    };
    // Canonicalize trusted parent roots (e.g. macOS /var), but reject symlinked leaves.
    const common = join(realpathSync(dirname(cache)), basename(cache));
    const work = join(realpathSync(dirname(cwd)), basename(cwd));
    assert(common !== work && !common.startsWith(`${work}/`), unsafe);
    inspect(common);
    inspect(work);
    inspect(join(work, ".git"));
    const admins = join(common, "worktrees");
    inspect(admins);
    const pointsTo = (from: string, value: string, target: string) =>
      value === target || value === relative(from, target);
    const listed = await worktreeGit(
      ["git", `--git-dir=${common}`, "worktree", "list", "--porcelain", "-z"],
      {
        cwd: common,
        env: { ...(process.env as Record<string, string>), GIT_COMMON_DIR: common },
      },
    );
    const fields = listed.stdout.split("\0");
    assert(fields[0] === `worktree ${common}` && fields[1] === "bare", unsafe);
    assert(fields.includes(`worktree ${work}`), unsafe);
    const matches = readdirSync(admins).filter((name) => {
      const admin = join(admins, name);
      // Interrupted sibling creation may leave no backlink; validate only the matched admin below.
      if (
        !lstatSync(admin).isDirectory() ||
        !lstatSync(join(admin, "gitdir"), { throwIfNoEntry: false })?.isFile()
      )
        return false;
      return pointsTo(admin, readFileSync(join(admin, "gitdir"), "utf8").trim(), join(work, ".git"));
    });
    assert(matches.length === 1, unsafe);
    const admin = join(admins, matches[0] ?? "");
    inspect(admin, true);
    assert(pointsTo(admin, readFileSync(join(admin, "commondir"), "utf8").trim(), common), unsafe);
    const pointer = readFileSync(join(work, ".git"), "utf8").trim();
    assert(pointer.startsWith("gitdir: ") && pointsTo(work, pointer.slice(8), admin), unsafe);
    writeFileSync(record, JSON.stringify([work, admin, common]), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (lstatSync(record, { throwIfNoEntry: false })) return false;
    throw new Error(unsafe, { cause: error });
  }
}
