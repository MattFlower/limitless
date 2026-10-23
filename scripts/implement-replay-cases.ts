import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import {
  defaultCasePath,
  type hiddenContents,
  ImplementCaseFileSchema,
  ImplementCaseSchema,
} from "../src/evals/cases.ts";
import { injectHiddenFiles } from "../src/evals/implement.ts";
import { prepareEvalGates } from "../src/evals/prepare.ts";
import { runGates } from "../src/gates/run.ts";
import { cacheGit } from "../src/git/command.ts";
import { addDetachedWorktree, ensureCache, withRepoLock } from "../src/git/repos.ts";
import { readPolicyScope } from "../src/harness/read-policy.ts";
import { withCommandScratch } from "../src/harness/sandbox.ts";
import { type GhRunner, runGh } from "../src/integrations/github.ts";
import { redactCredentials } from "../src/util/proc.ts";

const optionsSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/),
  prs: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1),
});
export function replayArguments(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { repo: { type: "string" }, pr: { type: "string" } },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length || !values.pr || !/^\d+(,\d+)*$/.test(values.pr))
    throw new Error("Usage: bun scripts/implement-replay-cases.ts --repo owner/name --pr n[,n…]");
  return optionsSchema.parse({ repo: values.repo, prs: values.pr.split(",").map(Number) });
}

