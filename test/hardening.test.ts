// Regression tests for defects found by the cross-vendor (Codex) review of the M1 core.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { auditDiff } from "../src/gates/audit.ts";
import { gateScriptNames, pickScripts } from "../src/gates/detect.ts";
import { compareGates } from "../src/gates/run.ts";
import { parseNameStatus, resolveRepo } from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { startHttp } from "../src/server/http.ts";
import { runProcess, sh } from "../src/util/proc.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-hard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };

describe("process handling", () => {
  test("a child that exits before reading stdin does not crash us (EPIPE)", async () => {
    const res = await runProcess({
      cmd: ["/bin/sh", "-c", "exit 3"],
      cwd: dir,
      env: process.env as Record<string, string>,
      stdin: "x".repeat(5_000_000),
    });
    expect(res.exitCode).toBe(3);
  });

  test("background processes left by the child are reaped", async () => {
    const marker = join(dir, "alive");
    await runProcess({
      cmd: ["/bin/sh", "-c", `(sleep 2; touch ${marker}) >/dev/null 2>&1 & exit 0`],
      cwd: dir,
      env: process.env as Record<string, string>,
    });
    await Bun.sleep(2500);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("sh refuses to return truncated output", async () => {
    const res = await sh(["/bin/sh", "-c", "head -c 70000 /dev/zero | tr '\\0' a"], { cwd: dir });
    expect(res.stdout.length).toBe(70_000);
  });
});

describe("repos", () => {
  test("two local repos with the same basename get distinct slugs", async () => {
    const store = new Store(join(dir, "db.sqlite"));
    for (const p of ["a/service", "b/service"]) {
      mkdirSync(join(dir, p), { recursive: true });
      await sh(["git", "init", "-q"], { cwd: join(dir, p) });
    }
    const a = await resolveRepo(store, join(dir, "a/service"));
    const b = await resolveRepo(store, join(dir, "b/service"));
    expect(a.id).not.toBe(b.id);
    expect(b.localPath).toBe(join(dir, "b/service"));
    expect((await resolveRepo(store, join(dir, "b/service"))).id).toBe(b.id);
    store.close();
  });

  test("name-status keeps both sides of a rename", () => {
    expect(parseNameStatus("R100\tprotected/x.test.ts\tsrc/disabled.txt\nM\ta.ts\n")).toEqual([
      { status: "R100", path: "src/disabled.txt", from: "protected/x.test.ts" },
      { status: "M", path: "a.ts" },
    ]);
  });
});

describe("audit hardening", () => {
  const diff = (files: ReturnType<typeof parseNameStatus>, patch = "") => ({
    patch,
    files,
    stat: "",
    added: 0,
    removed: 0,
  });

  test("renaming a protected file or moving a test out of the runner's reach is blocked", () => {
    const f = auditDiff(diff(parseNameStatus("R100\tprotected/x.test.ts\tsrc/disabled.txt")), {
      taskClass: "feature",
      protectedPaths: ["protected/**"],
    });
    const rules = f.map((x) => `${x.rule}:${x.severity}`);
    expect(rules).toContain("protected-path:block");
    expect(rules).toContain("test-moved-out:block");
  });

  test("changing a script a gate runs is blocked", () => {
    const f = auditDiff(diff([{ status: "M", path: "package.json" }]), {
      taskClass: "bugfix",
      protectedPaths: [],
      gateScripts: {
        before: { test: "bun test", lint: "biome check ." },
        after: { test: "true", lint: "biome check ." },
      },
    });
    expect(f).toEqual([
      {
        rule: "gate-script-changed",
        severity: "block",
        file: "package.json",
        detail: 'Changed the "test" script that a factory check runs ("bun test" → "true").',
      },
    ]);
  });

  test("skip markers inside string literals are not flagged", () => {
    const patch = [
      "diff --git a/t/a.test.ts b/t/a.test.ts",
      "+++ b/t/a.test.ts",
      `+  const src = "it.skip('x', () => {})";`,
    ].join("\n");
    const f = auditDiff(diff([{ status: "M", path: "t/a.test.ts" }], patch), {
      taskClass: "test",
      protectedPaths: [],
    });
    expect(f.find((x) => x.rule === "test-skipped")).toBeUndefined();
  });

  test("gate script names come from the gate commands", () => {
    const names = gateScriptNames({
      setup: ["bun install --frozen-lockfile"],
      checks: [
        { name: "lint", run: "bun run lint" },
        { name: "t", run: "npm test" },
        { name: "b", run: "bun test" },
      ],
      source: "detected",
      protectedPaths: [],
    });
    expect(names.sort()).toEqual(["lint", "test"]);
    expect(pickScripts(JSON.stringify({ scripts: { lint: "biome", other: "x" } }), ["lint", "test"])).toEqual(
      {
        lint: "biome",
      },
    );
  });

  test("setup failing after the change blocks, even if it also failed before", () => {
    const r = (name: string, ok: boolean) => ({
      name,
      command: name,
      ok,
      exitCode: ok ? 0 : 1,
      durationMs: 1,
      output: "",
    });
    const cmp = compareGates(
      { setupOk: false, setup: [r("setup", false)], checks: [r("test", true)] },
      { setupOk: false, setup: [r("setup", false)], checks: [] },
    );
    expect(cmp.every((c) => c.blocking)).toBe(true);
    expect(cmp.map((c) => c.verdict)).toEqual(["regressed", "not_run"]);
  });
});

describe("provider tracker hardening", () => {
  test("a cancelled waiter does not strand the next one", async () => {
    const store = new Store(join(dir, "db.sqlite"));
    const tracker = new ProviderTracker(
      [{ id: "p", label: "p", harness: "fake", billing: "free", maxConcurrent: 1 }],
      store,
      reserves,
      {},
    );
    const release = await tracker.acquire("p", new AbortController().signal);
    const cancelled = new AbortController();
    const first = tracker.acquire("p", cancelled.signal).catch(() => "cancelled");
    let secondGot = false;
    const second = tracker.acquire("p", new AbortController().signal).then((r) => {
      secondGot = true;
      return r;
    });
    cancelled.abort();
    expect(await first).toBe("cancelled");
    release();
    const release2 = await second;
    expect(secondGot).toBe(true);
    release2();
    store.close();
  });

  test("a zero budget means the provider is never used", () => {
    const store = new Store(join(dir, "db.sqlite"));
    const tracker = new ProviderTracker(
      [{ id: "or", label: "or", harness: "claude", billing: "metered", maxConcurrent: 1 }],
      store,
      reserves,
      {},
      { or: 0 },
    );
    expect(tracker.unavailableReason("or")).toBe("at reserve limit");
    store.close();
  });
});

describe("HTTP API", () => {
  test("refuses cross-origin and non-JSON mutations", async () => {
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg"), port: 0 });
    const factory = new Factory(cfg, { harnesses: { fake: fakeHarness(() => ({})) } });
    const server = startHttp(factory);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const evil = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ repo: "x/y", prompt: "rm -rf" }),
      });
      expect(evil.status).toBe(403);
      const textPlain = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ repo: "x/y", prompt: "p" }),
      });
      expect(textPlain.status).toBe(415);
      const tunnel = await fetch(`${base}/api/runs`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
      expect(tunnel.status).toBe(403);
      const ok = await fetch(`${base}/api/runs`);
      expect(ok.status).toBe(200);
    } finally {
      await server.stop(true);
      factory.store.close();
    }
  });
});

