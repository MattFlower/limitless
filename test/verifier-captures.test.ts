import { afterEach, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  appendFileSync,
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
import { runClaude } from "../src/harness/claude.ts";
import { runCodex } from "../src/harness/codex.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { withScratch } from "../src/harness/scratch.ts";
import type { AgentEvent } from "../src/harness/types.ts";
import {
  anchored,
  collectVerifierCaptures,
  forgetBrowserOutputs,
  screenshotPrivacy,
} from "../src/harness/verifier-captures.ts";
import { factoryBackend } from "../src/integrations/mcp.ts";
import { getChange } from "../src/integrations/mcp-change.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { formatVerifyFeedback } from "../src/pipeline/prompts.ts";
import { renderReportArtifacts } from "../src/pipeline/report.ts";
import { encodeRunArtifacts, readTransferArtifacts } from "../src/pipeline/run-transfer-artifacts.ts";
import { SpecSchema, VerifySchema } from "../src/pipeline/schemas.ts";
import { type ProcOptions, sh } from "../src/util/proc.ts";
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
  const collect = (id = 1) => collectVerifierCaptures(store, run.id, id, spec.onEvent)(scratch);
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
        expect(f.store.listScreenshots(f.run.id)).toHaveLength(1);
        expect(
          f.store.db.query("SELECT count(*) AS n FROM artifacts WHERE kind = 'screenshot'").get(),
        ).toEqual({ n: 0 });
        expect(
          f.store.db.query("SELECT count(*) AS n FROM verifier_screenshots WHERE run_id = ?").get(f.run.id),
        ).toEqual({ n: 1 });
      },
    },
  );
  expect(existsSync(f.scratch)).toBe(false);
  expect(f.store.listScreenshots(f.run.id)).toMatchObject([{ name: "screenshot-1-0.png" }]);
  expect(Buffer.from(f.store.getScreenshot(f.run.id, "screenshot-1-0.png") ?? "", "base64")).toEqual(png);
  f.collect();
  expect(f.store.listScreenshots(f.run.id)).toHaveLength(1);
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
  expect(f.store.listScreenshots(f.run.id)).toEqual([]);
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
    expect(f.store.listScreenshots(f.run.id)).toEqual([]);
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
  const collectB = () => collectVerifierCaptures(f.store, f.run.id, 20, f.spec.onEvent)(secondScratch);
  collectB();
  f.collect(10);
  collectB();
  const names = f.store
    .listScreenshots(f.run.id)
    .map((a) => a.name)
    .sort();
  expect(names).toEqual([
    ...Array.from({ length: 6 }, (_, i) => `screenshot-10-${i}.png`),
    "screenshot-20-0.png",
    "screenshot-20-1.png",
  ]);
  for (const [i, name] of ["0", "Y", "a", "b", "z", "é"].entries())
    expect(Buffer.from(f.store.getScreenshot(f.run.id, `screenshot-10-${i}.png`) ?? "", "base64")).toEqual(
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
      const transcript = `${JSON.stringify({ early: "private-customer-viewport.png", root: output })}\n`;
      if (spec.holdTranscript) spec.holdTranscript(transcript);
      else appendFileSync(spec.logPath, transcript);
      spec.onEvent({ type: "text", text: "I will save the viewport to private capture.dat" });
      live.push(JSON.stringify(f.factory.store.listEvents(run.id)));
      const evidence = `See private-customer-viewport.png, [viewport](private%20capture.dat), private capture.dat, ${output}, screenshot-1-0.png and /api/runs/${run.id}/screenshots/screenshot-1-0.png`;
      return {
        text: evidence,
        structured: {
          overall: "fail",
          notes: evidence,
          criteria: [
            {
              id: "AC-1",
              status: "unmet",
              evidence: JSON.stringify({ "private-customer-viewport.png": "captured", sibling: evidence }),
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
    const captures = f.factory.store.listScreenshots(run.id);
    expect(captures).toHaveLength(1);
    expect(f.factory.store.listArtifacts(run.id).some((a) => a.kind === "screenshot")).toBe(false);
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
      f.factory.store.getArtifact(run.id, "report.md") ?? "",
      f.factory.store.getArtifact(run.id, "report-sources.json") ?? "",
      f.factory.store.getArtifact(run.id, "verify-0.json") ?? "",
      JSON.stringify(f.factory.store.listEvents(run.id)),
      JSON.stringify(change),
      JSON.stringify(detail),
      exported.map((b) => Buffer.from(b.bytes).toString()).join(""),
      prompts[1] ?? "",
      readFileSync(join(ctx.runDir, `inv-${first.invocation.id}.log`), "utf8"),
    ]) {
      for (const forbidden of [
        png.toString("base64"),
        captures[0]?.name ?? "missing-capture",
        "/screenshots/",
        output,
        "private-customer-viewport.png",
        "private capture.dat",
        "private%20capture.dat",
        "Correlated opaque image response",
      ])
        expect(text).not.toContain(forbidden);
    }
    expect((await sh(["git", "status", "--porcelain"], { cwd: f.repo })).stdout).not.toContain(".png");
  } finally {
    await f.close();
  }
});

