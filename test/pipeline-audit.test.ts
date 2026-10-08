import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { CreateRunRequest } from "../src/core/types.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import { mapGitHubEvent } from "../src/integrations/github.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
import { recordingConfinement } from "./confinement.ts";
import { approve, holdout, pass, pipelineSetup, roleOf, spec, triage, waitFor } from "./pipeline-support.ts";
import { findingEvidence } from "./review-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start } = pipelineSetup({
  get home() {
    return home;
  },
  set home(value) {
    home = value;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(value) {
    repoDir = value;
  },
  get factory() {
    return factory;
  },
  set factory(value) {
    factory = value;
  },
});

describe("audit allowances (fake agents, real git)", () => {
  test("private-string audit events and retry feedback redact filenames and values", async () => {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nchecks = [{ name = "test", run = 'for file in *.txt; do if test "$file" != greeting.txt; then echo "$file"; exit 1; fi; done' }]\n`,
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "gate fixture"], {
      cwd: repoDir,
    });
    const prompts: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      prompts.push(s.prompt);
      return { files: { "secret-host.example.txt": "secret-host.example\n" } };
    });
    f.cfg.maxRounds = 1;
    mkdirSync(f.cfg.paths.configDir, { recursive: true });
    writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), "secret-host.example");
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["needs_human", "failed", "succeeded"])).toBe("needs_human");
    const events = f.store.listEvents(run.id).filter((e) => e.type === "audit");
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain("entry 1 in private-strings.txt");
    expect(JSON.stringify(events)).not.toContain("secret-host.example");
    expect(prompts[1]).toContain("entry 1 in private-strings.txt");
    expect(prompts[1]).not.toContain("secret-host.example");
  });

  /** Commits a nested repository into the implementer's worktree, which Git records as a gitlink. */
  const nestedRepository = async (cwd: string) => {
    const nested = join(cwd, "vendor");
    mkdirSync(nested, { recursive: true });
    const git = (...args: string[]) =>
      sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: nested });
    await git("init", "-q", "-b", "main");
    writeFileSync(join(nested, "lib.txt"), `vendored ${Date.now()}\n`);
    await git("add", ".");
    await git("commit", "-qm", "vendored");
  };
  const audits = (f: Factory, runId: string) =>
    f.store
      .listEvents(runId)
      .filter((event) => event.type === "audit" && event.level === "error")
      .map((event) => event.message);

  for (const [name, request, skip, blocked] of [
    ["no opt-in", {}, false, ["gitlink", "gitattributes"]],
    [
      "inline mention",
      { prompt: "Vendor the parser; do not use git submodules or gitattributes" },
      false,
      ["gitlink", "gitattributes"],
    ],
    ["submodules only", { prompt: "Vendor the parser\nAllow: submodules" }, false, ["gitattributes"]],
    ["gitattributes option only", { allow: ["gitattributes"] }, false, ["gitlink"]],
    ["both", { prompt: "Vendor the parser\r\nallow: SUBMODULES", allow: ["gitattributes"] }, false, []],
    ["both with a skipped test", { allow: ["submodules", "gitattributes"] }, true, ["test-skipped"]],
  ] as [string, Partial<CreateRunRequest>, boolean, string[]][]) {
    test(`engine audit honors persisted allowances: ${name}`, async () => {
      const prompts: string[] = [];
      const f = start(async (s): Promise<FakeReply> => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") return { structured: approve };
        prompts.push(s.prompt);
        await nestedRepository(s.cwd);
        return {
          files: {
            ".gitattributes": "*.txt -diff\n",
            "greeting.txt": `vendored ${prompts.length}\n`,
            ...(skip ? { "a.test.ts": 'test.skip("hidden", () => {});\n' } : {}),
          },
        };
      });
      f.cfg.maxRounds = 1;
      const run = await f.createRun({
        repo: repoDir,
        prompt: "Vendor the parser",
        profile: "quick",
        ...request,
      });
      const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human"]);
      expect(status).toBe(blocked.length ? "needs_human" : "succeeded");
      const messages = audits(f, run.id);
      for (const rule of ["gitlink", "gitattributes", "test-skipped"])
        expect([rule, messages.some((m) => m.startsWith(`[${rule}]`))]).toEqual([
          rule,
          blocked.includes(rule),
        ]);
      if (blocked.includes("gitlink")) {
        expect(messages.find((m) => m.startsWith("[gitlink]"))).toContain("Remove the nested repository");
        expect(prompts[1]).toContain("If this is intended, add `Allow: submodules` to the request.");
      }
      if (blocked.includes("gitattributes"))
        expect(prompts[1]).toContain("If this is intended, add `Allow: gitattributes` to the request.");
    });
  }

  for (const allowed of [true, false])
    test(`verification repair audits honor persisted allowances: ${allowed ? "allowed" : "not allowed"}`, async () => {
      const bare = join(home, "github.git");
      await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
      const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
      writeFileSync(join(repoDir, "version.txt"), "dependency 2\n");
      await sh(["git", "add", "."], { cwd: repoDir });
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bump"], {
        cwd: repoDir,
      });
      const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
      await sh(["git", "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir });
      let implementations = 0;
      const f = start(async (s): Promise<FakeReply> => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ task_class: "dependency_update" }) };
        if (role === "review") {
          const findings = implementations
            ? []
            : [
                {
                  severity: "major",
                  file: "version.txt",
                  line: 1,
                  title: "Needs repair",
                  detail: "Repair the update",
                  suggestion: "Vendor the fixed parser",
                  security: false,
                  ...findingEvidence,
                },
              ];
          return { structured: { ...approve, findings } };
        }
        implementations++;
        await nestedRepository(s.cwd);
        return { text: "Vendored the parser" };
      });
      f.deps.gh = async () => {};
      f.cfg.maxRounds = 1;
      f.store.upsertRepo({
        slug: "MattFlower/limitless",
        kind: "github",
        url: bare,
        localPath: null,
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      const payload = JSON.parse(readFileSync(join(import.meta.dir, "data/github-pr.json"), "utf8"));
      payload.pull_request.base.sha = baseSha;
      payload.pull_request.head.sha = head;
      const { request } = mapGitHubEvent("pull_request", payload, "MattFlower");
      if (!request) throw new Error("fixture PR was not mapped");
      // Dependabot never authorizes itself; this persisted allow list stands in for an owner opt-in.
      expect(request.allow).toBeUndefined();
      const run = await f.createRun({ ...request, ...(allowed ? { allow: ["submodules"] } : {}) }, true);
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        allowed ? "succeeded" : "needs_human",
      );
      expect(f.store.getRunState<RunState>(run.id)?.flow).toBe("verify-change");
      const messages = audits(f, run.id);
      expect(messages.some((m) => m.startsWith("[gitlink] vendor: Repair: vendor"))).toBe(!allowed);
      expect(messages.some((m) => m.startsWith("[gitlink] vendor: vendor"))).toBe(!allowed);
    });
});

test("factory gates use injected confinement with the platform forced off macOS", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("missing platform descriptor");
  const recording = recordingConfinement();
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    f.deps.confinement = recording.backend;
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(recording.calls.length).toBeGreaterThan(0);
    for (const { roots, opts } of recording.calls) {
      expect(roots.write).toContain(opts.cwd);
      expect(roots.write).toContain(opts.env.TMPDIR ?? "missing");
      expect(roots.protect).toContain(join(opts.cwd, ".git"));
      expect(roots.protect.some((p) => p.includes("/worktrees/"))).toBe(true);
      expect(opts.env.LIMITLESS_CONFINED).toBe("1");
      expect(opts.env.GIT_OPTIONAL_LOCKS).toBe("0");
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
