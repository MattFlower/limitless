import { resolve } from "node:path";
import { z } from "zod";
import { splitPatch } from "../src/gates/audit.ts";
import * as privacy from "../src/gates/private.ts";
import { worktreeGit } from "../src/git/command.ts";
import { checkPrivateRange } from "../src/git/repos.ts";
import { processScope, sh } from "../src/util/proc.ts";

const controller = new AbortController();
for (const event of ["SIGTERM", "SIGINT"] as const) process.on(event, () => controller.abort());
const signal = controller.signal;
processScope.enterWith({ signal, killGraceMs: 100, children: new Map(), scratchDirs: new Set() });
try {
  const common = await worktreeGit(["git", "rev-parse", "--git-common-dir"], { cwd: process.cwd() });
  const entries = privacy.loadPrivateStrings(undefined, [process.cwd(), resolve(common.stdout.trim(), "..")]);
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
    await checkPrivateRange(opts.cwd, `${data.baseRefOid}..HEAD`, entries, true);
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