test("URL-encoded screenshot locators are sanitized in Markdown, nested JSON and transcripts", () => {
  const privacy = screenshotPrivacy();
  const filename = "customer report (1):#1.png";
  const path = `/browser output/${filename}`;
  privacy.hold({
    type: "tool_call",
    id: "shot",
    name: "playwright.browser_take_screenshot",
    input: { filename },
  });
  privacy.remember(path);
  const locators = [filename, path].flatMap((value) => {
    const encoded = encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
    return [
      encodeURI(value),
      encodeURIComponent(value),
      encoded,
      encoded.replace(/%29/g, ")"),
      encoded.replace(/%[\da-f]{2}/gi, (token) => token.toLowerCase()),
      encoded.replace(/%3A/g, "%3a"),
      encoded.replace(/customer/g, "%63ustomer"),
    ];
  });
  for (const locator of locators) {
    const evidence = `[viewport](${locator})`;
    expect(privacy.data({ evidence })).toEqual({ evidence: "[viewport]([screenshot])" });
    expect(privacy.data({ notes: JSON.stringify({ evidence }) })).toEqual({
      notes: JSON.stringify({ evidence: "[viewport]([screenshot])" }),
    });
    privacy.hold({ type: "text", text: evidence });
    privacy.holdTranscript(evidence);
  }
  expect(
    privacy
      .drain()
      .slice(1)
      .every((event) => event.type === "text" && event.text === "[viewport]([screenshot])"),
  ).toBe(true);
  expect(privacy.drainLogs()).toBe("[viewport]([screenshot])\n".repeat(locators.length));
  expect(privacy.data({ notes: "ordinary%20documentation.md" }).notes).toBe("ordinary%20documentation.md");
  expect(privacy.data({ evidence: `[viewport](${locators[0]}) ordinary%20documentation.md` }).evidence).toBe(
    "[viewport]([screenshot]) ordinary%20documentation.md",
  );
  expect(privacy.data({ evidence: "Customer%20report%20%281%29%3a%231.png" }).evidence).toBe(
    "Customer%20report%20%281%29%3a%231.png",
  );
});

test("Markdown-escaped screenshot destinations are sanitized in evidence, held events and transcripts", () => {
  const privacy = screenshotPrivacy();
  privacy.remember("customer(1).png");
  privacy.remember("/browser output/customer report (1).png");
  const destinations = [
    String.raw`customer\(1\).png`,
    String.raw`customer\(1\)\.png`,
    String.raw`customer%20report%20\(1\).png`,
    String.raw`\/browser%20output\/customer report \(1\).png`,
  ];
  for (const destination of destinations) {
    const evidence = `[viewport](${destination})`;
    expect(privacy.data({ evidence })).toEqual({ evidence: "[viewport]([screenshot])" });
    expect(privacy.data({ notes: JSON.stringify({ evidence }) })).toEqual({
      notes: JSON.stringify({ evidence: "[viewport]([screenshot])" }),
    });
    expect(privacy.data({ notes: `saved ${JSON.stringify({ evidence })}` }).notes).toBe(
      `saved ${JSON.stringify({ evidence: "[viewport]([screenshot])" })}`,
    );
    privacy.hold({ type: "text", text: evidence });
    privacy.holdTranscript(`[stderr] ${evidence}`);
  }
  expect(privacy.drain()).toEqual(
    destinations.map(() => ({ type: "text", text: "[viewport]([screenshot])" })),
  );
  expect(privacy.drainLogs()).toBe("[stderr] [viewport]([screenshot])\n".repeat(destinations.length));
  const unrelated = String.raw`[docs](guide\(1\).md) customer(2).png`;
  expect(privacy.data({ evidence: unrelated }).evidence).toBe(unrelated);
});

