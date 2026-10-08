import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { splitPatch } from "../src/gates/audit.ts";
import * as privacy from "../src/gates/private.ts";
import { recordWorktree, worktreeGit } from "../src/git/command.ts";
import { checkPrivateRange } from "../src/git/repos.ts";
import { processScope, sh } from "../src/util/proc.ts";

const controller = new AbortController();
for (const event of ["SIGTERM", "SIGINT"] as const) process.on(event, () => controller.abort());
const signal = controller.signal;
processScope.enterWith({ signal, killGraceMs: 100, children: new Map(), scratchDirs: new Set() });
try {
  if (process.argv[2] === "--record") {
    // Land runs this before any PR code: the hardened git calls below trust only these paths.
    if (lstatSync(join(process.cwd(), ".git"), { throwIfNoEntry: false })?.isFile())
      await recordWorktree(process.cwd());
    const paths = await worktreeGit(
      ["git", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
      { cwd: process.cwd() },
    );
    const dirs = paths.stdout
      .trim()
      .split("\n")
      .map((p) => realpathSync(p));
    console.log(dirs.join("\n"));
    process.exit(0);
  }
  const head = z.optional(z.string().regex(/^[a-f0-9]{40,64}$/i)).parse(process.argv[6]);
  if (head) await worktreeGit(["git", "cat-file", "-e", `${head}^{commit}`], { cwd: process.cwd() });
  // Landing supplies inert source paths while all Git runs from its private repository.
  const source = process.env.LIMITLESS_LAND_SOURCE_DIR ?? process.cwd();
  const common =
    process.env.LIMITLESS_LAND_SOURCE_COMMON_DIR ??
    (await worktreeGit(["git", "rev-parse", "--git-common-dir"], { cwd: process.cwd() })).stdout.trim();
  const entries = privacy.loadPrivateStrings(undefined, [source, resolve(common, "..")]);
  if (process.argv[4] === "--merge") {
    const [pr = "", repo = "", , sha = ""] = process.argv.slice(2);
    const opts = { cwd: process.cwd() };
    const cmd = ["gh", "pr", "view", pr, "-R", repo, "--json", "title,body,headRefOid"];
    const { stdout } = await sh(cmd, opts);
    const schema = z.object({ title: z.string().min(1), body: z.string(), headRefOid: z.string() });
    const data = schema.parse(JSON.parse(stdout));
    if (!/^[a-f0-9]{40,64}$/.test(sha) || data.headRefOid !== sha) throw new Error("PR head moved");
    privacy.checkPrivateText(`${data.title}\n${data.body}`, "PR text", entries);
    const merge = ["gh", "pr", "merge", pr, "-R", repo, "--squash", "--delete-branch"];
    await sh([...merge, "--subject", data.title, "--body", data.body, "--match-head-commit", sha], opts);
  } else if (entries.length) {
    const [pr = "", repo = "", subject = ""] = process.argv.slice(2);
    const opts = { cwd: process.cwd() };
    privacy.checkPrivateText(subject, "Squash subject", entries);
    privacy.checkPrivateText(process.argv[5] ?? "", "Destination branch", entries);
    const fields = "baseRefOid,body,headRefName";
    const { stdout } = await sh(["gh", "pr", "view", pr, "-R", repo, "--json", fields], opts);
    const data = z.object({ body: z.string(), baseRefOid: z.string() }).parse(JSON.parse(stdout));
    if (!/^[a-f0-9]{40,64}$/i.test(data.baseRefOid)) throw new Error("Cannot inspect PR base");
    privacy.checkPrivateText(data.body, "PR body", entries);
    privacy.checkPrivateText(z.string().parse(JSON.parse(stdout).headRefName), "Branch name", entries);
    await checkPrivateRange(opts.cwd, `${data.baseRefOid}..${head ?? "HEAD"}`, entries, true);
    const git = (...args: string[]) =>
      worktreeGit(["git", "diff", "--cached", ...args, data.baseRefOid], opts);
    const patch = await git("--text");
    const names = await git("--name-only", "-z", "--diff-filter=ARC");
    privacy.checkPrivateText(names.stdout, "[redacted filename]", entries);
    for (const fp of splitPatch(patch.stdout)) {
      const file = privacy.privateMatches(fp.path, entries).length ? "[redacted filename]" : fp.path;
      fp.added.forEach((line, i) => {
        privacy.checkPrivateText(line, `${file}:${fp.addedLines[i]}`, entries);
      });
    }
  }
} catch (error) {
  console.error(error instanceof privacy.PrivateError ? error.message : "Private check blocked");
  process.exit(1);
}
