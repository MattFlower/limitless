import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "solid-js/web";
import type { Factory } from "../src/app.ts";
import { githubWebhook } from "../src/integrations/github.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
import { buildNeedsYouUi } from "./needs-you-ui-support.ts";
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

describe("pipeline (fake agents, real git + gates)", () => {
  test("verify-change panel R2 gets only the fix diff's stat and patch", async () => {
    const bare = join(home, "github.git");
    await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
    const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    writeFileSync(join(repoDir, "version.txt"), "dependency 2\n");
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bump"], { cwd: repoDir });
    const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    await sh(["git", "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir });
    const finders: string[] = [];
    const f = start((s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        const cited = [
          ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
        ];
        return {
          structured: {
            results: cited.map(([, id]) => ({
              id,
              // R1's blocker is real; R2's recheck finds it repaired.
              verdict: finders.length === 1 ? "CONFIRMED" : "REFUTED",
              severity: "high",
              category: "compatibility",
              evidence: "version.txt:1 `dependency 2`",
              trigger: "installing -> broken",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ task_class: "dependency_update" }) };
      if (role === "review") {
        finders.push(s.prompt);
        const findings =
          finders.length === 1
            ? [
                {
                  severity: "major",
                  file: "version.txt",
                  line: 1,
                  title: "Needs repair",
                  detail: "Repair the update",
                  suggestion: "Fix compatibility",
                  security: false,
                  ...findingEvidence,
                },
              ]
            : [];
        return { structured: { ...approve, findings } };
      }
      return { files: { "repair.txt": "repaired\n" }, text: "Repaired the update" };
    });
    f.deps.gh = async () => {};
    f.deps.reviewSystem = {
      name: "panel",
      mode: "panel",
      finders: [{ prompt: "standard" }],
      verifier: {},
      implementerReport: "include",
    };
    f.store.upsertRepo({
      slug: "MattFlower/limitless",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    f.cfg.secrets.GITHUB_WEBHOOK_SECRET = "test-secret";
    const payload = JSON.parse(readFileSync(join(import.meta.dir, "data/github-pr.json"), "utf8"));
    payload.pull_request.base.sha = baseSha;
    payload.pull_request.head.sha = head;
    const body = JSON.stringify(payload);
    const response = await githubWebhook(f)(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "panel-fix-diff",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
        },
      }),
    );
    expect(response.status).toBe(201);
    const { runId } = (await response.json()) as { runId: string };
    expect(await waitFor(f, runId, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(finders).toHaveLength(2);
    // R1 reviews the PR's change inline; R2 only the repair since R1's head.
    expect(finders[0]).toContain("version.txt");
    expect(finders[0]).toContain("+dependency 2");
    const r2 = finders[1] ?? "";
    expect(r2).toContain("review R2: the fix diff only");
    expect(r2).toContain("repair.txt");
    expect(r2).toContain("+repaired");
    expect(r2).not.toContain("+dependency 2");
    expect(r2.slice(0, r2.indexOf("# Previous review"))).not.toContain("version.txt");
    expect(JSON.parse(f.store.getArtifact(runId, "review-2.json") ?? "{}")).toMatchObject({
      verdict: "approve",
      scope: { kind: "fix", range: `${head}..${f.store.getRun(runId)?.headSha}` },
    });
  });

  test("Dependabot run delivers to the existing PR head without creating a PR", async () => {
    const bare = join(home, "github.git");
    await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
    const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    writeFileSync(join(repoDir, "version.txt"), "2\n");
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bump"], { cwd: repoDir });
    const originalHead = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    await sh(["git", "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir });
    let reviews = 0;
    let concurrent: string | null = null;
    let content = "verified\n";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ task_class: "dependency_update" }) };
      if (role === "review") {
        if (reviews++ === 0)
          return {
            structured: {
              ...approve,
              findings: [
                {
                  severity: "major",
                  file: "version.txt",
                  line: 1,
                  title: "Needs repair",
                  detail: "Repair the update",
                  suggestion: "Fix compatibility",
                  security: false,
                  ...findingEvidence,
                },
              ],
            },
          };
        if (concurrent) {
          const result = Bun.spawnSync(["git", "push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2"], {
            cwd: concurrent,
          });
          if (result.exitCode !== 0) throw new Error("concurrent push failed");
          concurrent = null;
        }
        return { structured: approve };
      }
      return { files: { "farewell.txt": content }, text: "Verified dependency update" };
    });
    f.store.upsertRepo({
      slug: "MattFlower/limitless",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    f.cfg.secrets.GITHUB_WEBHOOK_SECRET = "test-secret";
    const trigger = async (sha: string, delivery: string) => {
      const payload = JSON.parse(readFileSync(join(import.meta.dir, "data/github-pr.json"), "utf8")) as {
        pull_request: { head: { sha: string }; base: { sha: string } };
      };
      payload.pull_request.head.sha = sha;
      payload.pull_request.base.sha = baseSha;
      const body = JSON.stringify(payload);
      const response = await githubWebhook(f)(
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": delivery,
            "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
          },
        }),
      );
      expect(response.status).toBe(201);
      const { runId } = (await response.json()) as { runId: string };
      const run = f.store.getRun(runId);
      if (!run) throw new Error("webhook did not create run");
      expect(run.githubWebhookVerified).toBe(true);
      return run;
    };
    const run = await trigger(originalHead, "initial");
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const finished = f.store.getRun(run.id);
    expect(finished?.prUrl).toBe("https://github.com/MattFlower/limitless/pull/18");
    expect(
      (await sh(["git", "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir })).stdout,
    ).toContain(finished?.headSha ?? "missing head");
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).toBe("");

    const competitor = join(home, "competitor");
    await sh(["git", "clone", "-q", bare, competitor], { cwd: home });
    await sh(["git", "checkout", "-qb", "move", "origin/dependabot/npm/pkg-2"], { cwd: competitor });
    writeFileSync(join(competitor, "competing.txt"), "new head\n");
    await sh(["git", "add", "."], { cwd: competitor });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "competing update"], {
      cwd: competitor,
    });
    const competingSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: competitor })).stdout.trim();
    concurrent = competitor;
    content = "verified again\n";
    reviews = 0;
    if (!finished?.headSha) throw new Error("missing delivered head");
    const stale = await trigger(finished.headSha, "concurrent");
    expect(await waitFor(f, stale.id, ["succeeded", "failed", "needs_human"])).toBe("failed");
    expect(f.store.getRun(stale.id)?.error).toContain("PR head moved");
    expect(
      (await sh(["git", "ls-remote", bare, "refs/heads/dependabot/npm/pkg-2"], { cwd: repoDir })).stdout,
    ).toContain(competingSha);
  });
});

