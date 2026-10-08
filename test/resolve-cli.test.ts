import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunModels } from "../src/core/run-models.ts";
import { Store } from "../src/db/store.ts";

type Seen = { method: string; path: string; type: string | null; body: unknown };

async function cli(args: string[], respond: (path: string) => Response, command = "resolve") {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const path = new URL(req.url).pathname;
      const body = text ? JSON.parse(text) : null;
      seen.push({ method: req.method, path, type: req.headers.get("content-type"), body });
      return respond(path);
    },
  });
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli/main.ts"), command, ...args],
      {
        env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${server.port}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { seen, stdout, stderr, exit };
  } finally {
    server.stop();
  }
}

test("show and logs display retained holdout-run diagnostics from the store", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.upsertRepo({
      slug: "test/repo",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "Add farewell" });
    store.setRunState(run.id, {
      holdout: {
        scenarios: [
          {
            id: "H-1",
            description: "private",
            steps: "run privateToken_423",
            expected: "done",
            edge_case: true,
          },
        ],
      },
    });
    const error =
      '{"type":"error","error":{"message":"Unsupported limit","type":"invalid_request_error","param":"max_output_tokens","code":"unsupported_value"},"status":400}';
    store.updateRun(run.id, { status: "failed", error });
    const stage = store.startStage(run.id, "verify", 0);
    const invocation = store.createInvocation({
      runId: run.id,
      stageId: stage.id,
      role: "verify",
      harness: "fake",
      provider: "fake",
      model: "fake",
      modelId: "fake/model",
    });
    store.updateInvocation(invocation.id, { status: "error", error });
    store.addEvent({
      runId: run.id,
      invocationId: invocation.id,
      type: "error",
      level: "error",
      message: error,
    });
    store.addEvent({
      runId: run.id,
      invocationId: invocation.id,
      type: "tool_call",
      level: "info",
      message: "Shell: sed -n 1,20p file",
      data: { input: { command: "sed -n 1,20p file" } },
    });
    const respond = (path: string) =>
      Response.json(path.endsWith("/events") ? store.listEvents(run.id) : store.getRunDetail(run.id));
    for (const command of ["show", "logs"]) {
      const result = await cli([run.id], respond, command);
      expect(result.exit).toBe(0);
      expect(result.stdout).toContain(error);
      expect(result.stdout).not.toContain("[private detail]");
      if (command === "logs") expect(result.stdout).toContain("sed -n 1,20p file");
      else expect(result.stdout.match(/unsupported_value/g)).toHaveLength(2);
    }
  } finally {
    store.close();
  }
});

test("run and retry send repeatable --model chains, show displays them", async () => {
  const flags = [
    "--model",
    "implement=omlx/qwen-flash",
    "--model",
    "review=claude/opus@high|codex/sol,codex/luna",
  ];
  const models = { implement: ["omlx/qwen-flash"], review: ["claude/opus@high|codex/sol", "codex/luna"] };
  const reply = () => Response.json({ id: "new", repoSlug: "o/r", status: "queued" });
  const run = await cli(["Do it", "--repo", "o/r", ...flags], reply, "run");
  expect(run.exit).toBe(0);
  expect(run.seen[0]?.body).toMatchObject({ models });
  const retry = await cli(["run 1", ...flags], reply, "retry");
  expect(retry.exit).toBe(0);
  expect(retry.seen[0]).toMatchObject({ path: "/api/runs/run%201/retry", body: { models } });
  const inherit = await cli(["run 1"], reply, "retry");
  expect(inherit.seen[0]?.body).toEqual({});
  expect(() => parseRunModels(["chat=codex/sol"])).toThrow("Invalid --model");
  expect(() => parseRunModels(["review=codex/sol", "review=claude/opus"])).toThrow("Duplicate");
  const shown = await cli(
    ["run 1"],
    () =>
      Response.json({
        run: {
          id: "run 1",
          title: "Test",
          repoSlug: "o/r",
          status: "queued",
          costUsd: 0,
          costEquivUsd: 0,
          models,
        },
        stages: [],
        invocations: [],
        questions: [],
      }),
    "show",
  );
  expect(shown.exit).toBe(0);
  expect(shown.stdout).toContain("Model experiment: implement = omlx/qwen-flash");
  expect(shown.stdout).toContain("review = claude/opus@high|codex/sol, codex/luna");
});

