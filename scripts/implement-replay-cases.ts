import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import type { Run } from "../src/core/types.ts";
import {
  defaultCasePath,
  hiddenContents,
  ImplementCaseFileSchema,
  ImplementCaseSchema,
} from "../src/evals/cases.ts";
import { gradeImplement, injectHiddenFiles } from "../src/evals/implement.ts";
import { prepareImplementCase } from "../src/evals/prepare.ts";
import { cacheGit } from "../src/git/command.ts";
import { createEvalWorktreeFromCache, ensureCache } from "../src/git/repos.ts";
import { readPolicyScope } from "../src/harness/read-policy.ts";
import { type GhRunner, runGh } from "../src/integrations/github.ts";
import { redactCredentials, sh } from "../src/util/proc.ts";

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

export async function replayProduction(body: string, lookupRun?: Dependencies["lookupRun"]) {
  // Only named report sections are evidence; routing chains and quoted requests are not usage.
  const section = (name: string) =>
    body.split(new RegExp(`^## ${name}[^\\n]*\\n`, "m"))[1]?.split(/^## /m)[0] ?? "";
  const runId = body.match(/^Run `([^`\r\n]+)` · .+$/m)?.[1];
  let complexity: Run["complexity"] = null;
  let complexitySource = runId ? `run ${runId}: lookup not configured` : "no run footer";
  if (runId && lookupRun) {
    try {
      complexity = (await lookupRun(runId))?.complexity ?? null;
      complexitySource = `run record ${runId}${complexity ? "" : ": complexity unavailable"}`;
    } catch {
      complexitySource = `run record ${runId}: lookup unavailable`;
    }
  }
  const review = section("Code review");
  const panel = [...review.matchAll(/^- Panel review R(\d+)\b/gm)].map((m) => Number(m[1]));
  const work = section("Work log");
  const reviews = [...work.matchAll(/^\| review\s*\|/gm)].length;
  const count = panel.length ? String(Math.max(...panel)) : reviews ? String(reviews) : "unknown";
  const reviewSource = panel.length ? "highest recorded panel-review ordinal" : "Work log review rows";
  const models = [...new Set([...work.matchAll(/^\| implement\s*\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]))];
  const intro = body.split(/^## /m)[0] ?? "";
  const human = /needs a human/i.test(intro)
    ? "true"
    : /(?:Built|Verified) by \*\*Limitless\*\* —/.test(intro)
      ? "false"
      : "unknown";
  return {
    complexity: complexity ?? "medium",
    tags: ["replay", "replay-v2", `needs_human:${human}`, `review-rounds:${count}`],
    notes: `Production metadata provenance: ${complexitySource}; PR body factory report (Code review, Work log, introduction). Triage complexity: ${complexity ?? "unknown (default medium)"}; review rounds: ${count} (${reviewSource}); needs_human: ${human}; observed implement models: ${models.join(", ") || "unknown"}. Routing configuration is not model usage.`,
  };
}

type Result = {
  pr: number;
  case: string;
  base: string;
  head: string;
  baseFailure: "assertion-failure" | "load-error" | "—";
  reason: string;
};
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
type Dependencies = {
  gh?: GhRunner;
  casePath?: string;
  cache: (repo: string, branch: string, signal: AbortSignal) => Promise<string>;
  /** Optional access to the run record named by the report footer; never fetch its arbitrary URL. */
  lookupRun?: (id: string) => Promise<Pick<Run, "complexity"> | null | undefined>;
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
  const firstId = next;
  const width = Math.max(3, ...ids.map((id) => id.length));
  const gh = deps.gh ?? runGh;
  const signal = new AbortController().signal;
  const json = async (args: string[]) => JSON.parse(String(await gh(args, signal)));
  const results: Result[] = [];
  const proposed: {
    row: Result;
    item: z.infer<typeof ImplementCaseSchema>;
    files: ReturnType<typeof hiddenContents>;
  }[] = [];
  let cache: string | undefined;
  let defaultTip = "";
  const seen = new Set<number>();
  for (const pr of prs) {
    const row: Result = { pr, case: "—", base: "not-run", head: "not-run", baseFailure: "—", reason: "" };
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
      const id = `impl-${String(next + BigInt(proposed.length)).padStart(width, "0")}`;
      row.case = id;
      const item = ImplementCaseSchema.parse({
        id,
        repo,
        base,
        head,
        prompt,
        snapshot: true,
        spec: null,
        source: data.url,
        ...(await replayProduction(data.body, deps.lookupRun)),
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
      for (const text of [JSON.stringify(item), ...files.map((file) => file.content.toString("utf8"))])
        if (redactCredentials(text) !== text)
          throw new Error("Replay contains registered credentials; refusing to rewrite original bytes");
      proposed.push({ row, item, files });
    } catch (error) {
      row.reason = redactCredentials((error as Error).message);
    }
  }
  if (!cache || !proposed.length) return results;
  const repository = cache;
  const labels = (dataset: Uint8Array, batch: typeof proposed) => ({
    paths: ["evals/implement"],
    contents: [
      dataset,
      ...cases.flatMap((existing) => hiddenContents(existing, casePath).map((file) => file.content)),
      ...batch.flatMap(({ files }) => files.map((file) => file.content)),
    ],
  });
  // Include later PRs even when an earlier case would pass in isolation.
  const batchLabels = labels(readFileSync(casePath), proposed);
  let survivors: typeof proposed = [];
  for (const proposal of proposed) {
    const { row, item, files } = proposal;
    item.id = row.case = `impl-${String(next).padStart(width, "0")}`;
    const root = mkdtempSync(join(tmpdir(), "implement-replay-"));
    try {
      if (existsSync(join(dirname(casePath), "hidden", item.id)))
        throw new Error(`Hidden destination already exists: ${item.id}`);
      const cwd = join(root, "candidate");
      const { effective, prepared, cleanup } = await prepareImplementCase(
        item,
        cwd,
        signal,
        (base, snapshot) =>
          createEvalWorktreeFromCache(repository, base, base, cwd, signal, batchLabels, snapshot),
      ).catch((error: Error) => {
        throw new Error(`excluded: runner preparation: ${error.message}`);
      });
      try {
        for (const revision of ["base", "head"] as const) {
          let reference: Awaited<ReturnType<typeof createEvalWorktreeFromCache>> | undefined;
          try {
            const grading = revision === "base" ? cwd : join(root, "reference");
            // The reference is isolated from candidate preparation and shares its snapshot base.
            if (revision === "head") {
              reference = await createEvalWorktreeFromCache(
                repository,
                item.base,
                item.head,
                grading,
                signal,
                { paths: ["evals/implement"], contents: [] },
                true,
              );
              if (reference.base !== effective.base) throw new Error("Reference snapshot base differs");
            }
            const grade = await gradeImplement(effective, grading, files, prepared, [], signal);
            const evidence = grade.implement;
            // The negative control is intentionally unchanged; its empty-diff finding is expected.
            const unchangedBase =
              revision === "base" &&
              evidence?.reason === "audit" &&
              evidence.auditBlocks.length === 1 &&
              evidence.auditBlocks[0]?.rule === "empty-diff";
            row[revision] =
              grade.pass || (unchangedBase && evidence.hidden?.exitCode === 0 && !evidence.hidden.timedOut)
                ? "pass"
                : evidence?.reason === "timeout"
                  ? "timeout"
                  : (evidence?.reason === "hidden_tests" || unchangedBase) &&
                      evidence?.hidden &&
                      !evidence.hidden.timedOut &&
                      evidence.hidden.exitCode !== null &&
                      evidence.hidden.exitCode !== 126 &&
                      evidence.hidden.exitCode !== 127
                    ? "fail"
                    : "not-run";
            if (!grade.pass) row.reason += `${revision}: ${JSON.stringify(evidence)}; `;
            if (revision === "base" && row.base === "fail") {
              // Bun reports import failures between tests; test titles and assertion text are not loader diagnostics.
              const output = evidence?.hidden?.output ?? "";
              row.baseFailure =
                /# Unhandled error between tests\r?\n-+\r?\n(?:error: Cannot find (?:module|package) ['"][^\r\n]+['"] from ['"][^\r\n]+['"]|error: (?:Could not|Cannot) resolve ['"][^\r\n]+['"]|(?:error|SyntaxError): Export named ['"][^\r\n]+['"] not found in module ['"][^\r\n]+['"])\.?\r?$/m.test(
                  output,
                )
                  ? "load-error"
                  : "assertion-failure";
            }
          } catch (error) {
            row[revision] = "not-run";
            row.reason += `${revision}: error: ${(error as Error).message}; `;
          } finally {
            await reference?.();
          }
        }
      } finally {
        await cleanup();
      }
      if (row.base !== "fail" || row.head !== "pass")
        throw new Error(
          `${row.reason}excluded: base ${row.base}, head ${row.head}; expected base hidden_tests failure and head pass`,
        );
      if (row.baseFailure === "load-error") item.tags.push("base-load-error");
      survivors.push(proposal);
      next++;
    } catch (error) {
      row.reason = redactCredentials((error as Error).message);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const temp = `${casePath}.${randomUUID()}.tmp.json`;
  const published: string[] = [];
  try {
    while (survivors.length) {
      for (const [index, { row, item }] of survivors.entries())
        item.id = row.case = `impl-${String(firstId + BigInt(index)).padStart(width, "0")}`;
      const updated = { ...envelope, cases: [...envelope.cases, ...survivors.map(({ item }) => item)] };
      ImplementCaseFileSchema.parse(updated);
      writeFileSync(temp, `${JSON.stringify(updated, null, 2)}\n`);
      try {
        await sh(
          [
            join(repositoryRoot, "node_modules/.bin/biome"),
            "check",
            "--write",
            "--config-path",
            repositoryRoot,
            temp,
          ],
          { cwd: repositoryRoot, signal },
        );
      } catch (error) {
        throw new Error(`excluded: dataset formatter failed: ${(error as Error).message}`);
      }
      const finalLabels = labels(readFileSync(temp), survivors);
      const checked: typeof proposed = [];
      for (const proposal of survivors) {
        const root = mkdtempSync(join(tmpdir(), "implement-replay-final-"));
        const cwd = join(root, "candidate");
        try {
          const { cleanup } = await prepareImplementCase(proposal.item, cwd, signal, (base, snapshot) =>
            createEvalWorktreeFromCache(repository, base, base, cwd, signal, finalLabels, snapshot),
          );
          await cleanup();
          checked.push(proposal);
        } catch (error) {
          proposal.row.reason = redactCredentials(
            `excluded: runner preparation against final dataset: ${(error as Error).message}`,
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
      if (checked.length === survivors.length) break;
      survivors = checked;
    }
    if (survivors.length) {
      for (const { item, files } of survivors) {
        const hidden = join(dirname(casePath), "hidden", item.id);
        if (existsSync(hidden)) throw new Error(`Hidden destination already exists: ${item.id}`);
        published.push(hidden);
        mkdirSync(hidden, { recursive: true });
        injectHiddenFiles(hidden, files);
      }
      renameSync(temp, casePath);
      for (const { row } of survivors) row.reason = "accepted";
    }
  } catch (error) {
    for (const hidden of published) rmSync(hidden, { recursive: true, force: true });
    for (const { row } of survivors) row.reason = redactCredentials((error as Error).message);
  } finally {
    rmSync(temp, { force: true });
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
