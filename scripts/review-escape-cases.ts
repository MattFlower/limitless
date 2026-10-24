import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  defaultCasePath,
  type ReviewCase,
  ReviewCaseFileSchema,
  ReviewCaseSchema,
} from "../src/evals/cases.ts";
import { loadPrivateStrings, privateMatches, privateReason, redactPrivate } from "../src/gates/private.ts";
import { cacheGit, worktreeGit } from "../src/git/command.ts";
import { addDetachedWorktree } from "../src/git/repos.ts";
import { redactCredentials, sh } from "../src/util/proc.ts";

const severity = z.enum(["blocker", "major", "minor", "nit"]);
const classification = z.enum(["defect", "merge-main", "docs-process", "decision", "other"]);
const confirmation = z.record(
  z.string(),
  z.strictObject({
    classification,
    severity,
    category: z.string().trim().min(1),
    confirmedBy: z.string().trim().min(1),
  }),
);
const finding = z.object({
  severity: z.string(),
  title: z.string().min(1),
  detail: z.string(),
  file: z.string().nullish(),
  line: z.number().int().nonnegative().nullish(),
});
type Finding = z.infer<typeof finding>;
type Row = {
  pr: string;
  round: number;
  head: string;
  fix: string | null;
  findings: string;
  created: number;
  prompt: string;
  branch: string;
};
export type EscapeOptions = {
  db: string;
  repos?: string;
  cases?: string;
  proposals?: string;
  confirm?: string;
  since?: string;
  write?: boolean;
};
const readJSON = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const findingText = (f: Finding) => `${f.severity} ${f.file ?? ""}:${f.line ?? 0}: ${f.title}\n${f.detail}`;
const repoFile = (file: string) => file.replace(/^(\.\/)+/, "");
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, v]) => [key, ...strings(v)])
      : [];

export function findingLines(f: Finding): [number, number] {
  const text = `${f.title}\n${f.detail}`;
  const hunk = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
  const range = /\bL(\d+)-L?(\d+)\b/.exec(text);
  if (hunk) return [Number(hunk[1]), Number(hunk[1]) + Math.max(1, Number(hunk[2] ?? 1)) - 1];
  if (range && Number(range[1]) <= Number(range[2])) return [Number(range[1]), Number(range[2])];
  return [f.line ?? 0, f.line ?? 0];
}
function propose(f: Finding) {
  const text = `${f.title} ${f.detail}`.replace(/\s+/g, " ");
  const kind = /\b(?:merge|rebase)\b.*\b(?:main|master|default branch)\b|\bresolve\b.*\bconflicts?\b/i.test(
    text,
  )
    ? "merge-main"
    : /\b(?:decision|answer.*question)\b/i.test(text)
      ? "decision"
      : /\.md$/i.test(f.file ?? "") || /\b(?:documentation|process ask)\b/i.test(text)
        ? "docs-process"
        : f.file
          ? "defect"
          : "other";
  return {
    classification: kind,
    severity: "major" as const,
    category: kind === "defect" ? "correctness" : kind,
  };
}

