import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import { githubWebhook } from "../src/integrations/github.ts";
import { startGitHubNotifier } from "../src/integrations/github-notifier.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
import { approve, type Handler, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
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
  test.each([
    "approve",
    "gates",
    "review",
    "persistent",
    "repair-audit",
    "baseline",
    "empty",
    "restart-initial",
    "restart-repair",
    "pending-comment",
    "head-moved",
    "head-lookup-failure",
    "head-lookup-missing",
    "head-lookup-malformed",
    "base-script",
    "pr-script",
    "pr-script-removed",
    "private-comment",
    "private-marker",
  ])(
    "verify-change: %s",
    async (scenario) => {
      const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: repoDir })).stdout.trim();
      const commit = async () => {
        await git("add", ".");
        await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
        return git("rev-parse", "HEAD");
      };
      const scriptAudit = scenario.includes("script");
      const prScript = scenario.startsWith("pr-script");
      const stale = scenario.startsWith("head-");
      const records = join(home, "gate-revisions");
      writeFileSync(
        join(repoDir, ".limitless.toml"),
        `[gates]
checks = [{ name = "test", run = "git rev-parse HEAD >> ${records}; echo generated > generated.txt; ! grep BAD greeting.txt" }${scriptAudit ? ', { name = "script", run = "bun run audit-check || true" }' : ""}]
[policy]
protected_paths = ["protected.txt"]
`,
      );
      if (scenario === "baseline") writeFileSync(join(repoDir, "greeting.txt"), "BAD\n");
      if (scriptAudit)
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({ scripts: { "audit-check": "exit 0" } }),
        );
      const base = await commit();
      if (prScript)
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({ scripts: scenario === "pr-script-removed" ? {} : { "audit-check": "echo pr" } }),
        );
      if (scenario !== "empty") writeFileSync(join(repoDir, "version.txt"), "dependency 2\n");
      if (scenario === "gates") writeFileSync(join(repoDir, "greeting.txt"), "BAD\n");
      if (scenario === "repair-audit") writeFileSync(join(repoDir, "protected.txt"), "original\n");
      const head = scenario === "empty" ? base : await commit();
      const bare = join(home, "github.git");
      await sh(["git", "clone", "-q", "--bare", repoDir, bare], { cwd: home });
      await git("push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2");
      // The base tip is not an ancestor of the PR head: review must use the merge base.
      await git("reset", "--hard", base);
      writeFileSync(join(repoDir, "base-only.txt"), "base advancement\n");
      if (scriptAudit)
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({ scripts: { "audit-check": "echo base" } }),
        );
      const baseTip = await commit();
      await git("push", "--force", bare, "HEAD:refs/heads/main");
      const prompts: string[] = [];
      let implementations = 0;
      let interrupted = false;
      let resume: (() => void) | undefined;
      const blocker = {
        severity: "major",
        file: "version.txt",
        line: 1,
        title: "Compatibility bug",
        detail: "Repair compatibility",
        suggestion: "Fix compatibility",
        security: false,
        ...findingEvidence,
      };
      const needsReviewRepair = ["review", "persistent", "repair-audit", "restart-repair"].includes(scenario);
      const handler: Handler = async (agent): Promise<FakeReply> => {
        const role = roleOf(agent);
        if (role === "triage") return { structured: triage() }; // PR source overrides feature + standard triage.
        if (role === "review") {
          prompts.push(agent.prompt);
          expect(agent.prompt).toContain(`git diff ${baseTip}...`);
          for (const topic of [
            "breaking changes",
            "permission and pinning",
            "lockfile consistency",
            "install-time code",
          ])
            expect(agent.prompt).toContain(topic);
          const patch = (await sh(["git", "diff", `${baseTip}...HEAD`], { cwd: agent.cwd })).stdout;
          expect(patch).toContain("dependency 2");
          expect(patch).not.toContain("base-only");
          expect(patch).not.toContain("generated.txt");
          expect(agent.prompt).toContain("+dependency 2");
          expect(agent.prompt).not.toContain("base-only");
          if (
            (scenario === "restart-initial" || (scenario === "restart-repair" && implementations > 0)) &&
            !interrupted
          ) {
            interrupted = true;
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          }
          if (needsReviewRepair && (implementations === 0 || scenario === "persistent"))
            return {
              structured: {
                ...approve,
                findings: [
                  {
                    ...blocker,
                    ...(implementations ? { label: "unaddressed", prior: "P1", security: false } : {}),
                  },
                ],
              },
            };
          if (scenario === "head-moved") {
            await git("reset", "--hard", head);
            writeFileSync(join(repoDir, "competing.txt"), "another push\n");
            await commit();
            await git("push", bare, "HEAD:refs/heads/dependabot/npm/pkg-2");
          }
          if (scenario === "private-comment")
            return { structured: { ...approve, summary: `${approve.summary} Checked secret-host.example.` } };
          return { structured: approve };
        }
        expect(role).toBe("implement");
        implementations++;
        expect(agent.prompt).toContain(
          prScript
            ? "gate-script-changed"
            : scenario === "gates"
              ? "test"
              : scenario === "empty"
                ? "empty-diff"
                : implementations > 1 && scenario === "repair-audit"
                  ? "Repair:"
                  : "Compatibility bug",
        );
        if (scenario === "empty") return { text: "No changes" };
        return {
          files:
            scenario === "repair-audit"
              ? { "protected.txt": "tampered\n" }
              : { "greeting.txt": "repaired\n" },
          text: "Repaired compatibility",
        };
      };
      let f = start(handler);
      if (["private-comment", "private-marker"].includes(scenario)) {
        mkdirSync(f.cfg.paths.configDir, { recursive: true });
        writeFileSync(
          join(f.cfg.paths.configDir, "private-strings.txt"),
          scenario === "private-marker" ? "<!-- limitless-verification:" : "secret-host.example",
        );
      }
      const calls: string[][] = [];
      const gh = async (args: string[]) => {
        calls.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          if (scenario === "head-lookup-failure") throw new Error("fixture lookup failed");
          if (scenario === "head-lookup-missing") return "{}";
          if (scenario === "head-lookup-malformed") return "invalid JSON";
          return JSON.stringify({
            headRefOid: (await git("ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).split("\t")[0],
          });
        }
        if (args[0] === "api") return calls.find((call) => call[1] === "comment")?.at(-1) ?? "";
        return "";
      };
      if (scenario === "pending-comment")
        f.deps.faults = {
          "store:save": { action: "kill", when: (c) => c.checkpoint === "verification-comment-posted" },
        };
      f.deps.gh = gh;
      let stopNotifier = startGitHubNotifier(
        f.store,
        gh,
        () => {},
        async () => null,
      );
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
      payload.pull_request.base.sha = baseTip;
      payload.pull_request.head.sha = head;
      const body = JSON.stringify(payload);
      const response = await githubWebhook(f)(
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": scenario,
            "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
          },
        }),
      );
      expect(response.status).toBe(201);
      const { runId } = (await response.json()) as { runId: string };
      if (scenario === "pending-comment") {
        const deadline = Date.now() + 10_000;
        while (f.store.listStages(runId).at(-1)?.status !== "cancelled") {
          if (Date.now() > deadline) throw new Error("comment interruption timed out");
          await Bun.sleep(10);
        }
        stopNotifier();
        await f.stop();
        expect(f.store.getRunState<RunState>(runId)?.verdictCommentPending).toBe(true);
        expect(f.store.getRunState<RunState>(runId)?.verdictCommentPosted).not.toBe(true);
        f.store.close();
        f = start(handler);
        f.deps.gh = gh;
      }
      if (scenario.startsWith("restart")) {
        for (let i = 0; !resume && i < 300; i++) await Bun.sleep(20);
        expect(resume).toBeDefined();
        const before = f.store.getRunState<RunState>(runId);
        stopNotifier();
        const stopping = f.stop();
        resume?.();
        await stopping;
        stopNotifier();
        f.store.close();
        f = start(handler);
        f.deps.gh = gh;
        stopNotifier = startGitHubNotifier(
          f.store,
          gh,
          () => {},
          async () => null,
        );
        expect(before?.verification?.baseSha).toBe(baseTip);
        expect(before?.verification?.headSha).toBe(head);
        if (scenario === "restart-repair") expect(before?.implementedRound).toBe(0);
      }
      const blocked =
        prScript ||
        ["persistent", "repair-audit", "empty", "private-comment", "private-marker"].includes(scenario);
      expect(await waitFor(f, runId, ["succeeded", "failed", "needs_human", "cancelled"])).toBe(
        scenario === "head-moved" ? "cancelled" : stale ? "failed" : blocked ? "needs_human" : "succeeded",
      );
      stopNotifier();
      const state = f.store.getRunState<RunState>(runId);
      expect(state?.flow).toBe("verify-change");
      expect(f.store.getRunDetail(runId)?.run.flow).toBe("verify-change");
      const revisions = readFileSync(records, "utf8").trim().split("\n");
      // A check failing on base is retried once, still on base, before the head is checked out.
      const baseRuns = scenario === "baseline" ? [baseTip, baseTip] : [baseTip];
      expect(revisions.slice(0, baseRuns.length + 1)).toEqual([...baseRuns, head]);
      const remote = (await git("ls-remote", bare, "refs/heads/dependabot/npm/pkg-2")).split("\t")[0];
      if (["private-comment", "private-marker"].includes(scenario)) {
        expect(calls.some((call) => call.at(-1)?.includes("limitless-verification"))).toBe(false);
        expect(JSON.stringify(calls)).not.toContain("secret-host.example");
        expect(remote).toBe(head);
        expect(f.store.getRun(runId)?.error).toBe(
          "PR comment contains a private string (entry 1 in private-strings.txt)",
        );
        return;
      }
      if (stale) {
        expect(implementations).toBe(0);
        expect(
          calls.filter((call) => call[1] === "comment" && call.at(-1)?.includes("Verified by")),
        ).toHaveLength(0);
        const reason =
          scenario === "head-moved"
            ? `superseded: PR head moved from ${head} to ${remote}`
            : "Unable to confirm PR head";
        if (scenario === "head-moved") {
          expect(calls.filter((call) => call[1] === "comment")).toHaveLength(0);
          expect(f.store.listEvents(runId).some((event) => event.message === reason)).toBe(true);
        }
        expect(f.store.getRun(runId)?.error).toContain(reason);
        expect(state?.terminalReason).toContain(reason);
        expect(f.store.getArtifact(runId, "report.md")).toContain(reason);
        expect(f.store.getArtifact(runId, "report.md")).not.toContain("Verified by");
        return;
      }
      if (scriptAudit)
        expect(
          state?.lastAudit?.some((a) => a.rule === "gate-script-changed" && a.severity === "block"),
        ).toBe(prScript);
      const unchanged = ["approve", "baseline", "restart-initial", "pending-comment", "base-script"].includes(
        scenario,
      );
      expect(remote).toBe(unchanged || blocked ? head : (f.store.getRun(runId)?.headSha ?? "missing"));
      if (unchanged) {
        expect(implementations).toBe(0);
        expect(f.store.listStages(runId).some((stage) => stage.name === "implement")).toBe(false);
        expect(f.store.getRun(runId)?.headSha).toBe(head);
        // Success is recorded before the worktree is removed; "Run succeeded" is logged once it is gone.
        const cleaned = Date.now() + 5000;
        while (!f.store.listEvents(runId).some((e) => e.message === "Run succeeded") && Date.now() < cleaned)
          await Bun.sleep(10);
        expect(existsSync(state?.worktreePath ?? "missing")).toBe(false);
        const comments = calls.filter((call) => call[1] === "comment");
        expect(comments).toHaveLength(1);
        expect(comments[0]?.slice(0, 3)).toEqual(["pr", "comment", "18"]);
        expect(comments[0]?.at(-1)).not.toContain("generated.txt");
        expect(comments[0]?.at(-1)).toContain(`Verified commit: \`${head}\``);
        expect(f.store.getArtifact(runId, "report.md")).toContain(`Verified commit: \`${head}\``);
        expect(comments[0]?.at(-1)).toContain(`<!-- limitless-verification:${runId} -->`);
        for (const text of [
          "Flow: verify-change",
          "| Check |",
          "LGTM",
          "Work log",
          "Total:",
          "spent",
          "subscriptions",
        ])
          expect(comments[0]?.at(-1)).toContain(text);
        expect(f.store.getArtifact(runId, "diff.patch")).toBe(
          (await sh(["git", "diff", `${baseTip}...${head}`], { cwd: repoDir })).stdout,
        );
      } else if (!blocked) {
        expect(implementations).toBe(1);
        expect(revisions).toContain(remote ?? "missing");
        if (needsReviewRepair) {
          expect(prompts.at(-1)).toContain("# Previous review");
          expect(prompts.at(-1)).toContain("Compatibility bug");
          expect(f.store.getArtifact(runId, "diff.patch")).toContain("repaired");
        }
      } else {
        expect(implementations).toBe(f.cfg.maxRounds + 2);
        expect(f.store.getArtifact(runId, "report.md")).toContain("Flow: verify-change");
        if (scenario === "repair-audit")
          expect(
            state?.lastAudit?.some((a) => a.detail.startsWith("Repair:") && a.severity === "block"),
          ).toBe(true);
      }
    },
    30_000,
  );
});
