import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findingLines, reviewEscapeCases, validateEscapeCase } from "../scripts/review-escape-cases.ts";
import type { ReviewFinding } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { loadRoleCases, type ReviewCase, ReviewCaseFileSchema } from "../src/evals/cases.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

setDefaultTimeout(30_000);
const seed = seeded(async (root) => {
  const work = join(root, "work");
  mkdirSync(work);
  const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: work })).stdout.trim();
  const dated = async (date: string, ...args: string[]) =>
    sh(["git", ...args], {
      cwd: work,
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    });
  const commit = async (file: string, text: string, date: string) => {
    writeFileSync(join(work, file), text);
    await git("add", ".");
    await dated(date, "commit", "-qm", text);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-qb", "main");
  mkdirSync(join(work, "evals"));
  writeFileSync(join(work, "evals/ignored.ts"), "ignored\n");
  const base = await commit("feature.ts", "base\n", "2026-10-01T00:00:00Z");
  await git("checkout", "-qb", "topic");
  const head = await commit("feature.ts", "bad\n", "2026-10-01T10:00:00Z");
  const fix = await commit("feature.ts", "fixed\n", "2026-10-01T12:00:00Z");
  await git("checkout", "-q", "main");
  const middle = await commit("main.txt", "main\n", "2026-10-02T00:00:00Z");
  await git("checkout", "-q", "topic");
  await dated("2026-10-02T10:00:00Z", "merge", "--no-ff", "-qm", "merge main", "main");
  const head2 = await git("rev-parse", "HEAD");
  const unrelatedFix = await commit("other.txt", "unrelated\n", "2026-10-02T13:00:00Z");
  const fix2 = await commit("feature.ts", "fixed again\n", "2026-10-02T14:00:00Z");
  await git("checkout", "-q", "main");
  const late = await commit("late.txt", "late\n", "2026-10-04T00:00:00Z");
  await dated("2026-10-05T00:00:00Z", "merge", "--no-ff", "-qm", "merge reviewed topic", head2);
  mkdirSync(join(root, "repos"));
  await git("clone", "-q", "--bare", work, join(root, "repos/test__repo.git"));
  return { base, head, fix, middle, head2, fix2, unrelatedFix, late };
});
let root: string, store: Store, commits: Awaited<ReturnType<typeof seed>>["value"];
let options: { db: string; repos: string; cases: string; proposals: string; confirm: string };
let originalConfig: string | undefined;
const prompt = "  Original request\nexactly as received.\n\n";
const defect: ReviewFinding = {
  severity: "blocker",
  title: "Reject empty input",
  detail: "Reproduction: empty input crashes.\nL2-L4",
  file: "feature.ts",
  line: 2,
};
const key = (pr: number, round = 1, index = 0) => `test/repo#${pr}/round-${round}/${index}`;
const label = (classification = "defect", severity = "major") => ({
  classification,
  severity,
  category: "correctness",
  confirmedBy: "orchestrator",
});
const json = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value)}\n`);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function row(
  pr: number,
  extra: {
    head?: string;
    fix?: string | null;
    findings?: ReviewFinding[];
    round?: number;
    kind?: string;
    created?: number;
  } = {},
) {
  const repo = store.getRepoBySlug("test/repo");
  if (!repo) throw new Error("missing fixture repo");
  const source = store.createRun(repo, { repo: repo.slug, prompt });
  const round = store.createRun(repo, { repo: repo.slug, prompt: "Fix the findings" });
  store.db
    .query(
      "INSERT INTO review_rounds (run_id, source_run_id, pr_url, round, kind, reviewed_sha, delivered_sha, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      round.id,
      source.id,
      `https://github.com/test/repo/pull/${pr}`,
      extra.round ?? 1,
      extra.kind ?? "review",
      extra.head ?? commits.head,
      extra.fix === undefined ? commits.fix : extra.fix,
      JSON.stringify(extra.findings ?? [defect]),
      extra.created ?? Date.parse("2026-10-01T11:00:00Z"),
    );
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "escape-cases-test-"));
  commits = (await seed(root)).value;
  options = {
    db: join(root, "factory.db"),
    repos: join(root, "repos"),
    cases: join(root, "cases.json"),
    proposals: join(root, "proposals.json"),
    confirm: join(root, "confirmed.json"),
  };
  originalConfig = process.env.LIMITLESS_CONFIG_DIR;
  process.env.LIMITLESS_CONFIG_DIR = join(root, "private-config");
  mkdirSync(process.env.LIMITLESS_CONFIG_DIR);
  store = new Store(options.db);
  store.upsertRepo({
    slug: "test/repo",
    kind: "github",
    url: "https://github.com/test/repo",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const existing = ReviewCaseFileSchema.parse(loadRoleCases("review")).cases[0];
  if (!existing) throw new Error("missing existing case");
  json(options.cases, { role: "review", version: 1, notes: "preserved envelope", cases: [existing] });
  json(options.confirm, {});
});
afterEach(() => {
  store?.close();
  if (originalConfig === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
  else process.env.LIMITLESS_CONFIG_DIR = originalConfig;
  rmSync(root, { recursive: true, force: true });
});
const worktrees = () =>
  sh(["git", "worktree", "list", "--porcelain"], { cwd: join(options.repos, "test__repo.git") });

test("proposals pin each round to its historical main merge base and preserve the exact request", async () => {
  row(10);
  row(10, { round: 2, head: commits.head2, fix: commits.fix2, created: Date.parse("2026-10-02T11:00:00Z") });
  const before = readFileSync(options.cases, "utf8");
  const { cases, validation } = await reviewEscapeCases(options);
  expect(validation.map((v) => v.status)).toEqual(["included", "included"]);
  expect(cases.map((c) => c.base)).toEqual([commits.base, commits.middle]);
  expect(cases.map((c) => c.head)).toEqual([commits.head, commits.head2]);
  expect(cases.map((c) => c.id)).toEqual(["review-002", "review-003"]);
  expect(cases[0]).toMatchObject({
    repo: "test/repo",
    kind: "real",
    snapshot: true,
    split: "escapes-dev",
    input: { prompt, spec: null, implementerReport: "", gates: [] },
    source: `pr #10 review round-1 @ ${commits.head.slice(0, 7)} fixed in ${commits.fix.slice(0, 7)}`,
  });
  expect(cases[0]?.defects[0]).toMatchObject({
    file: "feature.ts",
    lines: [2, 4],
    summary: defect.title,
    foundBy: "orchestrator review round",
    adjudication: `fixed in ${commits.fix}`,
  });
  expect(read(options.proposals)[key(10)]).toMatchObject({
    original: defect,
    proposed: { classification: "defect", severity: "major", category: "correctness" },
    evidence: expect.stringContaining(defect.detail),
  });
  expect(readFileSync(options.cases, "utf8")).toBe(before);
  expect((await worktrees()).stdout.match(/^worktree /gm)).toHaveLength(1);
});

test("write uses confirmed blocking labels only, preserves the prefix, formats, and is idempotent", async () => {
  row(10, {
    findings: [
      defect,
      { ...defect, title: "minor" },
      { ...defect, title: "merge main and resolve conflicts" },
      { ...defect, title: "unconfirmed" },
    ],
  });
  row(11, { head: commits.head2, fix: commits.fix2, findings: [{ ...defect, title: "docs ask" }] });
  json(options.confirm, {
    [key(10)]: { ...label(), category: "compatibility", confirmedBy: "confirmed reviewer" },
    [key(10, 1, 1)]: label("defect", "minor"),
    [key(10, 1, 2)]: label("merge-main", "blocker"),
    [key(11)]: label("docs-process"),
  });
  const before = read(options.cases);
  const result = await reviewEscapeCases({ ...options, write: true });
  expect(result.cases).toHaveLength(1);
  const written = ReviewCaseFileSchema.parse(read(options.cases));
  expect(written.cases.slice(0, before.cases.length)).toEqual(before.cases);
  expect(written.notes).toBe(before.notes);
  const item = written.cases.at(-1);
  expect(item?.defects).toHaveLength(1);
  expect(item?.defects[0]).toMatchObject({
    severity: "major",
    category: "compatibility",
    required: true,
    adjudication: `fixed in ${commits.fix}`,
  });
  expect(item?.input.prompt).toBe(prompt);
  expect(item?.labelHistory?.[0]).toMatchObject({
    from: "real",
    to: "real",
    rule: "escape-case rule, 2026-10-23 (LABELS.md)",
    by: "confirmed reviewer",
  });
  expect(item?.labelHistory?.[0]?.evidence).toContain("reproduction");
  expect(item?.labelHistory?.[0]?.evidence).toContain(commits.fix);
  expect(item?.labelHistory?.[0]?.evidence).toContain(defect.detail);
  expect(read(options.proposals)[key(10, 1, 2)].proposed.classification).toBe("merge-main");
  const bytes = readFileSync(options.cases, "utf8");
  const second = await reviewEscapeCases({ ...options, write: true });
  expect(second.validation[0]?.status).toBe("duplicate");
  expect(readFileSync(options.cases, "utf8")).toBe(bytes);
  const biome = await sh(
    ["bunx", "--no-install", "biome", "check", "--config-path", process.cwd(), options.cases],
    { cwd: process.cwd(), allowFail: true },
  );
  expect(biome.stderr + biome.stdout).not.toContain("formatting");
  expect(biome.exitCode).toBe(0);
});

test("historical main ignores topic history merged after the review", async () => {
  row(10, { head: commits.head2, fix: commits.fix2, created: Date.parse("2026-10-02T11:00:00Z") });
  const result = await reviewEscapeCases(options);
  expect(result.validation[0]?.status).toBe("included");
  expect(result.cases[0]?.base).toBe(commits.middle);
  expect(result.cases[0]?.head).toBe(commits.head2);
  expect(result.cases[0]?.base).not.toBe(result.cases[0]?.head);
});

test("write reserves a shared head only after accepting a confirmed round", async () => {
  row(10);
  row(10, { round: 2 });
  row(10, { round: 3 });
  json(options.confirm, { [key(10, 2)]: label() });
  const before = read(options.cases);
  const result = await reviewEscapeCases({ ...options, write: true });
  expect(result.validation.map((v) => v.status)).toEqual(["excluded", "included", "duplicate"]);
  expect(result.cases).toHaveLength(1);
  expect(result.cases[0]?.source).toBe(
    `pr #10 review round-2 @ ${commits.head.slice(0, 7)} fixed in ${commits.fix.slice(0, 7)}`,
  );
  expect(result.cases[0]?.defects[0]?.severity).toBe("major");
  expect(read(options.cases).cases).toEqual([...before.cases, ...result.cases]);
  const bytes = readFileSync(options.cases, "utf8");
  expect((await reviewEscapeCases({ ...options, write: true })).validation.map((v) => v.status)).toEqual([
    "duplicate",
    "duplicate",
    "duplicate",
  ]);
  expect(readFileSync(options.cases, "utf8")).toBe(bytes);
});

test("parity splits and fixed adjudications parse without changing existing splits", async () => {
  row(10);
  row(11, { head: commits.head2, fix: commits.fix2 });
  const splits = read(options.cases).cases.map((c: ReviewCase) => c.split);
  const result = await reviewEscapeCases(options);
  expect(result.cases.map((c) => c.split)).toEqual(["escapes-dev", "escapes-heldout"]);
  expect(ReviewCaseFileSchema.parse({ ...read(options.cases), cases: result.cases }).cases).toHaveLength(2);
  expect(read(options.cases).cases.map((c: ReviewCase) => c.split)).toEqual(splits);
  expect(ReviewCaseFileSchema.safeParse(loadRoleCases("review")).success).toBe(true);
});

test.each(["missing", "evals", "unrelated", "null fix", "unknown fix", "unknown head"])(
  "excludes invalid %s candidates and cleans detached checkouts",
  async (kind) => {
    row(10, {
      findings: [
        {
          ...defect,
          file: kind === "missing" ? "missing.ts" : kind === "evals" ? "evals/ignored.ts" : "feature.ts",
        },
      ],
      fix:
        kind === "unrelated"
          ? commits.unrelatedFix
          : kind === "null fix"
            ? null
            : kind === "unknown fix"
              ? "f".repeat(40)
              : commits.fix2,
      head: kind === "unknown head" ? "e".repeat(40) : commits.head2,
    });
    json(options.confirm, { [key(10)]: label() });
    const before = readFileSync(options.cases, "utf8");
    const result = await reviewEscapeCases({ ...options, write: true });
    expect(result.cases).toEqual([]);
    expect(result.validation[0]?.status).toBe("excluded");
    const reasons: Record<string, string> = {
      missing: "missing at head",
      evals: "snapshot removes",
      unrelated: "fix does not change",
      "null fix": "delivered_sha",
      "unknown fix": "delivered_sha",
      "unknown head": "merge-base",
    };
    expect(result.validation[0]?.reason).toContain(reasons[kind] ?? "");
    expect(readFileSync(options.cases, "utf8")).toBe(before);
    expect((await worktrees()).stdout.match(/^worktree /gm)).toHaveLength(1);
  },
);

test("validation rejects empty diffs and nonancestor bases and drops only missing defects", async () => {
  row(10, {
    findings: [
      { ...defect, file: "./feature.ts" },
      { ...defect, file: "missing.ts" },
    ],
  });
  const result = await reviewEscapeCases(options);
  expect(result.cases[0]?.defects).toHaveLength(1);
  expect(result.validation[0]?.reason).toContain("missing at head");
  const item = result.cases[0];
  if (!item) throw new Error("missing candidate");
  await expect(
    validateEscapeCase(join(options.repos, "test__repo.git"), { ...item, base: item.head }, commits.fix),
  ).rejects.toThrow("empty diff");
  expect((await worktrees()).stdout.match(/^worktree /gm)).toHaveLength(1);
  await expect(
    validateEscapeCase(join(options.repos, "test__repo.git"), { ...item, base: commits.late }, commits.fix),
  ).rejects.toThrow("base is not an ancestor");
  await expect(
    validateEscapeCase(join(options.repos, "test__repo.git"), { ...item, base: "f".repeat(40) }, commits.fix),
  ).rejects.toThrow("base commit does not exist");
  expect((await worktrees()).stdout.match(/^worktree /gm)).toHaveLength(1);
});

test("deduplicates existing and earlier proposed repo/head pairs", async () => {
  row(10);
  row(11);
  const first = await reviewEscapeCases(options);
  expect(first.validation.map((r) => r.status)).toEqual(["included", "duplicate"]);
  json(options.cases, { ...read(options.cases), cases: [...read(options.cases).cases, ...first.cases] });
  expect((await reviewEscapeCases(options)).validation.map((r) => r.status)).toEqual([
    "duplicate",
    "duplicate",
  ]);
});

async function cli(args: string[] = [], preload = join(import.meta.dir, "git-preload.ts")) {
  return sh(
    [
      "bun",
      "--preload",
      preload,
      "scripts/review-escape-cases.ts",
      "--db",
      options.db,
      "--repos",
      options.repos,
      "--cases",
      options.cases,
      "--proposals",
      options.proposals,
      ...args,
    ],
    { cwd: process.cwd(), allowFail: true },
  );
}

test.each(["returned validation", "CLI table"])(
  "%s redacts credentials and private strings in invalid PR URLs",
  async (boundary) => {
    const credential = `synthetic-${crypto.randomUUID()}`;
    const privateString = `private-${crypto.randomUUID()}`;
    writeFileSync(
      join(process.env.LIMITLESS_CONFIG_DIR ?? root, "private-strings.txt"),
      `${privateString}\n`,
    );
    row(10);
    store.db
      .query("UPDATE review_rounds SET pr_url = ?")
      .run(`https://github.com/test/repo/pull/10?${credential}/${privateString}`);
    const before = readFileSync(options.cases, "utf8");
    let output: string;
    if (boundary === "returned validation") {
      registerCredential("escape-output-test", credential);
      const result = await reviewEscapeCases({ ...options, write: true });
      expect(result.cases).toEqual([]);
      expect(result.validation[0]).toMatchObject({
        round: 1,
        status: "excluded",
        reason: "invalid GitHub PR URL",
      });
      output = JSON.stringify(result.validation);
    } else {
      const preload = join(root, "credential-preload.ts");
      writeFileSync(
        preload,
        `import ${JSON.stringify(join(import.meta.dir, "git-preload.ts"))};\n` +
          `import { registerCredential } from ${JSON.stringify(join(import.meta.dir, "../src/util/proc.ts"))};\n` +
          `registerCredential("escape-output-test", ${JSON.stringify(credential)});\n`,
      );
      const result = await cli(["--write", "--confirm", options.confirm], preload);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("invalid GitHub PR URL");
      output = result.stdout + result.stderr;
    }
    expect(output).toContain("[redacted]");
    expect(output).not.toContain(credential);
    expect(output).not.toContain(privateString);
    expect(readFileSync(options.cases, "utf8")).toBe(before);
  },
);
test("CLI prints candidates and validation, honours since, and ignores CI/conflict rows", async () => {
  row(10);
  row(11, { head: commits.head2, fix: commits.fix2, created: Date.parse("2026-10-02T11:00:00Z") });
  row(12, { kind: "ci", created: Date.parse("2026-10-02T11:00:00Z") });
  row(13, { kind: "conflict", created: Date.parse("2026-10-02T11:00:00Z") });
  const before = readFileSync(options.cases, "utf8");
  const result = await cli(["--since", "2026-10-02"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"split": "escapes-heldout"');
  expect(result.stdout).toContain("included");
  expect(result.stdout).not.toContain("pull/10");
  expect(result.stdout).not.toContain("pull/12");
  expect(Object.keys(read(options.proposals))).toEqual([key(11)]);
  expect(readFileSync(options.cases, "utf8")).toBe(before);
  json(options.confirm, { [key(11)]: label("defect", "blocker") });
  const write = await cli(["--since", "2026-10-02", "--write", "--confirm", options.confirm]);
  expect(write.exitCode).toBe(0);
  expect(read(options.cases).cases.at(-1).defects[0].severity).toBe("blocker");
  expect((await cli(["--write"])).stderr).toContain("--write requires --confirm");
  expect((await cli(["--since", "2026-02-30"])).stderr).toContain("YYYY-MM-DD");
});

test.each(["prompt", "summary", "file", "evidence", "category", "confirmer", "source", "label evidence"])(
  "privacy excludes a private %s without printing its value",
  async (location) => {
    const token =
      location === "source"
        ? "pr #10 review round-1"
        : location === "label evidence"
          ? "Defects demonstrated by a reproduction"
          : `private-${crypto.randomUUID()}`;
    writeFileSync(join(process.env.LIMITLESS_CONFIG_DIR ?? root, "private-strings.txt"), `${token}\n`);
    row(10, {
      findings: [
        {
          ...defect,
          ...(location === "summary"
            ? { title: token }
            : location === "file"
              ? { file: token }
              : location === "evidence"
                ? { detail: token }
                : {}),
        },
      ],
    });
    if (location === "prompt") store.db.query("UPDATE runs SET prompt = ?").run(token);
    json(options.confirm, {
      [key(10)]: {
        ...label(),
        ...(location === "category"
          ? { category: token }
          : location === "confirmer"
            ? { confirmedBy: token }
            : {}),
      },
    });
    const before = readFileSync(options.cases, "utf8");
    const result = await cli(["--write", "--confirm", options.confirm]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("private string (entry 1");
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(readFileSync(options.cases, "utf8")).toBe(before);
    expect(readFileSync(options.proposals, "utf8")).not.toContain(token);
  },
);

test("line ranges prefer named hunks and preserve single lines or unknown locations", () => {
  expect(findingLines({ ...defect, detail: "@@ -1,2 +5,3 @@" })).toEqual([5, 7]);
  expect(findingLines({ ...defect, detail: "@@ -1 +8 @@" })).toEqual([8, 8]);
  expect(findingLines({ ...defect, detail: "@@ -1 +8,0 @@" })).toEqual([8, 8]);
  expect(findingLines({ ...defect, detail: "" })).toEqual([2, 2]);
  expect(findingLines({ ...defect, detail: "", line: undefined })).toEqual([0, 0]);
});

test("default cache/proposal paths and non-defect proposals preserve findings for confirmation", async () => {
  row(10, {
    head: commits.head2,
    fix: commits.fix2,
    created: Date.parse("2026-10-02T11:00:00Z"),
    findings: [
      defect,
      { severity: "blocker", title: "Merge main", detail: "Resolve the\nconflicts" },
      { severity: "blocker", title: "Update docs", detail: "Explain this", file: "README.md" },
      { severity: "blocker", title: "Decision answering a question", detail: "Use the simpler option" },
      { severity: "blocker", title: "Other request", detail: "No code location" },
    ],
  });
  const cache = join(root, "repos/test__repo.git");
  await sh(["git", "update-ref", "refs/remotes/origin/main", commits.late], { cwd: cache });
  await sh(["git", "update-ref", "refs/heads/main", commits.base], { cwd: cache });
  const result = await reviewEscapeCases({ db: options.db, cases: options.cases });
  expect(result.cases).toHaveLength(1);
  expect(result.cases[0]?.base).toBe(commits.middle);
  const proposals = read(join(root, "review-escape-proposals.json"));
  expect(
    Object.values(proposals).map(
      (p) => (p as { proposed: { classification: string } }).proposed.classification,
    ),
  ).toEqual(["defect", "merge-main", "docs-process", "decision", "other"]);
  expect(proposals[key(10, 1, 1)].original).toEqual({
    severity: "blocker",
    title: "Merge main",
    detail: "Resolve the\nconflicts",
    file: null,
    line: null,
  });
  const missingDB = join(root, "missing.db");
  await expect(reviewEscapeCases({ ...options, db: missingDB })).rejects.toThrow();
  expect(existsSync(missingDB)).toBe(false);
  expect((await cli(["--since", "2026-13-01"])).stderr).toContain("YYYY-MM-DD");
});