export async function validateEscapeCase(cache: string, item: ReviewCase, fix: string | null) {
  const root = mkdtempSync(join(tmpdir(), "review-escape-")),
    checkout = join(root, "checkout");
  const git = async (...args: string[]) => {
    const result = await worktreeGit(["git", ...args], { cwd: checkout, allowFail: true });
    if (result.exitCode !== 0) throw new Error(`${args[0]} validation failed`);
    return result.stdout;
  };
  try {
    await addDetachedWorktree(cache, item.head, checkout);
    await git("cat-file", "-e", `${item.base}^{commit}`).catch(() => {
      throw new Error("base commit does not exist");
    });
    await git("cat-file", "-e", `${item.head}^{commit}`);
    if (item.base === item.head) throw new Error("empty diff: base equals head");
    await git("merge-base", "--is-ancestor", item.base, item.head).catch(() => {
      throw new Error("base is not an ancestor of head");
    });
    const paths = new Set((await git("ls-tree", "-r", "--name-only", "-z", item.head)).split("\0"));
    const reasons: string[] = [];
    item.defects = item.defects.filter((d) => {
      const reason = /^(\.\/)*evals(?:\/|$)/.test(d.file)
        ? "snapshot removes evals/"
        : !paths.has(repoFile(d.file))
          ? "missing at head"
          : "";
      if (reason) reasons.push(`${d.file}: ${reason}`);
      return !reason;
    });
    if (!item.defects.length) throw new Error(reasons.join("; ") || "no eligible defects");
    if (!fix || !/^[0-9a-f]{7,64}$/.test(fix)) throw new Error("missing or invalid delivered_sha");
    await git("cat-file", "-e", `${fix}^{commit}`).catch(() => {
      throw new Error("delivered_sha does not exist");
    });
    const changed = new Set(
      (await git("diff", "--no-renames", "--name-only", "-z", item.head, fix, "--")).split("\0"),
    );
    if (!item.defects.some((d) => changed.has(repoFile(d.file))))
      throw new Error("fix does not change any defect file");
    return reasons.join("; ");
  } finally {
    try {
      if (existsSync(join(checkout, ".git")))
        await cacheGit(["git", "worktree", "remove", "--force", checkout], { cwd: cache });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

export async function reviewEscapeCases(options: EscapeOptions) {
  if (!options.db || (options.write && !options.confirm))
    throw new Error("--db is required; --write requires --confirm");
  const since = options.since === undefined ? 0 : Date.parse(options.since);
  if (
    !Number.isFinite(since) ||
    (options.since !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(options.since) ||
        new Date(since).toISOString().slice(0, 10) !== options.since))
  )
    throw new Error("--since must be a valid YYYY-MM-DD date");
  const casePath = options.cases ?? defaultCasePath("review"),
    file = readJSON(casePath) as z.infer<typeof ReviewCaseFileSchema>;
  ReviewCaseFileSchema.parse(file);
  const labels = options.confirm ? confirmation.parse(readJSON(options.confirm)) : {};
  const privateStrings = loadPrivateStrings(undefined, [resolve(import.meta.dir, "..")]);
  const privacy = (value: unknown) => {
    for (const text of strings(value)) {
      const hit = privateMatches(text, privateStrings)[0];
      if (hit) return privateReason("candidate", hit.entry);
      if (redactCredentials(text) !== text) return "candidate contains registered credentials";
    }
    return "";
  };
  const db = new Database(options.db, { readonly: true, strict: true });
  let rows: Row[];
  try {
    rows = db
      .query<Row, [number]>(
        `SELECT rr.pr_url AS pr, rr.round, rr.reviewed_sha AS head, rr.delivered_sha AS fix, rr.findings, rr.created_at AS created, runs.prompt, repos.default_branch AS branch FROM review_rounds rr JOIN runs ON runs.id = rr.source_run_id JOIN repos ON repos.id = runs.repo_id WHERE rr.kind = 'review' AND rr.created_at >= ? ORDER BY rr.created_at, rr.round`,
      )
      .all(since);
  } finally {
    db.close();
  }
  const cases: ReviewCase[] = [],
    proposals: Record<string, unknown> = {},
    validation: { pr: string; round: number; head: string; status: string; reason: string }[] = [];
  const seen = new Set(file.cases.map((c) => `${c.repo}@${c.head}`));
  let next = Math.max(0, ...file.cases.map((c) => Number(/^review-(\d+)$/.exec(c.id)?.[1] ?? 0))) + 1;
  for (const row of rows) {
    const result = {
      pr: row.pr,
      round: row.round,
      head: row.head.slice(0, 7),
      status: "excluded",
      reason: "",
    };
    validation.push(result);
    try {
      const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(row.pr);
      const repo = match?.[1],
        pr = Number(match?.[2]);
      if (!repo) throw new Error("invalid GitHub PR URL");
      if (seen.has(`${repo}@${row.head}`)) {
        result.status = "duplicate";
        result.reason = "repo/head already has a case";
        continue;
      }
      const findings = z.array(finding).parse(JSON.parse(row.findings));
      const evidence = (originals: Finding[]) =>
        `Defects demonstrated by a reproduction in the orchestrator's review round and fixed by the factory in ${row.fix}. Original findings:\n${originals.map(findingText).join("\n\n")}`;
      const entries = findings.map((f, i) => ({
        id: `${repo}#${pr}/round-${row.round}/${i}`,
        original: { ...f, file: f.file ?? null, line: f.line ?? null },
        proposed: propose(f),
        evidence: `Orchestrator review round ${row.round}; delivered fix ${row.fix ?? "missing"}. Original finding:\n${findingText(f)}`,
      }));
      const privateIssue = privacy([row, entries, entries.map((e) => labels[e.id])]);
      if (privateIssue) {
        result.status = "private";
        result.reason = privateIssue;
        continue;
      }
      for (const entry of entries) proposals[entry.id] = entry;
      const selected = entries.filter(
        (e) =>
          !options.write ||
          (labels[e.id]?.classification === "defect" &&
            ["blocker", "major"].includes(labels[e.id]?.severity ?? "")),
      );
      const cache = join(
        options.repos ?? join(dirname(options.db), "repos"),
        `${repo.replace("/", "__")}.git`,
      );
      const git = async (...args: string[]) =>
        (await cacheGit(["git", ...args], { cwd: cache })).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(row.head)) throw new Error("invalid reviewed_sha");
      const remote = `refs/remotes/origin/${row.branch}`;
      const observed = await cacheGit(["git", "show-ref", "--verify", "--quiet", remote], {
        cwd: cache,
        allowFail: true,
      });
      if (observed.exitCode !== 0 && observed.exitCode !== 1)
        throw new Error("cannot inspect default-branch ref");
      const ref = observed.exitCode === 0 ? remote : `refs/heads/${row.branch}`;
      const atRound = await git(
        "rev-list",
        "--first-parent",
        "-1",
        `--before=${Math.floor(row.created / 1000)}`,
        ref,
        "--",
      );
      if (!atRound) throw new Error("no default-branch commit before round");
      const base = await git("merge-base", row.head, atRound);
      const item: ReviewCase = {
        id: `review-${String(next).padStart(3, "0")}`,
        repo,
        base,
        head: row.head,
        kind: "real",
        snapshot: true,
        split: pr % 2 === 0 ? "escapes-dev" : "escapes-heldout",
        source: `pr #${pr} review round-${row.round} @ ${row.head.slice(0, 7)} fixed in ${row.fix?.slice(0, 7) ?? "missing"}`,
        input: { prompt: row.prompt, spec: null, implementerReport: "", gates: [] },
        defects: selected
          .filter((e) => e.original.file)
          .map((e) => ({
            file: e.original.file ?? "",
            lines: findingLines(e.original),
            summary: e.original.title,
            severity: labels[e.id]?.severity ?? e.proposed.severity,
            category: labels[e.id]?.category ?? e.proposed.category,
            required: true,
            foundBy: "orchestrator review round",
            adjudication: `fixed in ${row.fix}`,
          })),
      };
      result.reason = await validateEscapeCase(cache, item, row.fix);
      if (options.write)
        item.labelHistory = [
          {
            from: "real",
            to: "real",
            on: new Date().toISOString().slice(0, 10),
            rule: "escape-case rule, 2026-10-23 (LABELS.md)",
            by: [...new Set(selected.map((e) => labels[e.id]?.confirmedBy))].join(", "),
            evidence: evidence(selected.map((e) => e.original)),
          },
        ];
      ReviewCaseSchema.parse(item);
      const privateCase = privacy(item);
      if (privateCase) {
        result.status = "private";
        result.reason = privateCase;
        continue;
      }
      cases.push(item);
      seen.add(`${repo}@${row.head}`);
      next++;
      result.status = "included";
    } catch (error) {
      result.reason = redactPrivate(
        redactCredentials(error instanceof Error ? error.message : String(error)),
        privateStrings,
      );
    }
  }
  writeFileSync(
    options.proposals ?? join(dirname(options.db), "review-escape-proposals.json"),
    `${JSON.stringify(proposals, null, 2)}\n`,
  );
  if (options.write && cases.length) {
    const updated = { ...file, cases: [...file.cases, ...cases] };
    ReviewCaseFileSchema.parse(updated);
    const formatted = await sh(
      [
        "bunx",
        "--no-install",
        "biome",
        "format",
        "--config-path",
        resolve(import.meta.dir, ".."),
        "--stdin-file-path",
        casePath,
      ],
      { cwd: resolve(import.meta.dir, ".."), stdin: JSON.stringify(updated) },
    );
    const temporary = `${casePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, formatted.stdout);
      renameSync(temporary, casePath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return {
    cases,
    validation: validation.map((r) => ({
      ...r,
      pr: redactPrivate(redactCredentials(r.pr), privateStrings),
      head: redactPrivate(redactCredentials(r.head), privateStrings),
      status: redactPrivate(redactCredentials(r.status), privateStrings),
      reason: redactPrivate(redactCredentials(r.reason), privateStrings),
    })),
  };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        db: { type: "string" },
        since: { type: "string" },
        repos: { type: "string" },
        cases: { type: "string" },
        proposals: { type: "string" },
        confirm: { type: "string" },
        write: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.db)
      throw new Error(
        "usage: bun scripts/review-escape-cases.ts --db <path> [--since YYYY-MM-DD] [--repos <dir>] [--cases <path>] [--proposals <path>] [--confirm <path>] [--write]",
      );
    const result = await reviewEscapeCases({ ...values, db: values.db });
    console.log(JSON.stringify(result.cases, null, 2));
    console.table(result.validation);
  } catch (error) {
    let message = redactCredentials(error instanceof Error ? error.message : String(error));
    try {
      message = redactPrivate(message, loadPrivateStrings());
    } catch {
      message = "Cannot read private-strings.txt; publication blocked";
    }
    console.error(message);
    process.exitCode = 1;
  }
}
