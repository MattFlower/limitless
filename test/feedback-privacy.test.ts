import { expect, spyOn, test } from "bun:test";
import { gatePrivacyScope } from "../src/gates/text-privacy.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { buildLoop } from "../src/pipeline/engine.ts";
import { createCredentialRegistry } from "../src/util/credential-matcher.ts";
import { createPrivacyRegistry } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker } from "../src/util/privacy-checker.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import { verifier } from "../src/util/privacy-proof.ts";
import { checkRendering } from "../src/util/privacy-rendering.ts";
import { registerCredential } from "../src/util/proc.ts";
import { fixture } from "./mcp-support.ts";
import { privacyPort } from "./privacy-support.ts";

async function contextFixture(
  run: (
    ctx: RunContext,
    reload: () => RunContext,
    scope: {
      checker: ReturnType<typeof createPrivacyChecker>;
      registry: ReturnType<typeof createPrivacyRegistry>;
    },
  ) => Promise<void>,
) {
  const f = await fixture(),
    registry = createPrivacyRegistry(createCredentialRegistry());
  provisionPrivacyPolicy(f.factory.cfg.paths.configDir, [], { registry });
  const checker = createPrivacyChecker({ registry, workerFactory: privacyPort });
  try {
    const runRecord = await f.factory.createRun({
        repo: f.repo,
        prompt: "Update the file",
        profile: "quick",
      }),
      repo = f.factory.store.getRepo(runRecord.repoId);
    if (!repo) throw Error("Missing repo");
    await gatePrivacyScope.run({ checker, registry, signer: () => Buffer.alloc(32, 41) }, async () => {
      const reload = () => new RunContext(f.factory.deps, runRecord, repo, new AbortController().signal);
      const ctx = reload();
      ctx.state.worktreePath = f.repo;
      ctx.state.gatesConfig = { setup: [], checks: [], source: "detected", protectedPaths: [] };
      await run(ctx, reload, { checker, registry });
    });
  } finally {
    await checker.dispose();
    await f.close();
  }
}

test.each(["legacy", "policy-edit", "valid", "credential-change"])(
  "resume verifies feedback before any consumer: %s",
  (mode) =>
    contextFixture(async (ctx, reload, { registry, checker }) => {
      const text = `previous-feedback-${crypto.randomUUID()}`;
      ctx.state.feedback = text;
      if (mode !== "legacy") ctx.state.feedbackProof = (await checkRendering(text, "feedback")).proof;
      await ctx.save();
      const saved = ctx.store.getRunState<RunState>(ctx.run.id)?.feedbackProof;
      if (mode === "policy-edit") registry.replacePolicy([{ value: "other-policy-entry", entry: 0 }]);
      if (mode === "credential-change") registerCredential("SAVED_FEEDBACK", text);
      const resumed = reload();
      expect(resumed.state.feedback).toBe(
        mode === "valid" ? text : "[previous feedback withheld: unverified]",
      );
      expect(resumed.loadedFeedback).toBe(resumed.state.feedback);
      expect(resumed.state.feedbackProof).toEqual(mode === "valid" ? saved : undefined);
      const protect = spyOn(checker, "protectText");
      try {
        await resumed.checkFeedback();
        await resumed.save();
        expect(protect).not.toHaveBeenCalled();
        expect(ctx.store.getRunState<RunState>(ctx.run.id)?.feedbackProof).toEqual(
          mode === "valid" ? saved : undefined,
        );
        expect(JSON.stringify(ctx.store.listEvents(ctx.run.id))).not.toContain(text);
      } finally {
        protect.mockRestore();
      }
    }),
);

test.each(["fresh", "unchanged", "refused", "stale"])(
  "implement prompt uses checked feedback and next save preserves its binding: %s",
  (mode) =>
    contextFixture(async (initial, reload, { checker, registry }) => {
      let ctx = initial,
        prompt = "";
      const text = "new feedback\u001b[31m with formatting\u001b[0m",
        rendering = "new feedback with formatting";
      if (mode === "unchanged") {
        initial.state.feedback = rendering;
        initial.state.feedbackProof = (await checkRendering(rendering, "feedback")).proof;
        await initial.save();
        ctx = reload();
      } else ctx.state.feedback = text;
      const before = ctx.state.feedbackProof,
        protect = checker.protectText;
      const check = spyOn(checker, "protectText").mockImplementation(async (...args) => {
        const receipt = await protect(...args);
        if (mode === "stale") registry.replacePolicy([{ value: "edited-policy", entry: 0 }]);
        return receipt;
      });
      if (mode === "refused") registry.replacePolicy([{ value: "new feedback", entry: 0 }]);
      const invoke = spyOn(ctx, "invoke").mockImplementation(async (input) => {
        prompt = typeof input.prompt === "string" ? input.prompt : input.prompt(false);
        throw Error("prompt captured");
      });
      try {
        await expect(buildLoop(ctx)).rejects.toThrow("prompt captured");
        const expected =
          mode === "refused"
            ? "[previous feedback withheld: private-match]"
            : mode === "stale"
              ? "[previous feedback withheld: stale-generation]"
              : rendering;
        expect(prompt).toContain(expected);
        expect(prompt).not.toContain("\u001b[");
        await ctx.save();
        const state = ctx.store.getRunState<RunState>(ctx.run.id);
        expect(state?.feedback).toBe(expected);
        if (mode === "unchanged") {
          expect(check).not.toHaveBeenCalled();
          expect(state?.feedbackProof).toEqual(before);
        } else if (mode === "fresh") {
          const scope = gatePrivacyScope.getStore();
          expect(verifier(registry, scope?.signer).verify(state?.feedbackProof, "feedback", expected)).toBe(
            true,
          );
          await ctx.checkFeedback();
          expect(check).toHaveBeenCalledTimes(1);
        } else expect(state?.feedbackProof).toBeUndefined();
        ctx.state.feedback = null;
        await ctx.checkFeedback();
        expect(ctx.state.feedbackProof).toBeUndefined();
      } finally {
        invoke.mockRestore();
        check.mockRestore();
      }
    }),
);