describe("pipeline hardening", () => {
  async function setupRepo(files: Record<string, string>): Promise<string> {
    const repo = join(dir, "target");
    mkdirSync(repo);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(repo, p), c);
    await sh(["git", "init", "-q", "-b", "main"], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
    return repo;
  }

  const providers = [
    { id: "a", label: "a", harness: "fake" as const, billing: "subscription" as const, maxConcurrent: 2 },
    { id: "b", label: "b", harness: "fake" as const, billing: "subscription" as const, maxConcurrent: 2 },
  ];
  const models = [
    {
      id: "a/m",
      provider: "a",
      model: "a",
      vendor: "anthropic" as const,
      tier: 4 as const,
      price: { input: 0, output: 0 },
    },
    {
      id: "b/m",
      provider: "b",
      model: "b",
      vendor: "openai" as const,
      tier: 4 as const,
      price: { input: 0, output: 0 },
    },
  ];
  const everyone = { default: ["a/m", "b/m"] };
  const policy = {
    triage: everyone,
    spec: everyone,
    implement: everyone,
    review: everyone,
    verify: everyone,
  } as never;

  const role = (prompt: string) =>
    prompt.startsWith("Classify")
      ? "triage"
      : prompt.startsWith("Write the specification")
        ? "spec"
        : prompt.startsWith("You are an adversarial")
          ? "review"
          : prompt.startsWith("You are the acceptance verifier")
            ? "verify"
            : "implement";

  async function waitDone(f: Factory, id: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const s = f.store.getRun(id)?.status as string;
      if (["succeeded", "failed", "needs_human", "cancelled"].includes(s)) return s;
      if (Date.now() > deadline) throw new Error(`timeout (${s})`);
      await Bun.sleep(25);
    }
  }

  test("a verifier that skips criteria cannot pass, and an 'approve' with a blocker is a rejection", async () => {
    const repo = await setupRepo({ "a.txt": "a\n" });
    let verifies = 0;
    let reviews = 0;
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
    const f = new Factory(cfg, {
      providers,
      models,
      policy,
      harnesses: {
        fake: fakeHarness((s) => {
          const r = role(s.prompt);
          if (r === "triage")
            return {
              structured: {
                title: "t",
                task_class: "feature",
                complexity: "small",
                risk: "low",
                ambiguity: "low",
                blocking_questions: [],
                summary: "s",
                suggested_profile: "standard",
              },
            };
          if (r === "spec")
            return {
              structured: {
                summary: "s",
                assumptions: [],
                requirements: [],
                acceptance_criteria: [
                  { id: "AC-1", criterion: "one", how_to_verify: "x" },
                  { id: "AC-2", criterion: "two", how_to_verify: "y" },
                ],
                out_of_scope: [],
                blocking_questions: [],
              },
            };
          if (r === "review") {
            reviews++;
            return {
              structured: {
                verdict: "approve",
                summary: "fine",
                findings:
                  reviews === 1
                    ? [
                        {
                          severity: "blocker",
                          file: "a.txt",
                          line: 1,
                          title: "broken",
                          detail: "d",
                          suggestion: "s",
                        },
                      ]
                    : [],
              },
            };
          }
          if (r === "verify") {
            verifies++;
            // First verifier only reports AC-1 and claims "pass"; second covers both.
            return {
              structured:
                verifies === 1
                  ? { criteria: [{ id: "AC-1", status: "met", evidence: "e" }], overall: "pass", notes: "" }
                  : {
                      criteria: [
                        { id: "AC-1", status: "met", evidence: "e" },
                        { id: "AC-2", status: "met", evidence: "e" },
                      ],
                      overall: "pass",
                      notes: "",
                    },
            };
          }
          return { files: { "a.txt": `a${Math.random()}\n` } };
        }),
      },
    });
    f.start();
    try {
      const run = await f.createRun({ repo, prompt: "change a" });
      expect(await waitDone(f, run.id)).toBe("succeeded");
      expect(reviews).toBe(3); // round 0 rejected (blocker), round 1 approved, round 2 approved
      expect(verifies).toBe(2); // round 1 verify incomplete → fail, round 2 pass
      const verify1 = JSON.parse(f.store.getArtifact(run.id, "verify-1.json") as string);
      expect(verify1.overall).toBe("fail");
      expect(verify1.criteria.find((c: { id: string }) => c.id === "AC-2").status).toBe("unclear");
    } finally {
      await f.stop();
      f.store.close();
    }
  });

  test("weakening the test script is caught even though gates then pass", async () => {
    const repo = await setupRepo({
      "package.json": JSON.stringify({ scripts: { test: "exit 1" } }),
      ".limitless.toml": '[gates]\nchecks = [{ name = "test", run = "npm run test" }]\n',
    });
    let rounds = 0;
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
    const f = new Factory(cfg, {
      providers,
      models,
      policy,
      harnesses: {
        fake: fakeHarness((s) => {
          const r = role(s.prompt);
          if (r === "triage")
            return {
              structured: {
                title: "t",
                task_class: "bugfix",
                complexity: "small",
                risk: "low",
                ambiguity: "low",
                blocking_questions: [],
                summary: "s",
                suggested_profile: "quick",
              },
            };
          if (r === "review") return { structured: { verdict: "approve", summary: "ok", findings: [] } };
          rounds++;
          return { files: { "package.json": JSON.stringify({ scripts: { test: "true" } }) } };
        }),
      },
    });
    f.start();
    try {
      const run = await f.createRun({ repo, prompt: "make the tests pass" });
      expect(await waitDone(f, run.id)).toBe("needs_human");
      const events = f.store.listEvents(run.id, { limit: 5000 });
      expect(events.some((e) => e.type === "audit" && e.message.includes("gate-script-changed"))).toBe(true);
      expect(rounds).toBeGreaterThan(1);
    } finally {
      await f.stop();
      f.store.close();
    }
  });
});

