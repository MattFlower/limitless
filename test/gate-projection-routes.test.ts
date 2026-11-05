import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import type { Stage } from "../src/core/types.ts";
import { MAX_EVENT_DATA } from "../src/db/store.ts";
import { formatGateOutput } from "../src/gates/failures.ts";
import { projectGateDiagnostics as project } from "../src/gates/output.ts";
import type { GateComparison, GateResult } from "../src/gates/run.ts";
import { gateIdentities, gatePrivacyScope, remoteGateData, withheldText } from "../src/gates/text-privacy.ts";
import { factoryBackend } from "../src/integrations/mcp.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { formatGateFeedback, reviewPrompt, verifyPrompt } from "../src/pipeline/prompts.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import { checkAndSign } from "../src/util/privacy-proof.ts";
import { registerCredential } from "../src/util/proc.ts";
import { connect, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { provenResult, testGatePrivacy } from "./privacy-support.ts";
import { providerFixture } from "./provider-config-support.ts";

const sentinel = "private-gate-sentinel";
const result = (output = sentinel): GateResult => ({
  name: "test",
  command: sentinel,
  executedCommand: sentinel,
  ok: false,
  exitCode: 17,
  durationMs: 7,
  output,
  failures: sentinel,
  failedFiles: [sentinel],
  failedFileTimes: { [sentinel]: 1 },
  coveringTest: { file: sentinel, name: sentinel },
  coveringTests: [{ file: sentinel, name: sentinel }],
  testCoverage: {
    passedFiles: [sentinel],
    skippedFiles: [sentinel],
    skippedTests: [{ file: sentinel, name: sentinel }],
    summary: { passed: 1, failed: 2 },
  },
});
const comparison = (r: GateResult): GateComparison => ({
  name: "test",
  result: r,
  verdict: "regressed",
  blocking: true,
});
const spec = {
  summary: "test",
  requirements: [],
  acceptance_criteria: [],
  assumptions: [],
  out_of_scope: [],
  blocking_questions: [],
};
const report = (r: GateResult) =>
  renderReport({
    success: false,
    runUrl: "u",
    runId: "test",
    prompt: "test",
    state: { lastGates: [comparison(r)] },
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
  });
const review = (r: GateResult) =>
  reviewPrompt({
    prompt: "test",
    spec,
    baseSha: "base",
    stat: "",
    gates: [comparison(r)],
    audit: [],
    implementerReport: "",
  });
const verify = (r: GateResult) =>
  verifyPrompt({
    prompt: "test",
    spec,
    holdout: { scenarios: [] },
    baseSha: "base",
    checks: [comparison(r)],
  });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const config = providerFixture([]),
    previous = process.env.LIMITLESS_CONFIG_DIR;
  process.env.LIMITLESS_CONFIG_DIR = config.configDir;
  writeFileSync(join(config.configDir, "private-strings.txt"), "");
  const factory = new Factory(config.load()),
    store = factory.store;
  const repo = store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    url: null,
    localPath: config.work,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "test" });
  const abort = new AbortController(),
    routes = createHttpRoutes(factory);
  const read = async (path: string, name = "") => {
    const route = routes[path];
    return (route as Route)(
      requestWithParams(
        `http://localhost${path.replace(":id", run.id).replace(":name", name)}`,
        { signal: abort.signal },
        { id: run.id, name },
      ),
      localServer,
    );
  };
  const ctx = new RunContext(factory.deps, run, repo, abort.signal);
  cleanups.push(async () => {
    abort.abort();
    await factory.stop();
    store.close();
    config.close();
    if (previous === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
    else process.env.LIMITLESS_CONFIG_DIR = previous;
  });
  return { config, factory, store, run, ctx, read, abort };
}
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  while (!text.includes("data: ")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Missing SSE frame");
    text += new TextDecoder().decode(chunk.value);
  }
  return text;
}
function assertWithheld(bytes: string) {
  expect(bytes).not.toContain(sentinel);
  expect(bytes).toContain(withheldText("unproven"));
  expect(bytes).not.toContain('"mac"');
  for (const key of ["failures", "provenanceError", "remoteAttestation"])
    expect(bytes).not.toContain(`"${key}"`);
}

