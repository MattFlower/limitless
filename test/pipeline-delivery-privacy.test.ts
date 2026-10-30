import { describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { Repo } from "../src/core/types.ts";
import { checkPrivateText } from "../src/gates/private.ts";
import * as repos from "../src/git/repos.ts";
import {
  checkPrivatePublication,
  checkPrivateRange,
  deliveryPublicationRange,
  mergePullRequest,
  pushExistingBranch,
} from "../src/git/repos.ts";
import { processConflictTriggers } from "../src/pipeline/conflict-round.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { reportStructure } from "../src/pipeline/report-privacy.ts";
import * as proc from "../src/util/proc.ts";
import { sh } from "../src/util/proc.ts";
import { deferred } from "./evals-support.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { expectProcessStopped } from "./process-support.ts";
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
  test.each([false, true])("iteration privacy follows the final tree (retained=%s)", async (retained) => {
    const bare = await githubFixture();
    const secret = `private-${crypto.randomUUID()}.example`;
    let implementations = 0;
    let superseded = "";
    let blob = "";
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      if (++implementations === 2) {
        superseded = await repos.headSha(s.cwd);
        blob = (await sh(["git", "rev-parse", "HEAD:config.txt"], { cwd: s.cwd })).stdout.trim();
      }
      return {
        files: {
          "farewell.txt": implementations === 1 ? "BAD\n" : "goodbye\n",
          "config.txt": implementations === 1 || retained ? `${secret}\n` : "public.example\n",
        },
      };
    });
    mkdirSync(f.cfg.paths.configDir, { recursive: true });
    writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), secret);
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
      retained ? "needs_human" : "succeeded",
    );
    const done = f.store.getRun(run.id);
    const state = f.store.getRunState<RunState>(run.id);
    if (!done?.headSha || !state?.worktreePath) throw new Error("Missing iteration state");
    const cwd = retained ? state.worktreePath : bare;
    const range = `${done.baseSha}..${done.headSha}`;
    expect((await sh(["git", "rev-list", "--count", "--no-merges", range], { cwd })).stdout.trim()).toBe("1");
    if (retained) {
      expect(done.error).toContain("private string");
      await expect(checkPrivateRange(cwd, range, [{ value: secret, entry: 1 }])).rejects.toThrow(
        "private string",
      );
      expect(
        (await sh(["git", "show-ref", `refs/heads/${done.branch}`], { cwd: bare, allowFail: true })).exitCode,
      ).not.toBe(0);
    } else {
      expect(implementations).toBe(2);
      await checkPrivateRange(cwd, range, [{ value: secret, entry: 1 }]);
      expect(state.gateEvidence?.sha).toBe(done.headSha);
      expect((await sh(["git", "rev-parse", `refs/heads/${done.branch}`], { cwd: bare })).stdout.trim()).toBe(
        done.headSha,
      );
      expect((await sh(["git", "show", `${done.headSha}:farewell.txt`], { cwd: bare })).stdout).toBe(
        "goodbye\n",
      );
    }
    for (const object of [superseded, blob]) {
      expect(object).toMatch(/^[a-f0-9]{40,64}$/);
      expect((await sh(["git", "cat-file", "-e", object], { cwd: bare, allowFail: true })).exitCode).not.toBe(
        0,
      );
    }
  });

  test.each(["PR", "verified draft"])(
    "%s bodies sanitize paths before summary cuts and privacy checks",
    async (mode) => {
      const bare = await githubFixture();
      const secret = "SYNTHETIC_PUBLICATION_CREDENTIAL_582";
      proc.registerCredential("publication-test", secret);
      let implementations = 0;
      const f = start((s) => {
        if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (roleOf(s) === "review") {
          if (mode === "verified draft") {
            const fetch = spyOn(repos, "fetchBase");
            fetch.mockImplementationOnce(async () => {
              fetch.mockRestore();
              throw new Error("Synthetic delivery failure after verification");
            });
          }
          return { structured: approve };
        }
        const text = `[farewell](${s.cwd}/farewell.txt) \`${s.cwd}/farewell.txt\` [log](${f.cfg.paths.home}/runs/log.txt) ${secret}`;
        return {
          files: { "farewell.txt": `goodbye ${++implementations}\n` },
          text: `${text.padEnd(4990, "x")} ${s.cwd}/farewell.txt ${"tail ".repeat(200)}`,
        };
      });
      mkdirSync(f.cfg.paths.configDir, { recursive: true });
      writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), f.cfg.paths.home);
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        mode === "PR" ? "succeeded" : "needs_human",
      );
      const expected = "[farewell.txt](farewell.txt) `farewell.txt` <data>/runs/log.txt [redacted]";
      const body = readFileSync(join(home, "gh-body"), "utf8");
      expect(body).toContain(expected);
      expect(body).not.toContain(home.slice(0, 8));
      expect(body).not.toContain(secret);
      const summary = body.split("## Implementer's summary\n\n")[1]?.split("\n\n##")[0] ?? "";
      expect(summary).toHaveLength(5000);
      const report = f.store.getArtifact(run.id, "report.md") ?? "";
      const structure = reportStructure(report);
      expect(structure).toBeTruthy();
      expect(structure?.spans.some((span) => span.kind === "implementer" && span.clipped)).toBe(true);
      await f.stop();
      if (mode === "verified draft") {
        expect(body).toContain("Failed after verification");
        expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
        return;
      }

      const owner = f.store.getRun(run.id);
      if (!owner?.prUrl || !owner.branch || !owner.headSha) throw new Error("Missing delivered PR");
      const comments: string[] = [];
      f.deps.gh = async (args, _signal, stdin) => {
        if (args[1] === "comment") {
          comments.push(stdin ?? "");
          return "";
        }
        if (args[1] !== "view") throw new Error(`Unexpected gh call: ${args.join(" ")}`);
        return JSON.stringify({
          state: "OPEN",
          isDraft: false,
          headRefOid: (
            await sh(["git", "rev-parse", `refs/heads/${owner.branch}`], { cwd: bare })
          ).stdout.trim(),
          headRefName: owner.branch,
          isCrossRepository: false,
          headRepository: { name: "repo" },
          headRepositoryOwner: { login: "test" },
          body: "Public report",
          comments: [],
        });
      };
      f.store.recordCiFixTrigger(
        owner.prUrl,
        owner.headSha,
        "failure",
        { check: "test", line: "FAIL validation", excerpt: "error: invalid farewell" },
        Date.now(),
      );
      await processConflictTriggers(f.store, Date.now, f.deps.gh);
      const round = f.store.reviewRounds(owner.prUrl).at(-1);
      if (!round) throw new Error("Missing CI round");
      expect(await executeRun(f.deps, round.runId, new AbortController().signal)).toBe("succeeded");
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain(expected);
      for (const text of [comments[0] ?? "", readFileSync(join(home, "gh-body"), "utf8")]) {
        expect(text).not.toContain(f.cfg.paths.home);
        expect(text).not.toContain(secret);
      }
    },
  );

  test.each(["entity", "clean"])("squash publication checks visible PR text: %s", async (form) => {
    await githubFixture();
    const phrase = ["private", "squash", "value"].join(" ");
    const body = form === "entity" ? phrase.replace("v", "&#118;") : "Use & <tag> &unknown; &amp;";
    const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    const entries = [{ value: phrase, entry: 1 }];
    const scan = checkPrivatePublication(repoDir, entries, {
      squash: { base: head, head, title: "Public title", body },
    });
    if (form === "entity") await expect(scan).rejects.toThrow("PR text contains a private string");
    else await scan;
    const merged = join(home, "merged");
    writeFileSync(
      join(home, "bin", "gh"),
      `#!/bin/sh
case "$2" in
  view) cat '${join(home, "pr.json")}' ;;
  merge) touch '${merged}' ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(home, "pr.json"),
      JSON.stringify({ state: "OPEN", headRefOid: head, title: "Public title", body }),
    );
    expect(
      await mergePullRequest(
        "https://github.com/test/repo/pull/1",
        repoDir,
        head,
        undefined,
        undefined,
        entries,
      ),
    ).toBe(form === "entity" ? "failed" : "merged");
    expect(existsSync(merged)).toBe(form === "clean");
  });

  test.each(["decimal", "hex", "named", "clean"])(
    "delivery checks the visible report body: %s",
    async (scenario) => {
      const bare = await githubFixture();
      const phrase = ["private", "report", "value"].join(" ");
      const report =
        scenario === "clean"
          ? "Use ordinary & <tag> &amp; &unknown; &#65; &#x42;"
          : scenario === "named"
            ? phrase.replaceAll(" ", "&nbsp;\n\t")
            : phrase.replace("v", scenario === "decimal" ? "&#118;" : "&#x76;");
      const checkRaw = () => checkPrivateText(report, "Raw report", [{ value: phrase, entry: 1 }]);
      if (scenario === "clean") expect(checkRaw).not.toThrow();
      else expect(checkRaw).toThrow("Raw report contains a private string (entry 1");
      const f = start((s) => {
        if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (roleOf(s) === "review") return { structured: approve };
        return { files: { "farewell.txt": "goodbye\n" }, text: report };
      });
      mkdirSync(f.cfg.paths.configDir, { recursive: true });
      writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), phrase);
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      const clean = scenario === "clean";
      expect(await waitFor(f, run.id, ["needs_human", "failed", "succeeded"])).toBe(
        clean ? "succeeded" : "needs_human",
      );
      if (clean) {
        expect(readFileSync(join(home, "gh-body"), "utf8")).toContain(report);
        expect(f.store.getRun(run.id)?.prUrl).toBe("https://github.com/test/repo/pull/1");
      } else {
        expect(f.store.getRun(run.id)?.error).toContain("PR body contains a private string (entry 1");
        expect(f.store.getRun(run.id)?.error).not.toContain(phrase);
        expect(f.store.getRun(run.id)?.prUrl).toBeNull();
        expect(existsSync(join(home, "gh-body"))).toBe(false);
      }
    },
  );

  test("delivery fetches an unknown remote head before rewrite detection and refuses failed lookups", async () => {
    const bare = await githubFixture();
    const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: repoDir })).stdout.trim();
    const base = await git("rev-parse", "HEAD");
    const tree = await git("rev-parse", "HEAD^{tree}");
    const remoteOnly = await git("--git-dir", bare, "commit-tree", tree, "-p", base, "-m", "remote only");
    await git("--git-dir", bare, "update-ref", "refs/heads/pr", remoteOnly);
    const missing = await sh(["git", "cat-file", "-e", remoteOnly], { cwd: repoDir, allowFail: true });
    expect(missing.exitCode).not.toBe(0);
    const unsafe = `%${"25".repeat(6)}72`;
    await git("commit", "--allow-empty", "-qm", unsafe);
    const head = await git("rev-parse", "HEAD");
    const repo: Repo = {
      id: "repo",
      slug: "test/repo",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
      createdAt: 0,
    };
    const range = await deliveryPublicationRange(repo, repoDir, "pr", base, head);
    expect(range).toBe(`${base}..${head}`);
    expect((await sh(["git", "cat-file", "-e", remoteOnly], { cwd: repoDir })).exitCode).toBe(0);
    await expect(checkPrivateRange(repoDir, range, [])).rejects.toThrow("decoding limit");
    await expect(
      deliveryPublicationRange({ ...repo, url: join(home, "missing.git") }, repoDir, "pr", base, head),
    ).rejects.toThrow();
  });

  test("a second delivery pushes clean commits without rescanning published history", async () => {
    const bare = await githubFixture();
    const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: repoDir })).stdout.trim();
    const base = await git("rev-parse", "HEAD");
    const unsafe = `%${"25".repeat(6)}72`;
    writeFileSync(join(repoDir, "transient.txt"), unsafe);
    await git("add", ".");
    await git("commit", "-qm", "intermediate");
    rmSync(join(repoDir, "transient.txt"));
    await git("commit", "-qam", "remove intermediate");
    const remote = await git("rev-parse", "HEAD");
    await git("push", bare, "HEAD:refs/heads/pr");
    writeFileSync(join(repoDir, "farewell.txt"), "goodbye\n");
    await git("add", ".");
    await git("commit", "-qm", "second delivery");
    const head = await git("rev-parse", "HEAD");
    const repo: Repo = {
      id: "repo",
      slug: "test/repo",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
      createdAt: 0,
    };
    const range = await deliveryPublicationRange(repo, repoDir, "pr", base, head);
    expect(range).toBe(`${remote}..${head}`);
    for (const entries of [[], [{ value: ["private", "value"].join("-"), entry: 1 }]]) {
      await expect(checkPrivateRange(repoDir, `${base}..${head}`, entries)).rejects.toThrow("decoding limit");
      await checkPrivateRange(repoDir, range, entries);
    }
    await pushExistingBranch(repo, repoDir, "pr", remote, undefined, undefined, head);
    expect(await git("--git-dir", bare, "rev-parse", "refs/heads/pr")).toBe(head);
  });

  test.each(["new", "missing", "rewrite", "equal"])(
    "delivery scans only newly published commits: %s",
    async (scenario) => {
      const bare = await githubFixture();
      const unsafe = `%${"25".repeat(6)}72`;
      const f = start(async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: s.cwd })).stdout.trim();
        if (role === "review") {
          if (scenario === "equal") {
            const branch = await git("symbolic-ref", "--short", "HEAD");
            await git("push", bare, `HEAD:refs/heads/${branch}`);
          }
          return { structured: approve };
        }
        const base = await git("rev-parse", "HEAD");
        const branch = await git("symbolic-ref", "--short", "HEAD");
        const commit = async (message: string) => {
          await git("add", ".");
          await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message);
        };
        writeFileSync(join(s.cwd, "transient.txt"), unsafe);
        await commit("intermediate");
        rmSync(join(s.cwd, "transient.txt"));
        await commit("remove intermediate");
        if (scenario === "new") await git("push", bare, `HEAD:refs/heads/${branch}`);
        if (scenario === "rewrite") {
          const tree = await git("rev-parse", `${base}^{tree}`);
          const other = await git("commit-tree", tree, "-p", base, "-m", "other history");
          await git("push", bare, `${other}:refs/heads/${branch}`);
        }
        if (scenario === "new") {
          writeFileSync(join(s.cwd, "another.txt"), "clean");
          await commit(unsafe);
        }
        return { files: { "farewell.txt": "goodbye\n" }, text: "Done" };
      });
      // Exercise both an absent denylist and a configured, nonmatching one.
      if (scenario === "rewrite") {
        mkdirSync(f.cfg.paths.configDir, { recursive: true });
        writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), ["private", "value"].join("-"));
      }
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      const clean = scenario === "equal";
      const status = await waitFor(f, run.id, ["needs_human", "failed", "succeeded"]);
      const result = f.store.getRun(run.id);
      if (clean) expect(result?.error).toBeNull();
      expect(status).toBe(clean ? "succeeded" : "needs_human");
      if (clean) expect(result?.prUrl).toBe("https://github.com/test/repo/pull/1");
      else {
        expect(result?.error).toContain("decoding limit");
        expect(result?.prUrl).toBeNull();
        const remote = (
          await sh(["git", "ls-remote", bare, `refs/heads/${result?.branch}`], { cwd: repoDir })
        ).stdout;
        expect(remote).not.toContain(result?.headSha ?? "missing SHA");
      }
    },
  );

  // Commit messages, identities, UTF-16 log config, LFS payloads and encodings are unit-tested
  // against checkPrivateRange (git-integrity.test.ts) and privateMatches (gates.test.ts).
  test.each([
    "title",
    "body",
    "draft-body",
    "unreadable",
    "branch",
    "history",
    "draft-history",
    "cache-config",
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
      if (["history", "draft-history"].includes(scenario)) {
        writeFileSync(join(s.cwd, "transient.txt"), entry);
        await sh(["git", "add", "."], { cwd: s.cwd });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "safe"], {
          cwd: s.cwd,
        });
        rmSync(join(s.cwd, "transient.txt"));
        await sh(["git", "add", "."], { cwd: s.cwd });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "remove transient"], {
          cwd: s.cwd,
        });
      }
      return { files: { "farewell.txt": "goodbye\n" }, text: scenario === "body" ? entry : "Done" };
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
      if (
        !armed ||
        !opts.cmd.includes("--no-replace-objects") ||
        opts.cmd.slice(-2).join(" ") !== "cat-file --batch"
      )
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
      expectProcessStopped(pid);
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