test("resolve posts the kind, ref and note once and reports the outcome or the daemon's error", async () => {
  const ok = await cli(
    ["run 1", "--as", "done_elsewhere", "--ref", "https://github.com/o/r/pull/9", "--note", "landed by hand"],
    () => Response.json({ id: "run 1", resolution: { kind: "done_elsewhere" } }),
  );
  expect(ok.exit).toBe(0);
  expect(ok.stdout).toContain("Resolved run 1 as done_elsewhere");
  expect(ok.seen).toEqual([
    {
      method: "POST",
      path: "/api/runs/run%201/resolve",
      type: "application/json",
      body: { kind: "done_elsewhere", ref: "https://github.com/o/r/pull/9", note: "landed by hand" },
    },
  ]);

  const conflict = await cli(["r1", "--as", "wont_do"], () =>
    Response.json(
      { error: "run is running; only needs_human and failed runs can be resolved" },
      { status: 409 },
    ),
  );
  expect(conflict.exit).not.toBe(0);
  expect(conflict.stderr).toContain("409: run is running");
  expect(conflict.seen).toEqual([
    { method: "POST", path: "/api/runs/r1/resolve", type: "application/json", body: { kind: "wont_do" } },
  ]);

  const usage = await cli(["r1"], () => Response.json({}));
  expect(usage.exit).not.toBe(0);
  expect(usage.stderr).toContain("usage: limitless resolve");
  expect(usage.seen).toEqual([]);
});

test("review posts findings as a changes verdict, or approves the head the factory last delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-cli-"));
  try {
    const findings = [{ severity: "major", title: "Handle empty input", detail: "It crashes." }];
    const file = join(dir, "findings.json");
    writeFileSync(file, JSON.stringify(findings));
    const sha = "a".repeat(40);
    const round = await cli(
      ["r1", "--changes", file, "--sha", sha],
      () => Response.json({ round: { id: "r2", title: "Review round 1: Add" } }, { status: 201 }),
      "review",
    );
    expect(round.exit).toBe(0);
    expect(round.stdout).toContain("Review round queued: r2");
    expect(round.seen).toEqual([
      {
        method: "POST",
        path: "/api/runs/r1/review",
        type: "application/json",
        body: { verdict: "changes", reviewedSha: sha, findings, reviewer: expect.any(String) },
      },
    ]);

    const delivered = "c".repeat(40);
    const detail = {
      run: { headSha: "b".repeat(40) },
      review: { rounds: [{ deliveredSha: delivered }, {}] },
    };
    const approve = await cli(
      ["r1", "--approve"],
      (path) =>
        Response.json(path.endsWith("/review") ? { approval: { sha: delivered, stale: false } } : detail),
      "review",
    );
    expect(approve.exit).toBe(0);
    expect(approve.stdout).toContain(`Approved ${delivered}`);
    expect(
      approve.seen.map((s) => [s.method, s.path, (s.body as { reviewedSha?: string } | null)?.reviewedSha]),
    ).toEqual([
      ["GET", "/api/runs/r1", undefined],
      ["POST", "/api/runs/r1/review", delivered],
    ]);

    for (const args of [["r1"], ["r1", "--approve", "--changes", file]]) {
      const usage = await cli(args, () => Response.json({}), "review");
      expect(usage.exit).not.toBe(0);
      expect(usage.stderr).toContain("limitless review <run> --changes <findings.json> | --approve");
      expect(usage.seen).toEqual([]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