test.each(["legacy", "forged", "foreign"] as const)(
  "all 2g routes reject %s proofs without changing verdicts",
  async (kind) => {
    const f = fixture();
    let r = result();
    if (kind !== "legacy") {
      r = await provenResult(r);
      if (kind === "foreign")
        r = await gatePrivacyScope.run({ ...testGatePrivacy, signer: () => Buffer.alloc(32, 41) }, () =>
          provenResult(result()),
        );
      else if (r.textPrivacy) {
        r.textPrivacy.output.mac = "f".repeat(64);
        if (r.textPrivacy.identities) r.textPrivacy.identities.mac = "f".repeat(64);
      }
    }
    const provenance = { provenanceError: sentinel };
    const data = {
      fresh: r,
      resumed: { result: r },
      replayed: { firstAttempt: r },
      cached: { setup: [r], checks: [r], setupOk: false, ...provenance },
      reused: {
        result: {
          ...r,
          reused: { executionId: "execution", treeHash: "tree", createdAt: 1 },
          executionProvenance: provenance,
          remoteAttestation: { output: { withheld: false } },
        },
      },
      retries: { ...r, firstAttempt: r, targetedRetry: r, retryAttempt: r },
      confirmation: { originalVerdict: "regressed", reason: sentinel, result: r },
    };
    const event = f.ctx.event({
      runId: f.run.id,
      type: "tool_call",
      level: "info",
      message: "tool input",
      data: { input: data },
    });
    assertWithheld(JSON.stringify(event));
    expect(project(r, { mode: "outward" })).toMatchObject({
      ok: false,
      exitCode: 17,
      durationMs: 7,
      output: withheldText("unproven"),
      command: withheldText("unproven"),
    });
    f.store.putArtifact(f.run.id, "gates.json", "gates", JSON.stringify(data));
    f.store.putArtifact(f.run.id, "broken.txt", "gates", sentinel);
    for (const path of ["/api/runs/:id/events", "/api/runs/:id/artifacts/:name"])
      assertWithheld(await (await f.read(path, "gates.json")).text());
    expect(await (await f.read("/api/runs/:id/artifacts/:name", "broken.txt")).text()).toBe(
      withheldText("unproven"),
    );
    const response = await f.read("/api/runs/:id/stream"),
      reader = response.body?.getReader();
    if (!reader) throw new Error("Missing SSE body");
    assertWithheld(await frame(reader));
    f.store.addEvent({ runId: f.run.id, type: "gate", level: "info", message: "live", data });
    assertWithheld(await frame(reader));
    f.abort.abort();
    await reader.cancel();
    const mcp = await connect(factoryBackend(f.factory));
    try {
      assertWithheld(
        JSON.stringify(
          await mcp.client.callTool({ name: "limitless_get_run", arguments: { id: f.run.id, full: true } }),
        ),
      );
    } finally {
      await mcp.close();
    }
    for (const render of [
      formatGateOutput,
      (value: GateResult) => formatGateFeedback([comparison(value)]),
      review,
      verify,
      report,
    ])
      assertWithheld(render(r));
  },
);

test("durable events retain proofs and release through HTTP, SSE and MCP", async () => {
  const f = fixture(),
    r = await provenResult(result("clean output"));
  const durable = project(r, { mode: "durable" });
  expect(JSON.stringify(project(durable, { mode: "durable" }))).toBe(JSON.stringify(durable));
  expect(project(durable, { mode: "outward" })).toEqual(project(r, { mode: "outward" }));
  const event = f.ctx.event({ runId: f.run.id, type: "gate", level: "info", message: "result", data: r });
  expect(JSON.stringify(f.store.listEvents(f.run.id))).toContain('"mac"');
  expect(event.data).toMatchObject({ output: r.output, command: r.command });
  const texts = [await (await f.read("/api/runs/:id/events")).text()];
  const response = await f.read("/api/runs/:id/stream"),
    reader = response.body?.getReader();
  if (!reader) throw new Error("Missing SSE body");
  texts.push(await frame(reader));
  f.store.addEvent({ runId: f.run.id, type: "gate", level: "info", message: "live", data: durable });
  texts.push(await frame(reader));
  f.abort.abort();
  await reader.cancel();
  const mcp = await connect(factoryBackend(f.factory));
  try {
    texts.push(
      JSON.stringify(
        await mcp.client.callTool({ name: "limitless_get_run", arguments: { id: f.run.id, full: true } }),
      ),
    );
  } finally {
    await mcp.close();
  }
  for (const text of texts) {
    expect(text).toContain(r.output);
    expect(text).toContain(r.command);
    expect(text).not.toContain('"mac"');
  }
  for (const render of [
    formatGateOutput,
    (value: GateResult) => formatGateFeedback([comparison(value)]),
    review,
  ])
    expect(render(r)).toContain(r.output);
  for (const render of [review, verify, report]) expect(render(r)).toContain(r.command);
});