describe("resume after restart", () => {
  test("a restart during review resumes at the checks without re-implementing", async () => {
    const repo = join(dir, "target");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await sh(["git", "init", "-q", "-b", "main"], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });

    const providers = [
      { id: "a", label: "a", harness: "fake" as const, billing: "free" as const, maxConcurrent: 2 },
    ];
    const models = [
      {
        id: "a/m",
        provider: "a",
        model: "a",
        vendor: "anthropic" as const,
        tier: 4 as const,
        price: { input: 0, output: 0 },
      },
    ];
    const everyone = { default: ["a/m"] };
    const policy = { triage: everyone, implement: everyone, review: everyone } as never;
    let implementCalls = 0;
    let reviewDelay = 30_000;
    const harness = fakeHarness((s) => {
      if (s.prompt.startsWith("Classify"))
        return {
          structured: {
            title: "t",
            task_class: "feature",
            complexity: "small",
            risk: "low",
            ambiguity: "low",
            blocking_questions: [],
            summary: "s",
            suggested_profile: "quick",
          },
        };
      if (s.prompt.startsWith("You are an adversarial"))
        return { delayMs: reviewDelay, structured: { verdict: "approve", summary: "ok", findings: [] } };
      implementCalls++;
      return { files: { "b.txt": "b\n" } };
    });
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });

    const first = new Factory(cfg, { providers, models, policy, harnesses: { fake: harness } });
    first.start();
    const run = await first.createRun({ repo, prompt: "add b" });
    const deadline = Date.now() + 10_000;
    while (first.store.getRun(run.id)?.stage !== "review" && Date.now() < deadline) await Bun.sleep(20);
    await first.stop(); // simulated restart mid-review
    expect(first.store.getRun(run.id)?.status).toBe("queued");
    first.store.close();

    reviewDelay = 0;
    const second = new Factory(cfg, { providers, models, policy, harnesses: { fake: harness } });
    second.start();
    try {
      const end = Date.now() + 10_000;
      while (second.store.getRun(run.id)?.status !== "succeeded" && Date.now() < end) await Bun.sleep(20);
      expect(second.store.getRun(run.id)?.status).toBe("succeeded");
      expect(implementCalls).toBe(1);
    } finally {
      await second.stop();
      second.store.close();
    }
  });
});

