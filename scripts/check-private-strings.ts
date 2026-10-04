import { z } from "zod";
import { splitPatch } from "../src/gates/audit.ts";
import * as privacy from "../src/gates/private.ts";
import { worktreeGit } from "../src/git/command.ts";
import { checkPrivateRange } from "../src/git/repos.ts";
import { sh } from "../src/util/proc.ts";

try {
  const common = (
    await worktreeGit(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: process.cwd(),
    })
  ).stdout.trim();
  const entries = privacy.loadPrivateStrings(undefined, [process.cwd(), common.replace(/\/\.git$/, "")]);
  if (entries.length) {
    const [pr = "", repo = "", subject = ""] = process.argv.slice(2);
    const opts = { cwd: process.cwd() };
    privacy.checkPrivateText(subject, "Squash subject", entries);
    privacy.checkPrivateText(process.argv[5] ?? "", "Destination branch", entries);
    const { stdout } = await sh(
      ["gh", "pr", "view", pr, "-R", repo, "--json", "baseRefOid,body,headRefName"],
      opts,
    );
    const data = z
      .object({ body: z.string(), baseRefOid: z.string(), headRefName: z.string() })
      .parse(JSON.parse(stdout));
    if (!/^[a-f0-9]{40,64}$/i.test(data.baseRefOid)) throw new Error("Cannot inspect PR base");
    privacy.checkPrivateText(data.body, "PR body", entries);
    privacy.checkPrivateText(data.headRefName, "Branch name", entries);
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