test("character-referenced screenshot destinations are sanitized in evidence, held events and transcripts", () => {
  const privacy = screenshotPrivacy();
  privacy.remember("customer(1).png");
  const destinations = [
    "customer&#40;1&#41;.png",
    "customer&#x28;1&#X29;&#46;png",
    "customer&#0040;1&rpar;&period;png",
    "&#99;ustomer&lpar;1%29.png",
    String.raw`customer\(1&#41;\.png`,
  ];
  for (const destination of destinations) {
    const evidence = `[viewport](${destination})`;
    expect(privacy.data({ evidence })).toEqual({ evidence: "[viewport]([screenshot])" });
    expect(privacy.data({ notes: `saved ${JSON.stringify({ evidence })}` }).notes).toBe(
      `saved ${JSON.stringify({ evidence: "[viewport]([screenshot])" })}`,
    );
    privacy.hold({ type: "text", text: evidence });
    privacy.holdTranscript(evidence);
  }
  expect(privacy.drain()).toEqual(
    destinations.map(() => ({ type: "text", text: "[viewport]([screenshot])" })),
  );
  expect(privacy.drainLogs()).toBe("[viewport]([screenshot])\n".repeat(destinations.length));
  for (const unrelated of ["customer&#40;2&#41;.png", "Customer&lpar;1&rpar;.png", "customer&unknown;1).png"])
    expect(privacy.data({ evidence: `[docs](${unrelated}) &amp;` }).evidence).toBe(
      `[docs](${unrelated}) &amp;`,
    );
});

test("filenames containing literal escape syntax are sanitized in every spelling", () => {
  const privacy = screenshotPrivacy();
  privacy.remember("customer%20report.png");
  privacy.remember("/out/a&#40;b.png");
  const destinations = [
    "customer%2520report.png",
    "customer%20report.png",
    "customer%25%32%30report.png",
    "/out/a&amp;#40;b.png",
    "/out/a%26%2340%3bb.png",
    "a&#40;b.png",
  ];
  for (const destination of destinations) {
    const evidence = `[viewport](${destination})`;
    expect(privacy.data({ evidence })).toEqual({ evidence: "[viewport]([screenshot])" });
    expect(privacy.data({ notes: `saved ${JSON.stringify({ evidence })}` }).notes).toBe(
      `saved ${JSON.stringify({ evidence: "[viewport]([screenshot])" })}`,
    );
    privacy.hold({ type: "text", text: evidence });
    privacy.holdTranscript(`[stderr] ${evidence}`);
  }
  expect(privacy.drain()).toEqual(
    destinations.map(() => ({ type: "text", text: "[viewport]([screenshot])" })),
  );
  expect(privacy.drainLogs()).toBe("[stderr] [viewport]([screenshot])\n".repeat(destinations.length));
  expect(privacy.data({ evidence: "customer%2521report.png" }).evidence).toBe("customer%2521report.png");
});

test("backslash-bearing screenshot filenames sanitize nonmatching backslash runs in bounded time", () => {
  const slash = "\\";
  const privacy = screenshotPrivacy();
  privacy.remember(String.raw`customer\report.png`);
  privacy.remember(`${slash.repeat(10)}X.png`);
  const started = performance.now();
  const runs = [
    `customer${slash.repeat(80)}report.txt`,
    `${slash.repeat(40)}Y.png`,
    `${slash.repeat(5000)}Z ${"customer\\".repeat(2000)}`,
  ];
  for (const evidence of runs) {
    expect(privacy.data({ evidence }).evidence).toBe(evidence);
    privacy.holdTranscript(JSON.stringify({ evidence }));
  }
  expect(privacy.drainLogs()).toBe(runs.map((evidence) => `${JSON.stringify({ evidence })}\n`).join(""));
  expect(performance.now() - started).toBeLessThan(1000);
  for (const evidence of [String.raw`customer\report.png`, String.raw`customer\\report.png`])
    expect(privacy.data({ evidence: `see ${evidence}` }).evidence).toBe("see [screenshot]");
  expect(privacy.data({ notes: `saved ${JSON.stringify(`${slash.repeat(10)}X.png`)}` }).notes).toBe(
    'saved "[screenshot]"',
  );
});

