import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { Store } from "../src/db/store.ts";
import { gatePrivacyScope } from "../src/gates/text-privacy.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { createPrivacyRegistry } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker } from "../src/util/privacy-checker.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import { verifier } from "../src/util/privacy-proof.ts";
import { registerCredential } from "../src/util/proc.ts";
import { privacyPort } from "./privacy-support.ts";
import { providerFixture } from "./provider-config-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture() {
  const f = providerFixture([]),
    store = new Store(":memory:");
  const factory = new Factory(f.load(), { store });
  cleanups.push(async () => {
    await factory.stop();
    store.close();
    f.close();
  });
  const registry = createPrivacyRegistry();
  provisionPrivacyPolicy(f.configDir, [], { registry });
  const checker = createPrivacyChecker({ registry, workerFactory: privacyPort });
  cleanups.push(() => checker.dispose());
  const privacy = { registry, checker, signer: () => Buffer.alloc(32, 43) };
  const repo = store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    localPath: f.work,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "feedback" });
  const load = () =>
    gatePrivacyScope.run(
      privacy,
      () => new RunContext(factory.deps, run, repo, new AbortController().signal),
    );
  const ctx = load();
  const prepare = () => gatePrivacyScope.run(privacy, () => ctx.prepareFeedback());
  return { ...f, store, ctx, load, prepare, privacy };
}
const note = "[previous feedback withheld: unverified]";
test("saved URL feedback with a newly registered encoded credential is withheld before logging", async () => {
  const f = fixture(),
    token = `late+/${crypto.randomUUID()}=`,
    url = `https://example.com/check?token=${encodeURIComponent(token)}`;
  f.ctx.state.feedback = url;
  await f.prepare();
  await f.ctx.save();
  expect(f.load().state.feedback).toBe(url);
  registerCredential("FEEDBACK_ENCODED_LATER", token);
  const protect = spyOn(f.privacy.checker, "protectText");
  try {
    const loaded = f.load();
    loaded.log(`Gate feedback: ${loaded.state.feedback}`);
    await gatePrivacyScope.run(f.privacy, () => loaded.prepareFeedback());
    expect(loaded.state.feedback).toBe(note);
    expect(loaded.loadedFeedback).toBe(note);
    expect(loaded.state.feedbackProof).toBeUndefined();
    expect(JSON.stringify(f.store.listEvents(loaded.run.id))).not.toContain(encodeURIComponent(token));
    expect(protect).not.toHaveBeenCalled();
  } finally {
    protect.mockRestore();
  }
});
test.each(["legacy", "policy", "credential", "writeState", "writeRun"])(
  "resume withholds %s feedback before logging",
  async (kind) => {
    const f = fixture(),
      text = `saved-feedback-${crypto.randomUUID()}`;
    f.ctx.state.feedback = text;
    if (kind !== "legacy") await f.prepare();
    await f.ctx.save();
    if (kind === "policy") writeFileSync(join(f.configDir, "private-strings.txt"), "new-private-entry\n");
    if (kind === "credential") registerCredential("FEEDBACK_LATER", text);
    if (kind === "writeState" || kind === "writeRun") {
      f.ctx.state.feedback = "replacement without a new proof";
      if (kind === "writeState") f.ctx.checkpointer.writeState(f.ctx.run.id, f.ctx.state);
      else f.ctx.checkpointer.writeRun(f.ctx.run.id, {}, f.ctx.state);
    }
    const loaded = f.load();
    loaded.log(`Gate feedback: ${loaded.state.feedback}`);
    expect(loaded.state.feedback).toBe(note);
    expect(loaded.loadedFeedback).toBe(note);
    expect(loaded.state.feedbackProof).toBeUndefined();
    expect(JSON.stringify(f.store.listEvents(loaded.run.id))).not.toContain(text);
  },
);
test("new feedback is signed once, saved, and resumed with its original bytes and MAC", async () => {
  const f = fixture();
  const text = "fix https://example.com/check?value=clean%2B%2F%3D";
  f.ctx.state.feedback = text;
  const protect = spyOn(f.privacy.checker, "protectText");
  try {
    await f.prepare();
    expect(protect).toHaveBeenCalledTimes(1);
    const proof = f.ctx.state.feedbackProof;
    expect(
      verifier(f.privacy.registry, f.privacy.signer).verify(proof, "feedback", f.ctx.state.feedback),
    ).toBe(true);
    await f.ctx.save();
    expect(f.store.getRunState<RunState>(f.ctx.run.id)?.feedbackProof).toEqual(proof);
    const loaded = f.load();
    await gatePrivacyScope.run(f.privacy, () => loaded.prepareFeedback());
    expect(loaded.state.feedback).toBe(text);
    expect(loaded.state.feedbackProof).toEqual(proof);
    expect(protect).toHaveBeenCalledTimes(1);
  } finally {
    protect.mockRestore();
  }
});
test("fresh refused feedback becomes a fixed unsigned note and is not checked again", async () => {
  const f = fixture();
  writeFileSync(join(f.configDir, "private-strings.txt"), "refuse-this-feedback\n");
  f.ctx.state.feedback = "refuse-this-feedback";
  const protect = spyOn(f.privacy.checker, "protectText");
  try {
    await f.prepare();
    await f.prepare();
    await f.ctx.save();
    expect(f.ctx.state.feedback).toStartWith("[previous feedback withheld:");
    expect(f.ctx.state.feedback).not.toContain("refuse-this-feedback");
    expect(f.ctx.state.feedbackProof).toBeUndefined();
    expect(protect).toHaveBeenCalledTimes(1);
    expect(f.store.getRunState<RunState>(f.ctx.run.id)?.feedbackProof).toBeUndefined();
  } finally {
    protect.mockRestore();
  }
});
