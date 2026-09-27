import { expect, test } from "bun:test";
import { Factory } from "../src/app.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { RunContext } from "../src/pipeline/context.ts";
import type { Policy } from "../src/router/catalog.ts";
import { answer, evalFixture } from "./evals-support.ts";

test("pipeline and concierge use the same role selection with and without an HTTP endpoint", async () => {
  for (const openai of [true, false]) {
    const f = await evalFixture();
    const calls: { name: string; noTools: boolean | undefined }[] = [];
    const harness = (name: string) =>
      fakeHarness((spec) => {
        calls.push({ name, noTools: spec.noTools });
        return {
          structured: spec.prompt.startsWith("Interpret")
            ? { action: { type: "reply", text: "Hello" } }
            : answer,
        };
      });
    const factory = new Factory(f.cfg, {
      store: f.factory.store,
      models: [
        {
          id: "test-model",
          provider: "provider",
          model: "test",
          vendor: "other",
          origin: "unknown",
          baseOrigin: "unknown",
          supportedEfforts: [],
          tier: 1,
          price: { input: 1, output: 1 },
        },
      ],
      providers: [
        {
          id: "provider",
          label: "test",
          harness: "fake",
          billing: "free",
          maxConcurrent: 1,
          openaiBaseUrl: openai ? "http://unused.invalid" : undefined,
        },
      ],
      harnesses: { fake: harness("fake"), llm: harness("llm") },
      policy: {
        triage: { default: ["test-model"] },
        chat: { default: ["test-model"] },
        summarize: { default: ["test-model"] },
        implement: { default: ["test-model"] },
      } as Policy,
    });
    try {
      const repo = factory.store.upsertRepo({
        slug: "fixture/repo",
        kind: "local",
        localPath: f.source,
        url: null,
        defaultBranch: "main",
        mergePolicy: "none",
      });
      const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "Fix" });
      const stage = factory.store.startStage(run.id, "triage", 0);
      const context = new RunContext(factory.deps, run, repo, new AbortController().signal);
      for (const role of ["triage", "summarize", "implement"] as const)
        await context.invoke({ role, stage, prompt: "Classify", mode: "readonly", complexity: "small" });
      await factory.concierge.submit("test", { type: "text", text: "hello" });
      expect(calls).toEqual([
        { name: openai ? "llm" : "fake", noTools: true },
        { name: openai ? "llm" : "fake", noTools: true },
        { name: "fake", noTools: false },
        { name: openai ? "llm" : "fake", noTools: true },
      ]);
    } finally {
      await factory.stop();
      await f.close();
    }
  }
});

test("evidence selection does not let newer effort variants replace each other", async () => {
  const { evidence } = await import("./evals-policy-support.ts");
  const { selectEvidence } = await import("../src/evals/policy.ts");
  const low = evidence("triage", ["codex/luna@low"], { id: "low", finishedAt: 2000 });
  const high = evidence("triage", ["codex/luna@high"], { id: "high", finishedAt: 3000 });
  const unknown = evidence("triage", ["codex/luna"], { id: "unknown", finishedAt: 4000 });
  expect(selectEvidence([low, high, unknown]).map((e) => [e.modelId, e.run.id])).toEqual([
    ["codex/luna", "unknown"],
    ["codex/luna@high", "high"],
    ["codex/luna@low", "low"],
  ]);
});
