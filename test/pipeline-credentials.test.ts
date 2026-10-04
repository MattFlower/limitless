import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { Store } from "../src/db/store.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { customProvider, providerFixture } from "./provider-config-support.ts";

test("shared invocation recording redacts configured credentials including thrown errors and structured events", async () => {
  const secret = "FAKE_PIPELINE_CREDENTIAL_734";
  const fixture = providerFixture(
    [{ ...customProvider, api_key_env: "MAC_MLX_KEY" }],
    `MAC_MLX_KEY=${secret}\n`,
  );
  const store = new Store(":memory:");
  const cfg = fixture.load();
  mkdirSync(cfg.paths.runs, { recursive: true });
  const factory = new Factory(cfg, {
    store,
    harnesses: {
      claude: fakeHarness((spec) => {
        spec.onEvent({ type: "stderr", text: `ordinary diagnostic ${secret}` });
        spec.onEvent({
          type: "tool_call",
          id: "call",
          name: "inspect",
          input: { nested: [{ [secret]: secret }] },
        });
        writeFileSync(spec.logPath, spec.redactOutput?.(`ordinary diagnostic ${secret}`) ?? secret);
        return { fault: "throw", error: `ordinary diagnostic ${secret}` };
      }),
    },
  });
  try {
    const repo = store.upsertRepo({
      slug: "fixture/repo",
      kind: "local",
      localPath: fixture.root,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "test" });
    const stage = store.startStage(run.id, "triage", 0);
    const context = new RunContext(factory.deps, run, repo, new AbortController().signal);
    const outcome = await context.invoke({
      role: "triage",
      stage,
      prompt: "test",
      mode: "readonly",
      complexity: "small",
      constraints: { only: "claude/haiku" },
    });
    expect(outcome.result.error).toBe("ordinary diagnostic [credential]");
    const invocations = store.listInvocations(run.id);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.error).toBe("ordinary diagnostic [credential]");
    expect(JSON.stringify(store.listEvents(run.id))).not.toContain(secret);
    expect(JSON.stringify(store.listEvents(run.id))).toContain("ordinary diagnostic");
    expect(readFileSync(join(cfg.paths.runs, run.id, `inv-${invocations[0]?.id}.log`), "utf8")).toBe(
      "ordinary diagnostic [credential]",
    );
  } finally {
    await factory.stop();
    store.close();
    fixture.close();
  }
});
