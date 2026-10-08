import { describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Factory } from "../src/app.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { buildPublicationReport } from "../src/pipeline/report.ts";
import * as proc from "../src/util/proc.ts";
import { sh } from "../src/util/proc.ts";
import { deferred } from "./evals-support.ts";
import { approve, holdout, pass, pipelineSetup, roleOf, spec, triage, waitFor } from "./pipeline-support.ts";
import { findingEvidence } from "./review-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, githubFixture, registerGithub } = pipelineSetup({
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

describe("pipeline (fake agents, real git + gates)", () => {
  test.each(["met", "blocked"] as const)(
    "%s verifier wording is redacted only in GitHub report copies",
    async (status) => {
      const bare = await githubFixture();
      const secret = "PrivateScenario_423";
      const observed = "ERR_OBSERVED_423 --private-mode 48231";
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout")
          return {
            structured: {
              scenarios: holdout.scenarios.map((c) =>
                c.id === "H-2" ? { ...c, description: `private ${secret}`, steps: `run ${secret}` } : c,
              ),
            },
          };
        if (role === "review") return { structured: approve };
        if (role === "verify")
          return {
            structured: {
              ...pass,
              criteria: [
                ...pass.criteria.map((c) =>
                  c.id === "H-2" ? { ...c, status, evidence: `Observed ${secret}: ${observed}` } : c,
                ),
                ...(status === "blocked"
                  ? [
                      {
                        id: "PrivateUnknown_423",
                        status,
                        evidence: "unexpected private evidence prose",
                        publicSummary: "",
                      },
                    ]
                  : []),
              ],
            },
          };
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell" });
      expect(await waitFor(f, run.id, ["succeeded", "needs_human", "failed"])).toBe(
        status === "met" ? "succeeded" : "needs_human",
      );
      const body = readFileSync(join(home, "gh-body"), "utf8");
      expect(body).toContain("[private detail]");
      for (const literal of [secret, "ERR_OBSERVED_423", "--private-mode", "48231"])
        expect(body).not.toContain(literal);
      expect(body).not.toContain("PrivateUnknown_423");
      expect(body).not.toContain("unexpected private evidence prose");
      const report = f.store.getArtifact(run.id, "report.md");
      expect(report).toContain(secret);
      expect(report).toContain(observed);
      const source = f.store.getRunState<RunState>(run.id);
      if (!source) throw new Error("missing run state");
      expect(source.lastVerify?.criteria[2]?.evidence).toBe(`Observed ${secret}: ${observed}`);
      if (status === "blocked") {
        expect(f.store.getRun(run.id)?.error).toContain(observed);
        expect(f.store.getRun(run.id)?.error).toContain("unexpected private evidence prose");
      }
      const repo = f.store.getRepo(run.repoId);
      if (!repo) throw new Error("missing repo");
      const ctx = new RunContext(f.deps, run, repo, new AbortController().signal);
      expect(await buildPublicationReport(ctx, status === "met")).not.toContain(secret);
      expect(f.store.getRunState<RunState>(run.id)).toEqual(source);
      expect(ctx.state).toEqual(source);
    },
  );

  test.each([
    "commit",
    "title",
    "body",
    "draft-body",
    "unreadable",
    "branch",
    "history",
    "message-body",
    "encoded-body",
    "draft-history",
    "lfs-history",
    "cache-config",
    "author-email",
    "utf16-author-email",
    "utf16-message-body",
  ])("private strings stop %s delivery before any push", async (scenario) => {
    const bare = await githubFixture();
    const entry = scenario === "branch" ? "secret-host-example" : "secret-host.example";
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage")
        return {
          structured: triage({
            title: scenario === "title" ? entry : "Add farewell",
            suggested_profile: "quick",
          }),
        };
      if (role === "review") {
        if (scenario === "unreadable") {
          rmSync(join(home, "cfg", "private-strings.txt"));
          mkdirSync(join(home, "cfg", "private-strings.txt"));
        }
        return {
          structured: ["draft-body", "draft-history"].includes(scenario)
            ? {
                ...approve,
                verdict: "request_changes",
                summary: scenario === "draft-body" ? entry : "Repair required",
                findings: [
                  {
                    label: "new",
                    prior: "",
                    severity: "blocker",
                    security: false,
                    ...findingEvidence,
                    file: "farewell.txt",
                    line: 1,
                    title: "Fix",
                    detail: "Fix",
                    suggestion: "Fix",
                  },
                ],
              }
            : approve,
        };
      }
      if (scenario.startsWith("utf16-"))
        await sh(["git", "config", "i18n.logOutputEncoding", "UTF-16"], { cwd: s.cwd });
      if (
        ["history", "message-body", "utf16-message-body", "draft-history", "lfs-history"].includes(scenario)
      ) {
        let content = scenario.endsWith("message-body") ? "safe" : entry;
        if (scenario === "lfs-history") {
          const oid = createHash("sha256").update(entry).digest("hex");
          const common = (await sh(["git", "rev-parse", "--git-common-dir"], { cwd: s.cwd })).stdout.trim();
          const object = resolve(s.cwd, common, "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);
          mkdirSync(dirname(object), { recursive: true });
          writeFileSync(object, entry);
          content = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${entry.length}\n`;
        }
        writeFileSync(join(s.cwd, "transient.txt"), content);
        await sh(["git", "add", "."], { cwd: s.cwd });
        await sh(
          [
            "git",
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            scenario.endsWith("message-body") ? `Safe subject\n\n${entry}` : "safe",
          ],
          { cwd: s.cwd },
        );
        rmSync(join(s.cwd, "transient.txt"));
        await sh(["git", "add", "."], { cwd: s.cwd });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "remove transient"], {
          cwd: s.cwd,
        });
      }
      if (["commit", "author-email", "utf16-author-email"].includes(scenario)) {
        writeFileSync(join(s.cwd, "farewell.txt"), "goodbye\n");
        await sh(["git", "add", "."], { cwd: s.cwd });
        await sh(
          [
            "git",
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            scenario === "commit" ? entry.toUpperCase() : "safe",
          ],
          {
            cwd: s.cwd,
            env: {
              ...process.env,
              ...(scenario.endsWith("author-email")
                ? { GIT_AUTHOR_NAME: "Fake", GIT_AUTHOR_EMAIL: `fake@${entry}` }
                : {}),
            },
          },
        );
      }
      return {
        files: { "farewell.txt": "goodbye\n" },
        text: scenario === "body" ? entry : scenario === "encoded-body" ? "%73ecret-host.example" : "Done",
      };
    });
    f.cfg.maxRounds = 1;
    if (scenario === "cache-config") f.cfg.paths.configDir = join(f.cfg.paths.repos, "config");
    mkdirSync(f.cfg.paths.configDir, { recursive: true });
    writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), entry);
    registerGithub(f, bare);
    const calls: string[] = [];
    const originalGit = Bun.which("git");
    if (!originalGit) throw new Error("git unavailable");
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = push ] && echo push >> '${join(home, "push-calls")}'; done\nexec '${originalGit}' "$@"\n`,
      { mode: 0o755 },
    );
    const run = await f.createRun({
      repo: "test/repo",
      prompt: scenario === "branch" ? "Secret Host Example" : "Add farewell",
      profile: "quick",
    });
    expect(await waitFor(f, run.id, ["needs_human", "failed", "succeeded"])).toBe(
      scenario === "cache-config" ? "failed" : "needs_human",
    );
    expect(existsSync(join(home, "push-calls"))).toBe(false);
    expect(f.store.getRun(run.id)?.prUrl).toBeNull();
    const error = f.store.getRun(run.id)?.error ?? "";
    expect(error.toLowerCase()).not.toContain(entry);
    if (scenario.endsWith("author-email")) expect(error).toContain("author email");
    if (scenario === "cache-config") expect(error).toContain("inside repository");
    else if (scenario !== "unreadable") expect(error).toContain("entry 1 in private-strings.txt");
    calls.push(
      ...f.store
        .listEvents(run.id)
        .filter((e) => e.type === "status" || e.type === "error")
        .map((e) => e.message),
    );
    expect(calls.join("\n").toLowerCase()).not.toContain(entry);
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).toBe("");
  });

  test.each(["diff", "publication"])("run cancellation stops the production %s blob scan", async (stage) => {
    const bare = await githubFixture();
    let armed = false;
    const reached = deferred<AbortSignal>();
    const stopped = deferred<proc.ProcResult>();
    let child: ChildProcess | undefined;
    let closed: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pushed = join(home, "push-calls");
    const gitBin = Bun.which("git");
    if (!gitBin) throw new Error("missing git");
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        if (stage === "publication") armed = true;
        return { structured: approve };
      }
      if (stage === "diff") armed = true;
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    mkdirSync(f.cfg.paths.configDir, { recursive: true });
    writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), "secret-host.example");
    registerGithub(f, bare);
    writeFileSync(
      join(home, "bin", "git"),
      `#!/bin/sh
for arg in "$@"; do [ "$arg" = push ] && echo push >> '${pushed}'; done
exec '${gitBin}' "$@"
`,
      { mode: 0o755 },
    );
    const realProcess = proc.runProcess;
    const scan = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
      if (!armed || opts.cmd.join(" ") !== "git --no-replace-objects cat-file --batch")
        return realProcess(opts);
      const scope = proc.processScope.getStore();
      if (!scope) throw new Error("blob scan missing run process scope");
      armed = false;
      const existing = new Set(scope.children.keys());
      // Keep the production sh/runProcess cancellation path; only replace the scan executable.
      // The child stays alive after stdin closes and announces readiness from inside the process.
      const running = realProcess({
        ...opts,
        cmd: [process.execPath, "-e", 'setInterval(() => {}, 60_000); console.log("scan-ready");'],
        timeoutMs: undefined,
        onStdoutLine: (line) => {
          if (line === "scan-ready") reached.resolve(scope.signal);
        },
      });
      child = [...scope.children.keys()].find((candidate) => !existing.has(candidate));
      if (!child) throw new Error("blob scan child not registered");
      closed = scope.children.get(child);
      const result = await running;
      stopped.resolve(result);
      return result;
    });
    try {
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      const signal = await reached.promise;
      const activeStage = f.store.listStages(run.id).at(-1);
      if (!activeStage) throw new Error("blob scan missing active stage");
      expect(activeStage).toMatchObject({ name: stage === "diff" ? "gates" : "deliver", status: "running" });
      if (!child?.pid) throw new Error("blob scan child missing pid");
      const pid = child.pid;
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(signal.aborted).toBe(false);
      expect(f.cancelRun(run.id)).toBe(true);
      expect(signal.aborted).toBe(true);
      // A watchdog bounds broken cancellation; readiness and exit, not elapsed time, order the test.
      const result = await Promise.race([
        stopped.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("running blob scan survived cancellation")), 10_000);
        }),
      ]);
      clearTimeout(timer);
      expect(result.cancelled).toBe(true);
      expect(result.signal === "SIGTERM" || result.signal === "SIGKILL").toBe(true);
      expect(child.signalCode === "SIGTERM" || child.signalCode === "SIGKILL").toBe(true);
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(await waitFor(f, run.id, ["cancelled", "failed", "needs_human", "succeeded"])).toBe("cancelled");
      expect(f.store.getStage(activeStage.id)?.status).toBe("cancelled");
      expect(f.store.getRun(run.id)?.status).toBe("cancelled");
      expect(existsSync(pushed)).toBe(false);
      expect(existsSync(join(home, "gh-calls"))).toBe(false);
    } finally {
      clearTimeout(timer);
      // Reap only our controlled child, including when a cancellation mutation leaves it blocked.
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      try {
        await f.stop();
      } finally {
        scan.mockRestore();
      }
    }
  });

  test("private strings outside the published range permit clean delivery", async () => {
    writeFileSync(join(repoDir, "old.txt"), "secret-host.example");
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "secret-host.example"], {
      cwd: repoDir,
    });
    rmSync(join(repoDir, "old.txt"));
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "removed"], {
      cwd: repoDir,
    });
    const bare = await githubFixture();
    const f = start((s) => {
      if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (roleOf(s) === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    mkdirSync(f.cfg.paths.configDir, { recursive: true });
    writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), "secret-host.example");
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(f.store.getRun(run.id)?.prUrl).toBe("https://github.com/test/repo/pull/1");
  });

  test("private strings stop existing-branch delivery before pushing repairs", async () => {
    const bare = await githubFixture();
    const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: repoDir })).stdout.trim();
    const base = await git("rev-parse", "HEAD");
    writeFileSync(join(repoDir, "version.txt"), "dependency 2\n");
    await git("add", ".");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "dependency update");
    const head = await git("rev-parse", "HEAD");
    await git("push", bare, "HEAD:refs/heads/dependabot/pkg");
    let reviews = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ task_class: "dependency_update" }) };
      if (role === "review")
        return {
          structured: reviews++
            ? approve
            : {
                ...approve,
                verdict: "request_changes",
                findings: [
                  {
                    ...findingEvidence,
                    severity: "major",
                    security: false,
                    file: "version.txt",
                    line: 1,
                    title: "Repair",
                    detail: "Repair",
                    suggestion: "Repair",
                  },
                ],
              },
        };
      return { files: { "farewell.txt": "goodbye\n" }, text: "secret-host.example" };
    });
    mkdirSync(f.cfg.paths.configDir, { recursive: true });
    writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), "secret-host.example");
    registerGithub(f, bare);
    const run = await f.createRun(
      {
        repo: "test/repo",
        prompt: "Repair dependency",
        profile: "quick",
        source: "github",
        requestedBy: "dependabot[bot]",
        baseBranch: "dependabot/pkg",
        deliveryBranch: "dependabot/pkg",
        sourceRef: {
          kind: "pull_request",
          repo: "test/repo",
          number: 1,
          headSha: head,
          baseSha: base,
          baseRef: "main",
        },
      },
      true,
    );
    expect(await waitFor(f, run.id, ["needs_human", "failed", "succeeded"])).toBe("needs_human");
    expect(reviews).toBe(2);
    expect(await git("ls-remote", bare, "refs/heads/dependabot/pkg")).toContain(head);
    expect(f.store.getRun(run.id)?.error).toContain("PR body contains a private string (entry 1");
    expect(f.store.getRun(run.id)?.error).not.toContain("secret-host.example");
  });
});