test("held tool results sanitize JSON-escaped and nested serialized screenshot filenames", () => {
  for (const filename of ['customer"private.png', "customer\nprivate.png", '["customer"]']) {
    const privacy = screenshotPrivacy();
    privacy.remember(filename);
    expect(privacy.data({ evidence: filename }).evidence).toBe("[screenshot]");
    const once = JSON.stringify({ path: filename });
    const outputs = [once, JSON.stringify([{ type: "text", text: once }]), `saved: ${once}`];
    for (const output of outputs)
      privacy.hold({ type: "tool_result", id: "run-code", isError: false, output });
    const drained = privacy.drain();
    expect(drained).toHaveLength(3);
    for (const event of drained) {
      const serialized = JSON.stringify(event);
      expect(serialized).toContain("[screenshot]");
      for (const level of [
        filename,
        JSON.stringify(filename).slice(1, -1),
        JSON.stringify(JSON.stringify(filename)),
      ])
        expect(serialized).not.toContain(level.replace(/^"|"$/g, ""));
    }
    expect(JSON.parse((drained[0] as { output: string }).output).path).not.toBe(filename);
  }
});

test("filename keys and nested JSON are sanitized before events are persisted; collisions withhold rewritten entries", async () => {
  const f = await fixture(),
    privacy = screenshotPrivacy();
  writeFileSync(join(f.output(), "customer-private.png"), png);
  privacy.hold({
    type: "tool_result",
    id: "code",
    isError: false,
    output: JSON.stringify({
      "customer-private.png": "captured",
      sibling: "keep",
      '{ "ordinary": "key" }': "unchanged",
      nested: JSON.stringify([{ "customer-private.png": "nested" }]),
      collisions: { "customer-private.png": "drop-one", "screenshot-1-0.png": "drop-two" },
      existing: { "[screenshot]": "original", "customer-private.png": "drop-three" },
      status: "fail",
    }),
  });
  collectVerifierCaptures(f.store, f.run.id, 1, f.spec.onEvent, privacy)(f.scratch);
  privacy.remember("fail"); // Enum values still pass through unchanged.
  for (const event of privacy.drain())
    f.store.addEvent({ runId: f.run.id, type: "tool_result", message: "", data: event });
  const events = JSON.stringify(f.store.listEvents(f.run.id));
  expect(events).not.toContain("customer-private.png");
  const event = f.store.listEvents(f.run.id)[0]?.data as { output: string };
  expect(JSON.parse(event.output)).toEqual({
    "[screenshot]": "captured",
    sibling: "keep",
    '{ "ordinary": "key" }': "unchanged",
    nested: '[{"[screenshot]":"nested"}]',
    collisions: {},
    existing: { "[screenshot]": "original" },
    status: "fail",
  });
});

/** Spies on every child open, anchored or by path, so a revert to path-based opens still meets the swap. */
function spyChildOpens(child: string, around: { before?: () => void; after?: () => void }) {
  const open = fs.openSync,
    anchoredOpen = anchored.open,
    others: { args: Parameters<typeof open>; fd: number }[] = [];
  const paths = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof open>) => {
    if (args[0] !== child) {
      const fd = Reflect.apply(open, fs, args) as number;
      others.push({ args, fd });
      return fd;
    }
    around.before?.();
    const fd = Reflect.apply(open, fs, args) as number;
    around.after?.();
    return fd;
  });
  const fds = spyOn(anchored, "open").mockImplementation((...args: Parameters<typeof anchoredOpen>) => {
    around.before?.();
    const fd = anchoredOpen(...args);
    around.after?.();
    return fd;
  });
  return {
    others,
    restore: () => {
      paths.mockRestore();
      fds.mockRestore();
    },
  };
}
function spyOutsideReads(outsideFile: string) {
  const outsideStat = statSync(outsideFile),
    read = fs.readSync,
    state = { outsideRead: false };
  const reads = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
    const stat = fstatSync(Number(args[0]));
    if (stat.dev === outsideStat.dev && stat.ino === outsideStat.ino) state.outsideRead = true;
    return Reflect.apply(read, fs, args) as number;
  });
  return { state, restore: () => reads.mockRestore() };
}
async function swapFixture() {
  const f = await fixture(),
    output = f.output(),
    outside = join(f.root, "outside"),
    outsidePng = variant(99);
  writeFileSync(join(output, "capture.png"), png);
  mkdirSync(outside);
  writeFileSync(join(outside, "capture.png"), outsidePng);
  const swapIn = () => {
    renameSync(output, `${output}-old`);
    renameSync(outside, output);
  };
  const restore = () => {
    renameSync(output, outside);
    renameSync(`${output}-old`, output);
  };
  const storedBytes = () =>
    f.store.listScreenshots(f.run.id).map(({ name }) => f.store.getScreenshot(f.run.id, name));
  return { f, output, outside, outsidePng, swapIn, restore, storedBytes };
}