test("historical artifact reads refresh policy without submitting to the checker", async () => {
  const f = fixture(),
    registry = testGatePrivacy.registry;
  provisionPrivacyPolicy(f.config.configDir, [], { registry });
  try {
    const r = await provenResult(result());
    f.store.putArtifact(f.run.id, "history.json", "gates", JSON.stringify(r));
    const submissions = spyOn(testGatePrivacy.checker, "protectText");
    try {
      writeFileSync(join(f.config.configDir, "private-strings.txt"), `${sentinel}\n`);
      assertWithheld(await (await f.read("/api/runs/:id/artifacts/:name", "history.json")).text());
      expect(submissions).not.toHaveBeenCalled();
      writeFileSync(join(f.config.configDir, "private-strings.txt"), "");
      expect(await (await f.read("/api/runs/:id/artifacts/:name", "history.json")).text()).toContain(
        sentinel,
      );
      expect(submissions).not.toHaveBeenCalled();
    } finally {
      submissions.mockRestore();
    }
  } finally {
    registry.refreshPolicy = () => {};
    registry.replacePolicy([]);
  }
});

test("credential changes withhold proved bytes and identities without silent redaction", async () => {
  const credential = "PROJECTION_SECRET_2026",
    text = `alpha${credential}beta`;
  const r = await provenResult({ ...result(text), command: text });
  registerCredential("PROJECTION_TEST", credential);
  for (const mode of ["durable", "outward"] as const) {
    const projected = project(r, { mode });
    expect(projected.output).toBe(withheldText("credential-changed"));
    expect(projected.command).toBe(withheldText("credential-changed"));
    expect(projected.textPrivacy).toEqual({
      output: { withheld: true, reason: "credential-changed" },
      identities: { withheld: true, reason: "credential-changed" },
    });
    expect(JSON.stringify(projected)).not.toContain("alpha[redacted]beta");
  }
});

test("all identity fields are removed together and internal evidence is untouched", () => {
  const r = result(),
    before = structuredClone(r),
    out = project(r, { mode: "outward" });
  expect(out.command).toBe(withheldText("unproven"));
  for (const key of ["executedCommand", "failedFiles", "failedFileTimes", "coveringTest", "coveringTests"])
    expect(Reflect.get(out, key)).toBeUndefined();
  expect(out.testCoverage).toEqual({
    passedFiles: [],
    skippedFiles: [],
    skippedTestsIncomplete: true,
    summary: r.testCoverage?.summary,
  });
  for (const render of [
    (value: GateResult) => JSON.stringify(project(value, { mode: "outward" })),
    (value: GateResult) => formatGateFeedback([comparison(value)]),
    report,
  ])
    assertWithheld(render(r));
  expect(r).toEqual(before);
});

test("oversized events replace released gate text before the store's preview clamp", async () => {
  const f = fixture(),
    r = await provenResult(result("U".repeat(20_000)));
  f.ctx.event({ runId: f.run.id, type: "gate", level: "info", message: "oversized", data: { result: r } });
  const data = f.store.listEvents(f.run.id)[0]?.data;
  expect(data).toMatchObject({
    result: {
      output: withheldText("event-size"),
      command: withheldText("event-size"),
      textPrivacy: {
        output: { withheld: true, reason: "event-size" },
        identities: { withheld: true, reason: "event-size" },
      },
    },
  });
  const bytes = JSON.stringify(data);
  expect(bytes.length).toBeLessThanOrEqual(MAX_EVENT_DATA);
  expect(bytes).not.toContain('"mac"');
  expect(bytes).not.toContain("preview");
  expect(bytes).not.toContain("UUUU");
});

