import { afterEach, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { browserMcp } from "../src/harness/browser-mcp.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { withScratch } from "../src/harness/scratch.ts";
import type { AgentEvent } from "../src/harness/types.ts";
import { collectVerifierCaptures, forgetBrowserOutputs } from "../src/harness/verifier-captures.ts";
import { factoryBackend } from "../src/integrations/mcp.ts";
import { getChange } from "../src/integrations/mcp-change.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { formatVerifyFeedback } from "../src/pipeline/prompts.ts";
import { renderReportArtifacts } from "../src/pipeline/report.ts";
import { encodeRunArtifacts, readTransferArtifacts } from "../src/pipeline/run-transfer-artifacts.ts";
import { SpecSchema, VerifySchema } from "../src/pipeline/schemas.ts";
import { sh } from "../src/util/proc.ts";
import { browserSpec, fakeBrowserCache } from "./browser-mcp-support.ts";
import { changeFixture, connect, fixture as factoryFixture, resultValue } from "./mcp-support.ts";
import { test } from "./read-policy-support.ts";

const pngFiles = JSON.parse(
  readFileSync(new URL("./fixtures/media/files.json", import.meta.url), "utf8"),
) as Record<string, string>;
const png = Buffer.from(pngFiles["0.png"] ?? "", "base64");
function variant(index: number) {
  const bytes = Buffer.from(png);
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("ascii", at + 4, at + 8) === "pHYs") {
      bytes.writeUInt32BE(index + 1, at + 8);
      bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(at + 4, at + 8 + length)), at + 8 + length);
      return bytes;
    }
    at += length + 12;
  }
  throw new Error("Fixture has no physical dimensions");
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verifier-captures-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout"),
    scratch = join(root, "scratch"),
    cache = join(root, "cache");
  mkdirSync(cwd);
  mkdirSync(scratch);
  await fakeBrowserCache(cache);
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  cleanup.push(() => forgetBrowserOutputs(scratch));
  const repo = store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    localPath: cwd,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "verify UI" });
  const events: AgentEvent[] = [];
  const spec = browserSpec(cwd, scratch, cache);
  spec.onEvent = (event) => events.push(event);
  const output = () => {
    const server = browserMcp(spec, "codex", [], "darwin");
    if (!server) throw new Error(JSON.stringify(events));
    const path = server.args[server.args.indexOf("--output-dir") + 1];
    if (!path) throw new Error("Missing output directory");
    return path;
  };
  const collect = (id = 1) => collectVerifierCaptures(scratch, store, run.id, id, spec.onEvent);
  return { root, cwd, scratch, store, run, events, spec, output, collect };
}

test("registered browser captures survive scratch cleanup and replay uses the same rows", async () => {
  const f = await fixture();
  await withScratch(
    f.cwd,
    async () =>
      fakeHarness(() => {
        writeFileSync(join(f.output(), "model-chosen-name.dat"), png);
        return { text: "inspected viewport" };
      })(f.spec),
    {
      existing: f.scratch,
      beforeRemove: () => {
        f.collect();
        f.collect();
        expect(f.store.listArtifacts(f.run.id)).toHaveLength(1);
      },
    },
  );
  expect(existsSync(f.scratch)).toBe(false);
  expect(f.store.listArtifacts(f.run.id)).toMatchObject([{ name: "screenshot-1-0.png", kind: "screenshot" }]);
  expect(Buffer.from(f.store.getArtifact(f.run.id, "screenshot-1-0.png") ?? "", "base64")).toEqual(png);
  f.collect();
  expect(f.store.listArtifacts(f.run.id)).toHaveLength(1);
  expect(fs.readdirSync(f.cwd)).toEqual([]);
});