test("a root swapped at child open is rejected before reading outside bytes", async () => {
  const { f, output, outside, outsidePng, swapIn, storedBytes } = await swapFixture();
  let swapped = false;
  const opens = spyChildOpens(join(output, "capture.png"), {
    before: () => {
      if (swapped) return;
      swapIn();
      swapped = true;
    },
  });
  const reads = spyOutsideReads(join(outside, "capture.png"));
  try {
    f.collect();
  } finally {
    opens.restore();
    reads.restore();
  }
  const rootFds = opens.others.filter(({ args }) => args[0] === output);
  const required = fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  expect(rootFds.map(({ args }) => Number(args[1]) & required)).toEqual([required]);
  expect(swapped).toBe(true);
  expect(() => fstatSync(rootFds[0]?.fd ?? -1)).toThrow();
  expect(reads.state.outsideRead).toBe(false);
  expect(storedBytes()).not.toContain(outsidePng.toString("base64"));
  expect(f.store.listScreenshots(f.run.id)).toEqual([]);
  expect(f.events).toEqual([{ type: "status", text: 'Screenshot collection rejected: {"escaped":1}' }]);
});

test("an outside listing cannot authenticate its own child when the recorded root is restored after open", async () => {
  const { f, output, outside, outsidePng, swapIn, restore, storedBytes } = await swapFixture();
  const list = fs.readdirSync;
  let swapped = false;
  const listings = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof list>) => {
    if (args[0] === output) {
      swapIn();
      swapped = true;
    }
    return Reflect.apply(list, fs, args);
  }) as typeof list);
  const opens = spyChildOpens(join(output, "capture.png"), {
    after: () => {
      if (!swapped) return;
      restore();
      swapped = false;
    },
  });
  const reads = spyOutsideReads(join(outside, "capture.png"));
  try {
    f.collect();
  } finally {
    listings.mockRestore();
    opens.restore();
    reads.restore();
  }
  expect(reads.state.outsideRead).toBe(false);
  expect(storedBytes()).not.toContain(outsidePng.toString("base64"));
  expect(f.store.listScreenshots(f.run.id)).toEqual([]);
  expect(f.events).toEqual([{ type: "status", text: 'Screenshot collection rejected: {"escaped":1}' }]);
});

test("restoring the recorded root around every root check cannot authenticate an outside child", async () => {
  const { f, output, outside, outsidePng, swapIn, restore, storedBytes } = await swapFixture();
  const lstat = fs.lstatSync,
    child = join(output, "capture.png");
  // The reviewer's interleaving: outside for the listing identity and for the child open, trusted for each root check.
  const stats = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof lstat>) => {
    if (args[0] !== child) return Reflect.apply(lstat, fs, args);
    swapIn();
    try {
      return Reflect.apply(lstat, fs, args);
    } finally {
      restore();
    }
  }) as typeof lstat);
  const opens = spyChildOpens(child, { before: swapIn, after: restore });
  const reads = spyOutsideReads(join(outside, "capture.png"));
  try {
    f.collect();
  } finally {
    stats.mockRestore();
    opens.restore();
    reads.restore();
  }
  expect(reads.state.outsideRead).toBe(false);
  expect(storedBytes()).not.toContain(outsidePng.toString("base64"));
  expect(f.store.listScreenshots(f.run.id)).toEqual([]);
  expect(f.events).toEqual([{ type: "status", text: 'Screenshot collection rejected: {"escaped":1}' }]);
});