test.each([
  "unproven",
  "credential-changed",
  "event-size",
  "identity-cap",
  "private-match",
  "capture-cap",
  "checker-failed",
  "checker-timeout",
  "unreadable-policy",
])("withheld records round-trip unchanged: %s", (reason) => {
  const r = {
    ...result(withheldText(reason)),
    command: withheldText(reason),
    textPrivacy: { output: { withheld: true, reason }, identities: { withheld: true, reason } },
  };
  for (const mode of ["durable", "outward"] as const) {
    const first = project(r, { mode: "durable" }),
      again = project(first, { mode });
    expect(again).toEqual(first);
    expect(again.output).toBe(withheldText(reason));
    expect(again.command).toBe(withheldText(reason));
  }
});

test("remote claims never grant release; coordinator attested proofs do", async () => {
  const r = await provenResult(result()),
    remote = remoteGateData(r);
  assertWithheld(JSON.stringify(project(remote, { mode: "outward" })));
  const sign = async (field: string, text: string) => ({
    withheld: false,
    ...(await checkAndSign({ ...testGatePrivacy, kind: "attested:lan", field, text })),
  });
  const attested = {
    ...remote,
    textPrivacy: {
      output: await sign("output", remote.output),
      identities: await sign("identities", gateIdentities(remote)),
    },
  };
  const out = project(attested, { mode: "outward" });
  expect(out.output).toBe(r.output);
  expect(out.command).toBe(r.command);
  expect(out.textPrivacy?.output.kind).toBe("attested:lan");
  expect(out.remoteAttestation).toBeUndefined();
});

test("projection snapshots are lazy and shared across nested result fields", async () => {
  const r = await provenResult(result()),
    refresh = spyOn(testGatePrivacy.registry, "refreshPolicy");
  try {
    project({ plain: "text" }, { mode: "outward" });
    expect(refresh).not.toHaveBeenCalled();
    project(
      { setupOk: false, setup: [r], checks: [{ ...r, firstAttempt: r, targetedRetry: r }] },
      { mode: "outward" },
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    refresh.mockRestore();
  }
});

test("SSE backlog yields on every 2000-event page, keeps order and unsubscribes on abort", async () => {
  const f = fixture(),
    events = Array.from({ length: 5000 }, (_, i) => ({
      id: i + 1,
      runId: f.run.id,
      type: "log" as const,
      message: "event",
      level: "info" as const,
      invocationId: null,
      ts: 0,
      data: null,
    }));
  const turns: number[] = [],
    pages: number[] = [];
  const list = spyOn(f.store, "listEvents").mockImplementation((_id, options) => {
    pages.push(options?.after ?? 0);
    setImmediate(() => turns.push(pages.length));
    return events.slice(options?.after ?? 0, (options?.after ?? 0) + 2000);
  });
  let subscribed = 0,
    unsubscribed = 0;
  const subscribe = spyOn(f.store, "subscribe").mockImplementation(() => {
    subscribed++;
    return () => {
      unsubscribed++;
    };
  });
  try {
    const response = await f.read("/api/runs/:id/stream"),
      reader = response.body?.getReader();
    if (!reader) throw new Error("Missing SSE body");
    expect(turns).toEqual([1, 2]);
    expect(pages).toEqual([0, 2000, 4000]);
    expect(subscribed).toBe(1);
    let bytes = "";
    while (!bytes.includes('"id":5000')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Missing backlog");
      bytes += new TextDecoder().decode(chunk.value);
    }
    const ids = bytes
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)).event.id);
    expect(ids).toEqual(events.map((e) => e.id));
    f.abort.abort();
    await reader.cancel();
    expect(unsubscribed).toBe(1);
  } finally {
    list.mockRestore();
    subscribe.mockRestore();
  }
});

test("SSE drain buffers live messages published between pages and drops events already read", async () => {
  const f = fixture(),
    runId = f.run.id,
    event = (id: number) => ({
      id,
      runId,
      type: "log" as const,
      message: "event",
      level: "info" as const,
      invocationId: null,
      ts: 0,
      data: null,
    }),
    events = Array.from({ length: 5000 }, (_, i) => event(i + 1));
  let listener: ((msg: Parameters<Parameters<typeof f.store.subscribe>[0]>[0]) => void) | undefined;
  const list = spyOn(f.store, "listEvents").mockImplementation((_id, options) => {
    const after = options?.after ?? 0;
    if (after === 0)
      setImmediate(() => {
        // Published while the drain is between pages: one non-event, one event the next page re-reads, one new.
        listener?.({ kind: "stage", stage: { runId, status: "completed" } as unknown as Stage });
        listener?.({ kind: "event", event: event(2500) });
        listener?.({ kind: "event", event: event(5001) });
      });
    return events.slice(after, after + 2000);
  });
  let unsubscribed = 0;
  const subscribe = spyOn(f.store, "subscribe").mockImplementation((fn) => {
    listener = fn;
    return () => {
      unsubscribed++;
    };
  });
  try {
    const response = await f.read("/api/runs/:id/stream"),
      reader = response.body?.getReader();
    if (!reader) throw new Error("Missing SSE body");
    let bytes = "";
    while (!bytes.includes('"id":5001')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Missing buffered frames");
      bytes += new TextDecoder().decode(chunk.value);
    }
    const frames = bytes
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(frames.map((m) => (m.kind === "event" ? m.event.id : m.kind))).toEqual([
      ...events.map((e) => e.id),
      "stage",
      5001,
    ]);
    f.abort.abort();
    await reader.cancel();
    expect(unsubscribed).toBe(1);
  } finally {
    list.mockRestore();
    subscribe.mockRestore();
  }
});