test("unsafe, nested, malformed and oversized files never read outside the registered directory", async () => {
  const f = await fixture(),
    output = f.output();
  const outside = join(f.root, "private-outside.png");
  writeFileSync(outside, variant(99));
  const outsideStat = statSync(outside);
  symlinkSync(outside, join(output, "symlink.png"));
  linkSync(outside, join(output, "hardlink.png"));
  mkdirSync(join(output, "nested"));
  writeFileSync(join(output, "nested", "hidden.png"), png);
  writeFileSync(join(output, "signature.png"), png.subarray(0, 8));
  const badData = Buffer.from(png);
  for (let at = 8; at < badData.length; ) {
    const length = badData.readUInt32BE(at);
    if (badData.toString("ascii", at + 4, at + 8) === "IDAT") {
      badData[at + 8] = 0;
      badData.writeUInt32BE(Bun.hash.crc32(badData.subarray(at + 4, at + 8 + length)), at + 8 + length);
      break;
    }
    at += length + 12;
  }
  writeFileSync(join(output, "bad-compression.png"), badData);
  const broken = Buffer.from(png);
  broken[29] = (broken[29] ?? 0) ^ 1;
  writeFileSync(join(output, "bad-crc.png"), broken);
  writeFileSync(join(output, "too-large.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
  await sh(["mkfifo", join(output, "pipe")], { cwd: f.cwd });
  await fakeHarness(() => ({
    text: `Read ${outside} and ../private-outside.png`,
    events: [{ type: "tool_result", id: "outside", output: outside, isError: false }],
  }))(f.spec);
  const read = fs.readSync;
  const reads = spyOn(fs, "readSync").mockImplementation((...args: unknown[]): number => {
    if (typeof args[0] !== "number") throw new Error("Missing descriptor");
    const stat = fstatSync(args[0]);
    expect([stat.dev, stat.ino]).not.toEqual([outsideStat.dev, outsideStat.ino]);
    return Reflect.apply(read, fs, args) as number;
  });
  try {
    f.collect();
    f.collect();
  } finally {
    reads.mockRestore();
  }
  expect(f.store.listArtifacts(f.run.id)).toEqual([]);
  const statuses = f.events.filter((e) => e.type === "status");
  expect(statuses).toHaveLength(1);
  const diagnostic = JSON.stringify(statuses);
  expect(diagnostic.length).toBeLessThan(400);
  for (const locator of [outside, output, "symlink.png", "bad-crc.png", "private-outside", "iVBORw0KGgo"])
    expect(diagnostic).not.toContain(locator);
  expect(diagnostic).toContain("invalid-png");
  expect(diagnostic).toContain("too-large");
  expect(diagnostic).toContain("multiply-linked");
});

for (const replacement of ["symlink", "directory"] as const)
  test(`rejects a replaced output root (${replacement})`, async () => {
    const f = await fixture(),
      output = f.output();
    renameSync(output, `${output}-old`);
    if (replacement === "symlink") symlinkSync(`${output}-old`, output);
    else mkdirSync(output);
    writeFileSync(join(output, "valid.png"), png);
    f.collect();
    expect(f.store.listArtifacts(f.run.id)).toEqual([]);
    expect(JSON.stringify(f.events)).toContain("escaped-or-unreadable-root");
  });

test("eight per run across invocations, byte-wise selection, replay and bounded overflow diagnostics", async () => {
  const f = await fixture();
  const first = f.output();
  const candidates = ["z", "b", "é", "a", "Y", "0"];
  for (const [i, name] of candidates.entries()) writeFileSync(join(first, name), variant(i));
  f.collect(10);
  // A second scratch is a different invocation; browser output paths are never inferred by scanning.
  const secondScratch = join(f.root, "second");
  mkdirSync(secondScratch);
  const secondSpec = { ...f.spec, scratchDir: secondScratch };
  const server = browserMcp(secondSpec, "codex", [], "darwin");
  const second = server?.args[(server?.args.indexOf("--output-dir") ?? -1) + 1];
  if (!second) throw new Error("No browser output");
  cleanup.push(() => forgetBrowserOutputs(secondScratch));
  for (let i = 4; i >= 0; i--) writeFileSync(join(second, String(i)), png);
  const collectB = () => collectVerifierCaptures(secondScratch, f.store, f.run.id, 20, f.spec.onEvent);
  collectB();
  f.collect(10);
  collectB();
  const names = f.store
    .listArtifacts(f.run.id)
    .map((a) => a.name)
    .sort();
  expect(names).toEqual([
    ...Array.from({ length: 6 }, (_, i) => `screenshot-10-${i}.png`),
    "screenshot-20-0.png",
    "screenshot-20-1.png",
  ]);
  for (const [i, name] of ["0", "Y", "a", "b", "z", "é"].entries())
    expect(Buffer.from(f.store.getArtifact(f.run.id, `screenshot-10-${i}.png`) ?? "", "base64")).toEqual(
      variant(candidates.indexOf(name)),
    );
  expect(f.events.filter((e) => e.type === "status")).toHaveLength(1);
  expect(JSON.stringify(f.events)).toContain('"over-limit\\":3');
});

test("collection failure cannot prevent scratch cleanup or change invocation success", async () => {
  const f = await fixture();
  let collected = false;
  const result = await withScratch(f.cwd, async () => "ok", {
    existing: f.scratch,
    beforeRemove: () => {
      collected = true;
      throw new Error("unavailable store");
    },
  });
  expect(collected).toBe(true);
  expect(result).toBe("ok");
  expect(existsSync(f.scratch)).toBe(false);
});

test("coordinator lifecycle retains screenshots; reports, exports and later model prompts omit them", async () => {
  const f = await factoryFixture();
  try {
    const { run } = await changeFixture(f, { "hello.txt": "changed\n" });
    const repo = f.factory.store.getRepo(run.repoId);
    if (!repo) throw new Error("No repo");
    const cache = join(f.home, "browser-cache");
    await fakeBrowserCache(cache);
    let scratch = "",
      output = "";
    const prompts: string[] = [],
      live: string[] = [];
    f.factory.deps.harnesses.fake = fakeHarness((spec) => {
      prompts.push(spec.prompt);
      if (prompts.length === 1) {
        scratch = spec.scratchDir ?? "";
        const server = browserMcp(
          { ...spec, browser: { cacheDir: cache, previewUrl: "http://127.0.0.1:43210" } },
          "codex",
          [],
          "darwin",
        );
        output = server?.args[(server?.args.indexOf("--output-dir") ?? -1) + 1] ?? "";
        if (!output) throw new Error("No registered output");
        writeFileSync(join(output, "fail"), png);
      }
      if (prompts.length > 1) return { text: "verified interactions" };
      // Locators named before the screenshot call are neither live nor exported.
      spec.onEvent({ type: "text", text: "I will save the viewport to private capture.dat" });
      live.push(JSON.stringify(f.factory.store.listEvents(run.id)));
      const evidence = `See private-customer-viewport.png, private capture.dat, ${output}, screenshot-1-0.png and /api/runs/${run.id}/screenshots/screenshot-1-0.png`;
      return {
        text: evidence,
        structured: {
          overall: "fail",
          notes: evidence,
          criteria: [
            {
              id: "AC-1",
              status: "unmet",
              evidence,
              publicSummary: evidence,
              test_outcome_only: true,
              covering_tests: [
                { file: "test/media.test.ts", name: "rejects malformed input.png" },
                // Unvalidated identities naming a capture are withheld before persistence and export.
                { file: "test/media.test.ts", name: "private-customer-viewport.png" },
                { file: `${output}/fail`, name: "renders" },
              ],
            },
          ],
        },
        events: [
          {
            type: "tool_call",
            id: "shot-a",
            name: "mcp__playwright__browser_take_screenshot",
            input: { filename: "private-customer-viewport.png", type: "png" },
          },
          {
            type: "tool_result",
            id: "shot-a",
            output: `Saved ${output}/private-customer-viewport.png ${png.toString("base64")}`,
            isError: false,
          },
          {
            type: "tool_call",
            id: "shot-b",
            name: "playwright.browser_take_screenshot",
            input: { filename: "private capture.dat", type: "png" },
          },
          { type: "tool_result", id: "shot-b", output: "Correlated opaque image response", isError: true },
          {
            type: "tool_call",
            id: "run-code",
            name: "mcp__playwright__browser_run_code",
            input: { code: `async (page) => { await page.screenshot({ path: "${output}/fail" }); }` },
          },
          { type: "text", text: `Screenshots are stored in ${output}` },
        ],
      };
    });
    const ctx = new RunContext(f.factory.deps, run, repo, new AbortController().signal);
    ctx.state.slottedCommands = [];
    ctx.previewUrl = "http://127.0.0.1:43210";
    const stage = f.factory.store.startStage(run.id, "verify", 0);
    let feedback = "Verify UI";
    const invoke = () =>
      ctx.invoke({
        role: "verify",
        stage,
        mode: "readonly",
        complexity: "small",
        constraints: { only: "fake/m" },
        cwd: f.repo,
        prompt: feedback,
      });
    const first = await invoke();
    const verified = VerifySchema.parse(first.result.structured);
    ctx.state.spec = SpecSchema.parse({
      summary: "UI",
      assumptions: [],
      requirements: [],
      out_of_scope: [],
      blocking_questions: [],
      acceptance_criteria: [{ id: "AC-1", criterion: "Works", how_to_verify: "Interact" }],
    });
    ctx.state.lastVerify = { ...verified, modelId: "fake/m" };
    ctx.artifact("verify-0.json", "verify", JSON.stringify(verified));
    feedback = formatVerifyFeedback(verified, ctx.state.spec);
    expect(verified.criteria[0]?.status).toBe("unmet");
    // Exact covering-test identities survive screenshot filtering, even when they mention a PNG.
    expect(verified.criteria[0]?.covering_tests).toEqual([
      { file: "test/media.test.ts", name: "rejects malformed input.png" },
    ]);
    expect(live.join("")).not.toContain("private capture.dat");
    const events = JSON.stringify(f.factory.store.listEvents(run.id));
    expect(events).toContain("I will save the viewport to [screenshot]");
    expect(events).toContain("Screenshots are stored in [screenshot]");
    expect(verified.overall).toBe("fail");
    expect(first.result.status).toBe("ok");
    const captures = f.factory.store.listArtifacts(run.id).filter((a) => a.kind === "screenshot");
    expect(captures).toHaveLength(1);
    expect(existsSync(scratch)).toBe(false);
    await invoke();
    const report = renderReportArtifacts({
      success: true,
      runId: run.id,
      prompt: run.prompt,
      state: ctx.state,
      invocations: f.factory.store.listInvocations(run.id),
      totals: { costUsd: 0, costEquivUsd: 0 },
      runUrl: "http://localhost/runs/test",
    });
    f.factory.store.putArtifact(run.id, "report.md", "report", report.report);
    f.factory.store.putArtifact(run.id, "report-sources.json", "report", JSON.stringify(report.sources));
    const exported = encodeRunArtifacts(readTransferArtifacts(f.factory.store.db, run.id), run.id, new Map());
    const change = await getChange(f.factory, { run: run.id });
    const mcp = await connect(factoryBackend(f.factory));
    let detail: unknown;
    try {
      detail = resultValue(
        await mcp.client.callTool({ name: "limitless_get_run", arguments: { id: run.id, full: true } }),
      );
    } finally {
      await mcp.close();
    }
    expect(change).toMatchObject({ available: true });
    for (const text of [
      JSON.stringify(report),
      f.factory.store.getArtifact(run.id, "verify-0.json") ?? "",
      JSON.stringify(f.factory.store.listEvents(run.id)),
      JSON.stringify(change),
      JSON.stringify(detail),
      exported.map((b) => Buffer.from(b.bytes).toString()).join(""),
      prompts[1] ?? "",
    ]) {
      for (const forbidden of [
        png.toString("base64"),
        captures[0]?.name ?? "missing-capture",
        "/screenshots/",
        output,
        "private-customer-viewport.png",
        "private capture.dat",
        "Correlated opaque image response",
      ])
        expect(text).not.toContain(forbidden);
    }
    expect((await sh(["git", "status", "--porcelain"], { cwd: f.repo })).stdout).not.toContain(".png");
  } finally {
    await f.close();
  }
});