for (const [backend, adapter] of [
  ["codex", runCodex],
  ["claude", runClaude],
] as const)
  test(`${backend} transcript stdout and stderr are held and sanitized after collection`, async () => {
    const f = await fixture(),
      privacy = screenshotPrivacy(),
      output = f.output();
    const filename = "customer-private.png",
      base64 = png.toString("base64");
    const text = `${filename} ${output} screenshot-1-0.png /api/runs/test/screenshots/screenshot-1-0.png ${base64}`;
    const lines =
      backend === "codex"
        ? [
            { type: "item.completed", item: { type: "agent_message", text } },
            {
              type: "item.started",
              item: {
                type: "mcp_tool_call",
                id: "shot",
                server: "playwright",
                tool: "browser_take_screenshot",
                arguments: { filename },
              },
            },
            {
              type: "item.completed",
              item: {
                type: "mcp_tool_call",
                id: "shot",
                result: { [filename]: base64, filename, opaque: "withheld result" },
              },
            },
            { type: "item.completed", item: { type: "agent_message", text: `Later ${filename}` } },
            { type: "turn.completed", usage: {} },
          ]
        : [
            { type: "assistant", message: { content: [{ type: "text", text }] } },
            {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "shot",
                    name: "mcp__playwright__browser_take_screenshot",
                    input: { filename },
                  },
                ],
              },
            },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "shot",
                    content: JSON.stringify({ [filename]: base64, filename, opaque: "withheld result" }),
                  },
                ],
              },
            },
            { type: "assistant", message: { content: [{ type: "text", text: `Later ${filename}` }] } },
            { type: "result", subtype: "success", result: "done", usage: {} },
          ];
    const spec = {
      ...f.spec,
      scratchDir: undefined,
      noTools: true,
      browser: undefined,
      logPath: join(f.root, "inv-1.log"),
      holdTranscript: privacy.holdTranscript,
      onEvent: privacy.hold,
    };
    const runner = async (opts: ProcOptions) => {
      // Emit escaped JSON before collection or the tool call reveals its private filenames.
      opts.onStderrLine?.(
        JSON.stringify({
          [filename]: "captured",
          image: base64,
          sibling: "keep",
          nested: JSON.stringify([{ [filename]: base64 }]),
        })
          .replaceAll("-", "\\u002d")
          .replaceAll("iVBORw0KGgo", "\\u0069VBORw0KGgo"),
      );
      for (const line of lines) opts.onStdoutLine?.(JSON.stringify(line));
      opts.onStderrLine?.(text);
      opts.onStdoutLine?.(JSON.stringify({ unrelated: { [filename]: "captured" } }));
      writeFileSync(join(output, filename), png);
      return {
        exitCode: 0,
        signal: null,
        cancelled: false,
        timedOut: false,
        idleTimedOut: false,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: 0,
      };
    };
    await adapter(spec, runner);
    // Before collection the transcript has only the harmless invocation header.
    expect(readFileSync(spec.logPath, "utf8")).not.toContain(filename);
    collectVerifierCaptures(f.store, f.run.id, 1, f.spec.onEvent, privacy)(f.scratch);
    appendFileSync(spec.logPath, privacy.drainLogs());
    const log = readFileSync(spec.logPath, "utf8"),
      events = JSON.stringify(privacy.drain());
    for (const forbidden of [
      filename,
      output,
      "screenshot-1-0.png",
      "/screenshots/",
      "iVBORw0KGgo",
      "withheld result",
    ])
      expect(log).not.toContain(forbidden);
    for (const forbidden of [filename, output, "iVBORw0KGgo"]) expect(events).not.toContain(forbidden);
    expect(log).toContain("Later [screenshot]");
    expect(log).toContain("[stderr]");
    const stderrJson = log.split("\n").find((line) => line.startsWith("[stderr] {"));
    expect(JSON.parse(stderrJson?.slice(9) ?? "{}")).toEqual({
      "[screenshot]": "captured",
      image: "[screenshot]",
      sibling: "keep",
      nested: '[{"[screenshot]":"[screenshot]"}]',
    });
    expect(f.store.listScreenshots(f.run.id)).toHaveLength(1);
  });

test("all listed filenames remain private when a child disappears during descriptor inspection", async () => {
  const f = await fixture(),
    privacy = screenshotPrivacy(),
    output = f.output();
  writeFileSync(join(output, "a.png"), png);
  writeFileSync(join(output, "customer-private.png"), png);
  privacy.hold({ type: "text", text: "Saved customer-private.png" });
  privacy.holdTranscript("Saved customer-private.png");
  const lstat = fs.lstatSync;
  const stats = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof lstat>) => {
    if (args[0] === join(output, "a.png")) throw new Error("disappeared");
    return lstat(...args);
  }) as typeof lstat);
  try {
    collectVerifierCaptures(f.store, f.run.id, 1, f.spec.onEvent, privacy)(f.scratch);
  } finally {
    stats.mockRestore();
  }
  expect(f.store.listScreenshots(f.run.id)).toEqual([]);
  expect(JSON.stringify(privacy.drain())).not.toContain("customer-private.png");
  expect(privacy.drainLogs()).not.toContain("customer-private.png");
});