describe("repo cache concurrency", () => {
  test("concurrent runs share one clone of a remote repo", async () => {
    const { ensureCache } = await import("../src/git/repos.ts");
    const origin = join(dir, "origin");
    mkdirSync(origin);
    writeFileSync(join(origin, "a.txt"), "a\n");
    await sh(["git", "init", "-q", "-b", "main"], { cwd: origin });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: origin });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: origin });
    const paths = {
      home: dir,
      db: "",
      repos: join(dir, "repos"),
      work: join(dir, "work"),
      runs: "",
      configDir: "",
    };
    const repo = {
      id: "r",
      slug: "o/origin",
      kind: "github" as const,
      url: origin,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr" as const,
      createdAt: 0,
    };
    const caches = await Promise.all([
      ensureCache(paths, repo),
      ensureCache(paths, repo),
      ensureCache(paths, repo),
    ]);
    for (const c of caches) {
      const r = await sh(["git", "rev-parse", "origin/main"], { cwd: c });
      expect(r.stdout.trim()).toHaveLength(40);
    }
  });
});

test("adding a file under a protected path warns; editing one blocks", () => {
  const f = auditDiff(
    {
      patch: "",
      files: [
        { status: "A", path: "test/fixtures/new.json" },
        { status: "M", path: "test/fixtures/old.json" },
      ],
      stat: "",
      added: 0,
      removed: 0,
    },
    { taskClass: "feature", protectedPaths: ["test/fixtures/**"] },
  );
  expect(f.map((x) => `${x.file}:${x.severity}`)).toEqual([
    "test/fixtures/new.json:warn",
    "test/fixtures/old.json:block",
  ]);
});