describe("pipeline (fake agents, real git + gates)", () => {
  test("degenerate review is a failed invocation and the next routed reviewer completes the stage", async () => {
    let implementCalls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review")
        return {
          structured:
            s.target.provider === "beta" ? { verdict: "approve", summary: "test", findings: [] } : approve,
        };
      if (role === "verify") return { structured: pass };
      implementCalls++;
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const reviews = f.store.listInvocations(run.id).filter((i) => i.role === "review");
    expect(reviews.map((i) => [i.modelId, i.status])).toEqual([
      ["beta/m", "error"],
      ["alpha/m", "ok"],
    ]);
    expect(reviews[0]?.error).toContain("structured output failed validation");
    expect(reviews[0]?.stageId).toBe(reviews[1]?.stageId);
    expect(f.store.listStages(run.id).filter((s) => s.name === "review")).toHaveLength(1);
    expect(implementCalls).toBe(1);
    const artifact = JSON.parse(f.store.getArtifact(run.id, "review-0.json") ?? "{}");
    expect(artifact).toMatchObject({ model: "alpha/m", summary: approve.summary });
    expect(f.store.listArtifacts(run.id).filter((a) => a.name.startsWith("review-"))).toHaveLength(1);
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.reviewHistory).toHaveLength(1);
    expect(state?.lastReview?.modelId).toBe("alpha/m");
  });

  test("degenerate review from every routed reviewer fails the stage without an approval", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review")
        return { structured: { verdict: "approve", summary: "   LGTM   ", findings: [] } };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    const reviews = f.store.listInvocations(run.id).filter((i) => i.role === "review");
    expect(reviews.map((i) => [i.modelId, i.status])).toEqual([
      ["beta/m", "error"],
      ["alpha/m", "error"],
    ]);
    expect(f.store.listStages(run.id).find((s) => s.name === "review")?.status).toBe("failed");
    expect(f.store.listArtifacts(run.id).some((a) => a.name.startsWith("review-"))).toBe(false);
    expect(f.store.getRunState<RunState>(run.id)?.lastReview).toBeUndefined();
    expect(f.store.listStages(run.id).some((s) => s.name === "verify" || s.name === "deliver")).toBe(false);
  });

  test("later-round review accepts a short fix confirmation but still rejects a placeholder", async () => {
    let implementCalls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        if (!s.prompt.includes("# Previous review"))
          return {
            structured: {
              verdict: "request_changes",
              summary: "wrong text",
              findings: [
                {
                  severity: "blocker",
                  security: false,
                  ...findingEvidence,
                  file: "farewell.txt",
                  line: 1,
                  title: "Wrong text",
                  detail: "Say goodbye",
                  suggestion: "Write goodbye",
                },
              ],
            },
          };
        return {
          structured: {
            verdict: "approve",
            summary: s.target.provider === "beta" ? "test" : "P1 fixed; no regressions found.",
            findings: [],
          },
        };
      }
      implementCalls++;
      return { files: { "farewell.txt": implementCalls === 1 ? "bye\n" : "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const reviews = f.store.listInvocations(run.id).filter((i) => i.role === "review");
    expect(reviews.map((i) => [i.modelId, i.status])).toEqual([
      ["beta/m", "ok"],
      ["beta/m", "error"],
      ["alpha/m", "ok"],
    ]);
    expect(reviews[1]?.error).toContain("at least 12 characters");
    expect(implementCalls).toBe(2);
    expect(JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}")).toMatchObject({
      model: "alpha/m",
      verdict: "approve",
      summary: "P1 fixed; no regressions found.",
    });
  });
});