test("SSE drain releases its subscription when reading the backlog fails", async () => {
  const f = fixture();
  let unsubscribed = 0;
  const list = spyOn(f.store, "listEvents").mockImplementation(() => {
    throw new Error("store unavailable");
  });
  const subscribe = spyOn(f.store, "subscribe").mockImplementation(() => () => {
    unsubscribed++;
  });
  try {
    const response = await f.read("/api/runs/:id/stream");
    expect(response.status).not.toBe(200);
    expect(unsubscribed).toBe(1);
  } finally {
    list.mockRestore();
    subscribe.mockRestore();
  }
});

test("textPrivacy outside a recognized result is projected and redacted like any other data", async () => {
  const credential = "TEXT_PRIVACY_CREDENTIAL_517";
  registerCredential("TEXT_PRIVACY_TEST", credential);
  const hidden = "nested-gate-sentinel",
    nested = { ok: false, command: hidden, output: hidden };
  const signed = await provenResult(result("safe"));
  const tampered = {
    ...signed,
    textPrivacy: {
      ...signed.textPrivacy,
      output: { ...signed.textPrivacy?.output, extra: { ...nested, note: credential } },
    },
  };
  const inputs = [
    { textPrivacy: { extra: { ...nested, note: credential } } },
    { textPrivacy: { output: { withheld: true, reason: credential, extra: nested } } },
    {
      ok: false,
      command: "c",
      output: "o",
      textPrivacy: { output: { withheld: true, reason: credential, extra: nested } },
    },
    tampered,
  ];
  for (const mode of ["durable", "outward"] as const)
    for (const input of inputs) {
      const bytes = JSON.stringify(project(input, { mode }));
      expect(bytes).not.toContain(hidden);
      expect(bytes).not.toContain(credential);
    }
  // Validated proof metadata still survives: the tampered record's extras are dropped, its proof is kept.
  const durable = project(tampered, { mode: "durable" });
  expect(durable.output).toBe("safe");
  expect<unknown>(durable.textPrivacy).toEqual(signed.textPrivacy);
  expect(project(tampered, { mode: "outward" }).textPrivacy?.output).not.toHaveProperty("mac");
});

test("withheld timeout markers keep their exact rendering", () => {
  const reason = "checker-timeout",
    output = withheldText(reason, true);
  const r = {
    ...result(output),
    timedOut: true,
    textPrivacy: {
      output: { withheld: true, reason },
      identities: { withheld: true, reason: "identity-cap" },
    },
  };
  const durable = project(r, { mode: "durable" });
  expect(durable.output).toBe(output);
  expect(project(durable, { mode: "durable" })).toEqual(durable);
  expect(project(durable, { mode: "outward" })).toEqual(durable);
  expect(project({ ...result(), timedOut: true }, { mode: "outward" }).output).toBe(withheldText("unproven"));
});

test("strings outside governed identity fields retain credential redaction", async () => {
  const credential = "SUMMARY_CREDENTIAL_292",
    r = result("safe");
  // Shape recognition also sees untrusted, loosely typed JSON, without trusting its metadata.
  const input = JSON.parse(
    JSON.stringify({ ...r, testCoverage: { passedFiles: [], skippedFiles: [], summary: credential } }),
  );
  const signed = await provenResult(input);
  registerCredential("SUMMARY_TEST", credential);
  for (const mode of ["durable", "outward"] as const) {
    const out = project(signed, { mode });
    expect(out.testCoverage.summary).toBe("[redacted]");
    expect(out.output).toBe("safe");
    expect(out.command).toBe(r.command);
  }
});