/** Factory reports quote every line, including empty lines, with exactly one outer prefix. */
export function replayRequest(body: string): string {
  const sections = body.split(/^## Request\r?\n/m);
  if (sections.length !== 2) throw new Error("Missing or ambiguous quoted Request block");
  const block =
    (sections[1] ?? "")
      .split(/^## /m)[0]
      ?.replace(/^\r?\n/, "")
      .replace(/\n+$/, "") ?? "";
  const lines = block.split("\n");
  if (lines.some((line) => line !== ">" && !line.startsWith("> ")))
    throw new Error("Malformed quoted Request block");
  const request = lines.map((line) => (line === ">" ? "" : line.slice(2))).join("\n");
  if (!request.trim()) throw new Error("Empty quoted Request block");
  return request;
}

function production(body: string) {
  // Only named report sections are evidence; routing chains and quoted requests are not usage.
  const section = (name: string) =>
    body.split(new RegExp(`^## ${name}[^\\n]*\\n`, "m"))[1]?.split(/^## /m)[0] ?? "";
  const complexity = section("Triage")
    .match(/\bcomplexity\b["'\s|:*`]*([a-z]+)/i)?.[1]
    ?.toLowerCase();
  const review = section("Code review");
  const rounds = review.match(/Review rounds:\s*(\d+)/i)?.[1];
  const panel = [...review.matchAll(/^- Panel review R(\d+)\b/gm)].map((m) => Number(m[1]));
  const count = rounds ?? (panel.length ? String(Math.max(...panel)) : "unknown");
  const models = [
    ...new Set([...section("Work log").matchAll(/^\| implement\s*\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1])),
  ];
  const intro = body.split(/^## /m)[0] ?? "";
  const human = /needs a human/i.test(intro)
    ? "true"
    : /(?:Built|Verified) by \*\*Limitless\*\* —/.test(intro)
      ? "false"
      : "unknown";
  return {
    complexity: complexity ?? "medium",
    tags: ["replay", "replay-v2", `needs_human:${human}`, `review-rounds:${count}`],
    notes: `Production metadata provenance: PR body factory report (Triage, Code review, Work log, introduction). Triage complexity: ${complexity ?? "unknown (default medium)"}; review rounds: ${count} (explicit count or highest recorded panel-review ordinal); needs_human: ${human}; observed implement models: ${models.join(", ") || "unknown"}. Routing configuration is not model usage.`,
  };
}

type Result = { pr: number; case: string; base: string; head: string; reason: string };
type Dependencies = {
  gh?: GhRunner;
  casePath?: string;
  cache: (repo: string, branch: string, signal: AbortSignal) => Promise<string>;
  timeoutSec?: number;
};

export async function generateReplayCases(
  options: { repo: string; prs: number[] },
  deps: Dependencies,
): Promise<Result[]> {
  const { repo, prs } = optionsSchema.parse(options);
  const casePath = deps.casePath ?? defaultCasePath("implement");
  const envelope: z.input<typeof ImplementCaseFileSchema> = JSON.parse(readFileSync(casePath, "utf8"));
  const cases = ImplementCaseFileSchema.parse(envelope).cases;
  const ids = cases.flatMap((item) => /^impl-(\d+)$/.exec(item.id)?.[1] ?? []);
  let next = ids.reduce((max, id) => (BigInt(id) > max ? BigInt(id) : max), 0n) + 1n;
  const width = Math.max(3, ...ids.map((id) => id.length));
  const gh = deps.gh ?? runGh;
  const signal = new AbortController().signal;
  const json = async (args: string[]) => JSON.parse(String(await gh(args, signal)));
  const results: Result[] = [];
  let cache: string | undefined;
  let defaultTip = "";
  const seen = new Set<number>();
  for (const pr of prs) {
    const row: Result = { pr, case: "—", base: "not-run", head: "not-run", reason: "" };
    results.push(row);
    try {
      const duplicate = cases.find(
        (item) =>
          item.repo.toLowerCase() === repo.toLowerCase() &&
          [...item.source.matchAll(/https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\b/g)].some(
            (m) => m[1]?.toLowerCase() === repo.toLowerCase() && Number(m[2]) === pr,
          ),
      );
      if (seen.has(pr) || duplicate) {
        row.case = duplicate?.id ?? "—";
        row.reason = "duplicate PR; skipped";
        continue;
      }
      seen.add(pr);
      const data = z
        .object({
          body: z.string(),
          url: z.url(),
          state: z.string(),
          mergeCommit: z.object({ oid: z.string().regex(/^[a-f0-9]{40}$/) }).nullable(),
        })
        .parse(
          await json(["pr", "view", String(pr), "--repo", repo, "--json", "body,url,state,mergeCommit"]),
        );
      if (data.state !== "MERGED") throw new Error("PR is not merged");
      if (!data.mergeCommit) throw new Error("PR has no merge commit");
      const prompt = replayRequest(data.body);
      if (!cache) {
        const info = z
          .object({ defaultBranchRef: z.object({ name: z.string().min(1) }) })
          .parse(await json(["repo", "view", repo, "--json", "defaultBranchRef"]));
        const fetched = await deps.cache(repo, info.defaultBranchRef.name, signal);
        // Pin the fetched default tip before any repository code executes.
        const tip = await cacheGit(
          ["git", "rev-parse", "--verify", `refs/remotes/origin/${info.defaultBranchRef.name}^{commit}`],
          { cwd: fetched, signal },
        );
        cache = fetched;
        defaultTip = tip.stdout.trim();
      }
      const repository = cache;
      const head = data.mergeCommit.oid;
      const parents = (
        await cacheGit(["git", "rev-list", "--parents", "-n", "1", head], { cwd: cache, signal })
      ).stdout
        .trim()
        .split(" ");
      const base = parents[1];
      if (parents.length !== 2 || !base) throw new Error("Merge result is not a single-parent squash commit");
      const ancestry = await cacheGit(["git", "merge-base", "--is-ancestor", head, defaultTip], {
        cwd: cache,
        signal,
        allowFail: true,
      });
      if (ancestry.exitCode !== 0) throw new Error("Merge commit is not reachable from the default branch");
      const diff = await cacheGit(
        ["git", "diff", "--no-renames", "--name-only", "-z", "--diff-filter=AMT", base, head, "--", "test/"],
        { cwd: cache, signal },
      );
      const paths = diff.stdout
        .split("\0")
        .filter((path) => path.startsWith("test/") && path.endsWith(".test.ts"))
        .sort();
      if (!paths.length) throw new Error("No qualifying test files");
      const id = `impl-${String(next).padStart(width, "0")}`;
      row.case = id;
      const item = ImplementCaseSchema.parse({
        id,
        repo,
        base,
        head,
        prompt,
        spec: null,
        source: data.url,
        ...production(data.body),
        hidden: {
          files: paths,
          command: `bun test ${paths.map((path) => `'./${path.replaceAll("'", "'\\''")}'`).join(" ")}`,
          timeoutSec: deps.timeoutSec ?? 900,
        },
      });
      const files: ReturnType<typeof hiddenContents> = [];
      for (const path of paths) {
        const mode = (
          await cacheGit(["git", "--literal-pathspecs", "ls-tree", head, "--", path], { cwd: cache, signal })
        ).stdout.slice(0, 6);
        if (mode !== "100644" && mode !== "100755") throw new Error(`Test is not a regular file: ${path}`);
        const blob = await cacheGit(["git", "show", `${head}:${path}`], {
          cwd: cache,
          signal,
          encoding: "latin1",
        });
        files.push({
          path,
          content: Buffer.from(blob.stdout, "latin1"),
          mode: Number.parseInt(mode, 8) & 0o777,
        });
      }
      const root = mkdtempSync(join(tmpdir(), "implement-replay-"));
      try {
        for (const revision of ["base", "head"] as const) {
          const cwd = join(root, revision);
          try {
            await withRepoLock(cache, () => addDetachedWorktree(repository, item[revision], cwd, signal));
            row[revision] = await withCommandScratch(cwd, async () => {
              const { gates, baseline } = await prepareEvalGates(item, cwd, signal, true);
              if (!baseline.setupOk) {
                row.reason += `${revision}: setup-failure; `;
                return "not-run";
              }
              injectHiddenFiles(cwd, files);
              const result = await runGates(
                cwd,
                {
                  ...gates,
                  setup: [],
                  checks: [{ name: "hidden", run: item.hidden.command, timeoutSec: item.hidden.timeoutSec }],
                },
                signal,
              );
              const out = result.checks[0];
              if (!out || out.confinementError)
                throw new Error("Hidden command did not complete with confirmed confinement");
              if (out.timedOut) return "timeout";
              if (out.exitCode === null || out.exitCode === 126 || out.exitCode === 127) {
                row.reason += `${revision}: launch-failure; `;
                return "not-run";
              }
              return out.ok ? "pass" : "fail";
            });
          } catch (error) {
            row[revision] = "not-run";
            row.reason += `${revision}: error: ${(error as Error).message}; `;
          }
          await withRepoLock(repository, () =>
            cacheGit(["git", "worktree", "remove", "--force", cwd], { cwd: repository, allowFail: true }),
          );
          if (existsSync(cwd)) throw new Error("Could not remove validation worktree");
          rmSync(`${cwd}.git-paths`, { force: true });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      if (row.base !== "fail" || row.head !== "pass")
        throw new Error(
          `${row.reason}excluded: base ${row.base}, head ${row.head}; expected base fail and head pass`,
        );
      const hidden = join(dirname(casePath), "hidden", id);
      const temp = `${casePath}.${randomUUID()}.tmp`;
      for (const text of [JSON.stringify(item), ...files.map((file) => file.content.toString("utf8"))])
        if (redactCredentials(text) !== text)
          throw new Error("Replay contains registered credentials; refusing to rewrite original bytes");
      if (existsSync(hidden)) throw new Error(`Hidden destination already exists: ${id}`);
      try {
        mkdirSync(hidden, { recursive: true });
        injectHiddenFiles(hidden, files);
        const updated = { ...envelope, cases: [...envelope.cases, item] };
        ImplementCaseFileSchema.parse(updated);
        writeFileSync(temp, `${JSON.stringify(updated, null, 2)}\n`);
        renameSync(temp, casePath);
        envelope.cases.push(item);
        cases.push(item);
        next++;
        row.reason = "accepted";
      } catch (error) {
        rmSync(hidden, { recursive: true, force: true });
        throw error;
      } finally {
        rmSync(temp, { force: true });
      }
    } catch (error) {
      row.reason = redactCredentials((error as Error).message);
    }
  }
  return results;
}

if (import.meta.main) {
  try {
    const options = replayArguments(Bun.argv.slice(2));
    const cfg = loadConfig({ readOnly: true });
    const results = await readPolicyScope.run(cfg.readPolicy, () =>
      generateReplayCases(options, {
        cache: (slug, defaultBranch, signal) =>
          ensureCache(
            cfg.paths,
            {
              id: slug,
              slug,
              kind: "github",
              url: `https://github.com/${slug}.git`,
              localPath: null,
              defaultBranch,
              mergePolicy: "pr",
              createdAt: 0,
            },
            signal,
          ),
      }),
    );
    console.table(results);
  } catch (error) {
    console.error(redactCredentials((error as Error).message));
    process.exitCode = 1;
  }
}