describe("pipeline (fake agents, real git + gates)", () => {
  test("happy path: triage → spec → implement → gates → review → verify → deliver", async () => {
    const seen: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      seen.push(`${role}:${s.target.modelId}`);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" }, text: "Added farewell.txt" };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");

    const detail = f.store.getRunDetail(run.id);
    expect(detail?.run.title).toBe("Add farewell");
    expect(detail?.run.resolvedProfile).toBe("standard");
    expect(detail?.stages.map((s) => s.name)).toEqual([
      "prepare",
      "triage",
      "spec",
      "holdout",
      "implement",
      "gates",
      "audit",
      "review",
      "verify",
      "deliver",
    ]);
    // Review and verify ran on a different vendor than the implementer.
    const impl = seen.find((s) => s.startsWith("implement"));
    const review = seen.find((s) => s.startsWith("review"));
    expect(impl?.split(":")[1]).not.toBe(review?.split(":")[1]);
    // Work landed on the branch in the local repo.
    const branch = detail?.run.branch as string;
    const show = await sh(["git", "show", `${branch}:farewell.txt`], { cwd: repoDir });
    expect(show.stdout).toBe("goodbye\n");
    expect(f.store.getArtifact(run.id, "report.md")).toContain("AC-1");
    expect(f.store.getArtifact(run.id, "diff.patch")).toContain("+goodbye");
  });

  test("regressing a gate sends feedback and the next round fixes it", async () => {
    let implementCalls = 0;
    let secondPrompt = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      implementCalls++;
      if (implementCalls === 1) return { files: { "farewell.txt": "BAD goodbye\n" } };
      secondPrompt = s.prompt;
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementCalls).toBe(2);
    expect(secondPrompt).toContain("Check `no-bad` now FAILS");
    const gates = f.store.listStages(run.id).filter((s) => s.name === "gates");
    expect(gates.map((g) => g.summary)).toEqual(["blocking: no-bad", "1 checks ok"]);
  });

  test("review blockers loop back to the implementer", async () => {
    let reviews = 0;
    let implementPrompts: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews++;
        return reviews === 1
          ? {
              structured: {
                verdict: "request_changes",
                summary: "missing newline handling",
                findings: [
                  {
                    severity: "blocker",
                    security: false,
                    ...findingEvidence,
                    file: "farewell.txt",
                    line: 1,
                    title: "Wrong text",
                    detail: "Say goodbye politely",
                    suggestion: "Use 'goodbye, friend'",
                  },
                ],
              },
            }
          : { structured: approve };
      }
      implementPrompts = [...implementPrompts, s.prompt];
      return { files: { "farewell.txt": `goodbye${implementPrompts.length}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(reviews).toBe(2);
    expect(implementPrompts[1]).toContain("Wrong text");
  });

  test("later reviews compare the previous commit and keep new major findings as follow-ups", async () => {
    const prompts: string[] = [];
    const implementPrompts: string[] = [];
    const finding = (title: string, label?: "unaddressed" | "regression" | "new") => ({
      severity: "major",
      security: false,
      ...findingEvidence,
      ...(label ? { label, prior: label === "unaddressed" ? "P1" : "" } : {}),
      file: "farewell.txt",
      line: 1,
      title,
      detail: title,
      suggestion: "Fix it",
    });
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        prompts.push(s.prompt);
        return {
          structured:
            prompts.length === 1
              ? { verdict: "approve", summary: "first", findings: [finding("Prior bug")] }
              : prompts.length === 2
                ? { verdict: "approve", summary: "second", findings: [finding("Prior bug", "unaddressed")] }
                : {
                    verdict: "request_changes",
                    summary: "follow up",
                    findings: [finding("Later edge case", "new")],
                  },
        };
      }
      implementPrompts.push(s.prompt);
      return { files: { "farewell.txt": `goodbye ${implementPrompts.length}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementPrompts).toHaveLength(3);
    expect(implementPrompts[1]).toContain("Prior bug");
    type Stored = { verdict: string; modelVerdict: string };
    const first = JSON.parse(f.store.getArtifact(run.id, "review-0.json") ?? "{}") as Stored;
    const third = JSON.parse(f.store.getArtifact(run.id, "review-2.json") ?? "{}") as Stored;
    expect(first).toMatchObject({ verdict: "request_changes", modelVerdict: "approve" });
    expect(third).toMatchObject({ verdict: "approve", modelVerdict: "request_changes" });
    expect(prompts[1]).toContain("Prior bug");
    const reviewed = prompts[1]?.match(/Reviewed commit: ([a-f0-9]{40})\. Current HEAD: ([a-f0-9]{40})/);
    expect(reviewed).not.toBeNull();
    expect(reviewed?.[1]).not.toBe(reviewed?.[2]);
    expect(prompts[1]).toContain(`git diff ${reviewed?.[1]}..${reviewed?.[2]}`);
    expect(prompts[1]).toContain("git diff ");
    expect(prompts[1]).toContain("latest-change diff");
    expect(f.store.getArtifact(run.id, "report.md")).toContain(
      "## Review follow-ups\n\n- major: `farewell.txt:1` Later edge case",
    );
  });

  test("later-round prompts list previous findings without the v2 evidence fields", async () => {
    const prompts: string[] = [];
    const prior = { severity: "major", security: false, file: "farewell.txt", line: 1, title: "Prior bug" };
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        prompts.push(s.prompt);
        const findings = [{ ...prior, ...findingEvidence, detail: "Wrong", suggestion: "Fix it" }];
        return { structured: prompts.length === 1 ? { ...approve, findings } : approve };
      }
      return { files: { "farewell.txt": `goodbye ${prompts.length}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    // The fresh round-1 finding keeps its v2 fields in run state; only the prompt drops them.
    const history = f.store.getRunState<RunState>(run.id)?.reviewHistory;
    expect(history?.[0]?.blocking).toMatchObject([findingEvidence]);
    const previous = prompts[1]?.match(/Previous blocking findings[^\n]*\n```\n([\s\S]*?)\n```/)?.[1];
    expect(JSON.parse(previous ?? "null")).toEqual([
      { id: "P1", ...prior, detail: "Wrong", suggestion: "Fix it" },
    ]);
    for (const field of Object.keys(findingEvidence)) expect(prompts[1]).not.toContain(`"${field}"`);
  });

  for (const [label, laterTitle] of [
    ["unaddressed", "Prior bug"],
    ["unaddressed", "Prior bug still unfixed"],
    ["regression", "Still broken"],
  ] as const) {
    test(`${label} later finding (${laterTitle}) sends only blocking feedback to implementation`, async () => {
      let reviews = 0;
      const prompts: string[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") {
          reviews++;
          const title = reviews === 1 ? "Prior bug" : laterTitle;
          return {
            structured:
              reviews < 3
                ? {
                    verdict: "approve",
                    summary: "review",
                    findings: [
                      {
                        severity: reviews === 2 ? "minor" : "major",
                        security: false,
                        ...findingEvidence,
                        ...(reviews === 2 ? { label, prior: label === "unaddressed" ? "P1" : "" } : {}),
                        file: "farewell.txt",
                        line: 1,
                        title,
                        detail: title,
                        suggestion: "Fix it",
                      },
                      ...(reviews === 2
                        ? [
                            {
                              severity: "minor",
                              security: false,
                              ...findingEvidence,
                              label: "new",
                              prior: "",
                              file: "farewell.txt",
                              line: 1,
                              title: "Future cleanup",
                              detail: "Optional",
                              suggestion: "Later",
                            },
                          ]
                        : []),
                    ],
                  }
                : { ...approve, verdict: "request_changes" },
          };
        }
        prompts.push(s.prompt);
        return { files: { "farewell.txt": `goodbye ${prompts.length}\n` } };
      });
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(prompts).toHaveLength(3);
      expect(prompts[2]).toContain(laterTitle);
      expect(prompts[2]).not.toContain("Future cleanup");
      expect(JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}")).toMatchObject({
        verdict: "request_changes",
        modelVerdict: "approve",
      });
      expect(f.store.getArtifact(run.id, "report.md")).toContain("Future cleanup");
    });
  }

  test("a new security finding blocks even at minor severity", async () => {
    let implementsCount = 0;
    let reviews = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews++;
        return {
          structured:
            reviews === 1
              ? {
                  verdict: "approve",
                  summary: "initial",
                  findings: [
                    {
                      severity: "major",
                      security: false,
                      ...findingEvidence,
                      file: "farewell.txt",
                      line: 1,
                      title: "Prior bug",
                      detail: "bug",
                      suggestion: "fix",
                    },
                  ],
                }
              : reviews === 2
                ? {
                    verdict: "approve",
                    summary: "security",
                    findings: [
                      {
                        severity: "minor",
                        security: true,
                        ...findingEvidence,
                        label: "new",
                        prior: "",
                        file: "farewell.txt",
                        line: 1,
                        title: "Secret leak",
                        detail: "leak",
                        suggestion: "fix",
                      },
                    ],
                  }
                : approve,
        };
      }
      implementsCount++;
      if (implementsCount === 3) expect(s.prompt).toContain("Secret leak");
      return { files: { "farewell.txt": `goodbye ${implementsCount}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementsCount).toBe(3);
    expect(f.store.getArtifact(run.id, "review-1.json")).toContain('"verdict": "request_changes"');
  });
});