test("a parseable artifact cannot fall back to raw text when projection fails", async () => {
  const f = fixture(),
    content = JSON.stringify(result());
  const signer = spyOn(testGatePrivacy, "signer").mockImplementation(() => {
    throw new Error("signer unavailable");
  });
  try {
    for (const kind of ["gates", "diagnostics"]) {
      f.store.putArtifact(f.run.id, "gates.json", kind, content);
      const response = await f.read("/api/runs/:id/artifacts/:name", "gates.json");
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(sentinel);
    }
  } finally {
    signer.mockRestore();
  }
});

test("identity proofs exempt only the members they cover", async () => {
  const credential = "IDENTITY_EXTRA_CREDENTIAL_642",
    base: GateResult = {
      name: "test",
      command: "true",
      ok: true,
      exitCode: 0,
      durationMs: 1,
      output: "safe",
    };
  const timed = await provenResult({ ...base, failedFileTimes: { "a.test.ts": 1 } });
  const extra = await provenResult({
    ...base,
    testCoverage: { passedFiles: ["a.test.ts"], skippedFiles: [] },
  });
  registerCredential("IDENTITY_EXTRA_TEST", credential);
  // failedFileTimes values are outside the identity digest: a changed value withholds the set.
  Reflect.set(timed.failedFileTimes ?? {}, "a.test.ts", credential);
  // testCoverage members outside the digest are projected normally, including nested results.
  Reflect.set(extra.testCoverage ?? {}, "extra", { ...result(), credential });
  for (const mode of ["durable", "outward"] as const) {
    const out = project(timed, { mode });
    expect(JSON.stringify(out)).not.toContain(credential);
    expect(out.command).toBe(withheldText("unproven"));
    expect(out.textPrivacy?.identities).toEqual({ withheld: true, reason: "unproven" });
    const released = project(extra, { mode });
    expect(released.command).toBe("true");
    expect(released.testCoverage?.passedFiles).toEqual(["a.test.ts"]);
    const bytes = JSON.stringify(released);
    expect(bytes).not.toContain(credential);
    expect(bytes).not.toContain(sentinel);
    expect(Reflect.get(released.testCoverage ?? {}, "extra")).toMatchObject({
      output: withheldText("unproven"),
      command: withheldText("unproven"),
      credential: "[redacted]",
    });
  }
});

test("a whole-value short credential in one identity withholds the set as credential-changed", async () => {
  const short = "zQ7",
    r = await provenResult({ ...result("safe"), command: short });
  registerCredential("IDENTITY_SHORT_TEST", short);
  for (const mode of ["durable", "outward"] as const) {
    const out = project(r, { mode });
    expect(out.command).toBe(withheldText("credential-changed"));
    expect(out.textPrivacy?.identities).toEqual({ withheld: true, reason: "credential-changed" });
    expect(out.output).toBe("safe");
  }
});

test("unsigned withheld reasons outside the fixed vocabulary render as unproven", () => {
  const reason = "secret-host-probe";
  registerCredential("REASON_TEST", reason);
  const r = {
    ...result(),
    textPrivacy: { output: { withheld: true, reason }, identities: { withheld: true, reason } },
  };
  for (const mode of ["durable", "outward"] as const) {
    const out = project(r, { mode });
    expect(JSON.stringify(out)).not.toContain(reason);
    expect(out.output).toBe(withheldText("unproven"));
    expect(out.textPrivacy).toEqual({
      output: { withheld: true, reason: "unproven" },
      identities: { withheld: true, reason: "unproven" },
    });
  }
});

test.each([Infinity, -Infinity, NaN])(
  "non-finite failedFileTimes (%p) withhold identities idempotently",
  async (t) => {
    const r = await provenResult({ ...result("safe"), failedFileTimes: { "safe.test.ts": 1 } });
    Reflect.set(r.failedFileTimes ?? {}, "safe.test.ts", t);
    const once = project(r, { mode: "durable" });
    expect(once.command).toBe(withheldText("unproven"));
    expect(once.textPrivacy?.identities).toEqual({ withheld: true, reason: "unproven" });
    expect(JSON.stringify(project(once, { mode: "durable" }))).toBe(JSON.stringify(once));
  },
);