describe("pipeline (fake agents, real git + gates)", () => {
  test("cancellation stops a running agent", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      return { delayMs: 30_000, files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    const deadline = Date.now() + 10_000;
    while (f.store.getRun(run.id)?.stage !== "implement" && Date.now() < deadline) await Bun.sleep(20);
    expect(f.cancelRun(run.id, "tester")).toBe(true);
    expect(await waitFor(f, run.id, ["cancelled"])).toBe("cancelled");
    expect(f.store.getRun(run.id)?.error).toBe("cancelled by tester");
  });

  test("gives up after max rounds and marks the run for a human", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      return { files: { "farewell.txt": `BAD ${Math.random()}\n` } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"], 30_000)).toBe("needs_human");
    const implement = f.store.listStages(run.id).filter((s) => s.name === "implement");
    expect(implement.length).toBe(5);
    expect(f.store.getRun(run.id)?.error).toContain("Still failing");
  });
});

test("a recovered implement failure followed by a review block names review in Needs you", async () => {
  const f = start((s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (role === "review")
      return {
        structured: {
          ...approve,
          verdict: "request_changes",
          findings: [
            {
              label: "unaddressed",
              prior: "P1",
              severity: "major",
              security: false,
              ...findingEvidence,
              file: "farewell.txt",
              line: 1,
              title: "Incorrect output",
              detail: "Needs work",
              suggestion: "Fix it",
            },
          ],
        },
      };
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  f.deps.cfg.maxRounds = 1;
  f.deps.faults = { "stage:implement:before": { action: "throw" } };
  const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
  expect(await waitFor(f, run.id, ["needs_human", "failed", "succeeded"])).toBe("needs_human");
  const detail = f.store.getRunDetail(run.id);
  if (!detail) throw new Error("missing recovered run detail");
  expect(detail.stages.filter((stage) => stage.name === "implement").map((stage) => stage.status)).toEqual([
    "failed",
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
  expect(f.store.getRunState<RunState>(run.id)?.lastReview?.verdict).toBe("request_changes");
  expect(detail.stoppingStage).toBe("review");
  const ui = await buildNeedsYouUi(join(home, "needs-you-ui"));
  try {
    ui.mount(detail);
    const html = renderToString(() => ui.render());
    expect(html).toContain('aria-label="Needs you"');
    expect(html).toContain("review · Still failing after");
    expect(html).not.toContain("implement · Still failing after");
  } finally {
    ui.dispose();
  }
});
