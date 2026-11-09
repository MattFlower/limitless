/** Synthetic fixtures and outcome validators shared by the producer benchmark and its regressions. */
import type { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ProducerOperation } from "../scripts/benchmark-privacy-boundary.ts";
export type Fn = (...args: unknown[]) => unknown;
export type API = Record<string, unknown>;
export type Checker = Parameters<ProducerOperation["run"]>[0];
export type Job = [string, number, (() => unknown) | undefined, (v: unknown) => string, (() => unknown)?];
const Mi = 1048576,
  hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function validate(ok: unknown, label = "processed") {
  if (!ok) throw Error(`Invalid workload result: ${label}`);
  return label;
}
export function operation(a: API, name: string, equivalent?: Fn) {
  const run = typeof a[name] === "function" ? (a[name] as Fn) : equivalent;
  return { path: run === equivalent ? (equivalent ? "baseline-equivalent" : "unavailable") : name, run };
}
export const field = (v: unknown, path: string): unknown =>
  path.split(".").reduce((o, k) => Reflect.get(Object(o), k), v);
export function consumerState(cap: number) {
  return {
    flow: "build",
    lastGates: Array.from({ length: 50 }, (_, i) => ({
      name: `synthetic-${i}-gate`,
      verdict: "regressed",
      blocking: true,
      result: {
        name: `synthetic-${i}-gate`,
        command: ".".repeat(cap),
        output: "consumer-output-".padEnd(6000, "."),
        ok: false,
        exitCode: 1,
        durationMs: 1,
        textPrivacy: undefined as
          | { output: Record<string, unknown>; identities: Record<string, unknown> }
          | undefined,
      },
    })),
  };
}
export function projectionOutcome(
  value: unknown,
  state: ReturnType<typeof consumerState>,
  released: boolean,
  mode: string,
) {
  validate(typeof value === "string", "serialized projection");
  const gates = field(JSON.parse(String(value)), "lastGates");
  validate(Array.isArray(gates) && gates.length === 50, "50 projected gates");
  for (const [i, g] of (gates as unknown[]).entries()) {
    const original = state.lastGates[i]?.result;
    validate(
      field(g, "name") === original?.name && typeof field(g, "result.output") === "string",
      "projection shape",
    );
    for (const key of ["command", "output"] as const)
      validate(
        released
          ? field(g, `result.${key}`) === original?.[key]
          : field(g, `result.${key}`) === undefined ||
              /^\[withheld: [a-z-]{1,40}\]$/.test(String(field(g, `result.${key}`))),
        "projection release class",
      );
    if (mode === "outward") validate(field(g, "result.failures") === undefined, "outward failures omitted");
  }
  return released ? "50 released baseline/proven results" : "50 withheld results";
}
export function consumerCounters(name: string, value: unknown) {
  if (name === "gate-line-32mib") return field(value, "drain");
  if (name === "gate-concurrent")
    return {
      requestedConcurrency: field(value, "requestedConcurrency"),
      observedOverlap: field(value, "observedOverlap"),
    };
  if (name === "event-drain")
    return {
      count: 50000,
      gates: 5000,
      pages: field(value, "pages"),
      unsubscribed: field(value, "unsubscribed"),
    };
  if (name === "events") return { sinkEvents: value };
  if (name === "render-prompts") return { renderedResults: 50 };
  return undefined;
}
/** Decode and validate retained SSE bytes only after the measured consumer turns have ended. */
export function drainOutcome(value: unknown) {
  const chunks = field(value, "chunks");
  validate(Array.isArray(chunks) && chunks.every((c) => c instanceof Uint8Array), "SSE chunks");
  const frames = Buffer.concat(chunks as Uint8Array[])
    .toString()
    .split("\n\n");
  validate(frames.pop() === "", "complete SSE frames");
  let count = 0,
    gates = 0;
  for (const frame of frames) {
    if (frame.startsWith(":")) continue;
    const data = frame.split("\n").find((s) => s.startsWith("data: "));
    validate(data, "SSE data frame");
    const msg = JSON.parse(String(data).slice(6));
    validate(
      msg.kind === "event" &&
        msg.event.id === ++count &&
        msg.event.message === `event-${count - 1}` &&
        msg.event.type === ((count - 1) % 10 ? "log" : "gate"),
      "SSE order",
    );
    if (msg.event.type === "gate") gates++;
  }
  return validate(
    count === 50000 &&
      gates === 5000 &&
      Number(field(value, "pages")) > 0 &&
      field(value, "unsubscribed") === 1,
    "50000 ordered events; 5000 gate events; stream closed",
  );
}
const invoke = (c: Context, name: string, ...args: unknown[]) => (c.a[name] as Fn)(...args);
const fixtureSnapshot = (c: Context) =>
  invoke(c, "verifier", c.checker().registry, () => c.key) as { verify: Fn };
export const consumerSign = (c: Context, text: string, field: string) =>
  invoke(c, "checkAndSign", { checker: c.checker(), kind: "rendering", field, text, signer: () => c.key });
/** Fixture reset and proof creation are deliberately outside the measured consumer turn. */
export async function projectFixture(c: Context, name: string, state: ReturnType<typeof consumerState>) {
  const results = state.lastGates.map((g) => g.result);
  const file = join(c.env.LIMITLESS_CONFIG_DIR, "private-strings.txt"),
    original = await fs.readFile(file, "utf8");
  const prepare = async () => {
    await fs.writeFile(file, original);
    invoke(c, "provisionPrivacyPolicy", c.env.LIMITLESS_CONFIG_DIR, [], { registry: c.checker().registry });
    if (name === "project-proven" || name === "project-after-edit") {
      const output = await consumerSign(c, results[0]?.output ?? "", "output");
      const identities = await consumerSign(c, String(invoke(c, "gateIdentities", results[0])), "identities");
      for (const r of results)
        r.textPrivacy = {
          output: { ...Object(output), withheld: false },
          identities: { ...Object(identities), withheld: false },
        };
    } else if (name === "project-refused") {
      for (const r of results)
        r.textPrivacy = {
          output: { withheld: true, reason: "checker-failed" },
          identities: { withheld: true, reason: "checker-failed" },
        };
    }
    const expected = name === "project-proven" || name === "project-after-edit";
    const v = fixtureSnapshot(c);
    for (const r of results)
      validate(
        v.verify(r.textPrivacy?.output, "output", r.output) === expected &&
          v.verify(r.textPrivacy?.identities, "identities", invoke(c, "gateIdentities", r)) === expected,
        "fixture proof class",
      );
    if (name === "project-after-edit") await fs.writeFile(file, `${original}\nconsumer-policy-edit\n`);
  };
  return prepare;
}
export function renderInputs(state: ReturnType<typeof consumerState>): [string, unknown][] {
  const gates = state.lastGates;
  const inputs: [string, unknown][] = [
    ["formatGateFeedback", gates],
    [
      "reviewPrompt",
      {
        prompt: "synthetic",
        spec: null,
        baseSha: "synthetic",
        stat: "",
        gates,
        audit: [],
        implementerReport: "",
      },
    ],
    [
      "renderReport",
      {
        success: false,
        runId: "synthetic",
        prompt: "synthetic",
        state,
        invocations: [],
        totals: { costUsd: 0, costEquivUsd: 0 },
        runUrl: "http://localhost",
      },
    ],
  ];
  return inputs;
}
export function eventBacklog(length = 50000, withGates = true) {
  const result = consumerState(16).lastGates[0]?.result;
  return Array.from({ length }, (_, i) => ({
    id: i + 1,
    runId: "synthetic",
    type: !withGates || i % 10 ? "log" : "gate",
    level: "info",
    message: `event-${i}`,
    data: !withGates || i % 10 ? { n: i } : { result },
  }));
}
export const environment = (root: string) => ({
  PATH: process.env.PATH ?? "",
  LANG: "C.UTF-8",
  HOME: root,
  TMPDIR: root,
  LIMITLESS_CONFIG_DIR: join(root, "config"),
  XDG_CONFIG_HOME: root,
  CARGO_HOME: join(root, "cargo"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
export type Context = {
  a: API;
  cwd: string;
  env: ReturnType<typeof environment>;
  checker: () => Checker;
  key: Buffer;
};
const scope = (a: API, name: string, value: unknown, run: () => unknown) =>
  (a[name] as AsyncLocalStorage<unknown>).run(value, run);
export const registry: Record<string, (c: Context) => Promise<Job[]> | Job[]> = {
  "gate-5mib": async ({ a, cwd, env, checker, key }) => {
    await fs.writeFile(join(cwd, "stdout"), ".".repeat(4 * Mi));
    await fs.writeFile(join(cwd, "stderr"), ".".repeat(Mi));
    const cfg = {
      setup: [],
      checks: [{ name: "synthetic", run: "cat stdout; cat stderr >&2" }],
      source: "detected",
      protectedPaths: [],
    };
    const go = () => executeWholeGate({ a, cwd, env, checker, key }, cfg);
    return [
      [
        "runGates",
        5 * Mi,
        go,
        (v) =>
          validate(
            field(v, "setupOk") &&
              field(v, "checks.length") === 1 &&
              field(v, "checks.0.ok") &&
              field(v, "checks.0.exitCode") === 0 &&
              field(v, "checks.0.textPrivacy.output.withheld") === false &&
              field(v, "checks.0.output") === ".".repeat(6000),
          ),
      ],
    ];
  },
  "gate-line-8mb": (c) => wholeGate(c, 8000000),
  "gate-line-32mib": (c) => wholeGate(c, 32 * Mi),
  "gate-fail-5mib": (c) => wholeGate(c, 5 * Mi, true),
  "gate-concurrent": async (c) => {
    const job = (await registry["gate-5mib"]?.(c))?.[0];
    if (!job?.[2]) throw Error("whole-gate production execution unavailable");
    const requestedConcurrency = Number(invoke(c, "defaultGateSlots"));
    const run = async () => {
      let active = 0,
        observedOverlap = 0;
      const emit = EventEmitter.prototype.emit;
      const tracked = function (
        this: EventEmitter & { spawnargs?: string[] },
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (this.spawnargs?.some((arg) => arg.startsWith("limitless-started-"))) {
          if (event === "spawn") observedOverlap = Math.max(observedOverlap, ++active);
          if (event === "exit") active--;
        }
        return emit.call(this, event, ...args);
      };
      EventEmitter.prototype.emit = tracked;
      try {
        const gates = await Promise.all(Array.from({ length: requestedConcurrency }, () => job[2]?.()));
        return { gates, requestedConcurrency, observedOverlap };
      } finally {
        EventEmitter.prototype.emit = emit;
      }
    };
    const check = (v: unknown) => {
      const gates = field(v, "gates") as unknown[];
      validate(Array.isArray(gates) && gates.length === requestedConcurrency, "concurrent gate count");
      gates.forEach(job[3]);
      return validate(
        field(v, "requestedConcurrency") === requestedConcurrency &&
          Number(field(v, "observedOverlap")) >= 1 &&
          Number(field(v, "observedOverlap")) <= requestedConcurrency,
        "passing concurrent gates; observed child overlap",
      );
    };
    return [["runGates", requestedConcurrency * 5 * Mi, run, check]];
  },
  "gate-cap": ({ a, checker }) => {
    const streams = [".".repeat(4 * Mi), ".".repeat(4 * Mi)];
    const run = async () => {
      const text = streams.join("");
      const byteLength = Buffer.byteLength(text);
      const receipt = await checker().protectText({ text, provenance: { kind: "complete" } });
      const parts: Uint8Array[] = [];
      for (let i = 0; ; i++) {
        const part = (a.consumeBoundaryChunk as Fn)(receipt, i) as {
          bytes: Uint8Array;
          done: boolean;
          checkedComplete: boolean;
          withheld: boolean;
        };
        if (part.done) return { ...part, byteLength, bytes: Buffer.concat(parts) };
        parts.push(part.bytes);
      }
    };
    const expected = Buffer.alloc(8 * Mi, ".");
    const check = (v: unknown) => {
      const bytes = field(v, "bytes");
      return validate(
        field(v, "checkedComplete") &&
          !field(v, "withheld") &&
          Buffer.isBuffer(bytes) &&
          bytes.equals(expected) &&
          field(v, "byteLength") === 8 * Mi,
      );
    };
    return [["join/byteLength/checker-envelope", 8 * Mi, a.createPrivacyChecker ? run : undefined, check]];
  },
  "long-line": (c) => scannerLines(c, 1, 5 * Mi),
  "scanner-overflow": (c) => scannerLines(c, 2000, 65537),
  "scanner-files": ({ a }) => {
    const lines = Array.from({ length: 100000 }, (_, i) => `file-${i}.test.ts:`);
    const run = () => {
      const s = new (a.BunTestCoverage as typeof import("../src/gates/test-coverage.ts").BunTestCoverage)();
      for (const line of lines) {
        s.observe(line);
        s.observe("(pass) synthetic");
      }
      return s.result();
    };
    return [
      [
        "BunTestCoverage.observe/result",
        lines.length,
        run,
        (v) =>
          validate(
            field(v, "passedFiles.length") === (field(v, "skippedTestsIncomplete") ? 2000 : lines.length),
          ),
      ],
    ];
  },
  junit: async ({ a, cwd }) => {
    const jobs: Job[] = [];
    for (const size of [1, 4, 16])
      for (const reader of ["readJUnit", "readJUnitSkips", "readCoveringJUnit"]) {
        const fail = Number(reader === "readJUnit"),
          skip = Number(reader === "readJUnitSkips"),
          file = join(cwd, `${reader}-${size}.xml`);
        await fs.writeFile(file, junitReport(512, fail, skip));
        const op = operation(a, reader),
          run = () => op.run?.(file, cwd, { file: "sample.test.ts", name: "case" }, 0, false);
        const check = (v: unknown) =>
          validate(
            fail
              ? JSON.stringify(field(v, "failedFiles")) === '["sample.test.ts"]'
              : skip
                ? field(v, "skippedTests.length") === 1
                : field(v, "file") === "sample.test.ts" && !field(v, "reason"),
            "parsed",
          );
        if (op.run) check(await run()); // A valid small report proves paths/counters before measuring caps.
        await fs.writeFile(file, junitReport(size * Mi, fail, skip));
        jobs.push([`${reader}:${op.path}`, size * Mi, op.run ? run : undefined, check]);
      }
    return jobs;
  },
  identities: ({ a, checker, key }) => {
    const jobs: Job[] = [],
      cap = Number(a.IDENTITY_CAP ?? 65536);
    for (const units of [cap, cap + 1, 10 * cap]) {
      const r = { command: ".".repeat(units) },
        materialize = operation(a, "gateIdentities");
      const identity = materialize.run?.(r),
        over = units > cap,
        bytes = String(identity && !over ? identity : r.command);
      const check = (v: unknown) =>
        validate(
          over ? v === "identity-cap" : typeof v === "string" && JSON.parse(v)[0] === r.command,
          over ? "identity-cap-refusal" : "materialized",
        );
      jobs.push([
        `gateIdentities:${materialize.path}`,
        units,
        materialize.run ? () => materialize.run?.(r) : undefined,
        check,
      ]);
      jobs.push(["sha256", units, () => hash(bytes), (v) => validate(v === hash(bytes), "hashed")]);
      let signed: unknown;
      const sign = operation(a, "checkAndSign"),
        verifier = operation(a, "verifier");
      const run = async () =>
        (signed = await sign.run?.({
          checker: checker(),
          kind: "complete",
          field: "identities",
          text: bytes,
          // Identities are verdict-only, so the zero-length cut path is the one measured.
          cut: { limit: 0, unit: "U", marker: "" },
          signer: () => key,
        }));
      const outcome = over || !identity ? "raw-command; identities-refused-or-unavailable" : "identity-proof";
      const verify = (value: unknown) => {
        const verifierInstance = verifier.run?.(checker().registry, () => key) as { verify?: Fn } | undefined;
        return verifierInstance?.verify?.(value, "identities", bytes);
      };
      jobs.push([
        `checkAndSign:${sign.path}`,
        units,
        sign.run && verifier.run ? run : undefined,
        (v) => validate(verify(v) === true, outcome),
      ]);
      jobs.push([
        `verifier.verify:${verifier.path}`,
        units,
        verifier.run && sign.run ? () => verify(signed) : undefined,
        (v) => validate(v === true, outcome),
      ]);
    }
    return jobs;
  },
};
function executeWholeGate({ a, cwd, env, checker, key }: Context, cfg: unknown) {
  const run = () => operation(a, "runGates").run?.(cwd, cfg, new AbortController().signal, { env });
  const read = () => scope(a, "readPolicyScope", { home: env.HOME, environment: env }, run);
  const confined = () =>
    scope(a, "confinementScope", { verify: async () => {}, wrap: (cmd: string[]) => cmd }, read);
  return a.gatePrivacyScope
    ? scope(
        a,
        "gatePrivacyScope",
        { checker: checker(), registry: checker().registry, signer: () => key },
        confined,
      )
    : confined();
}

/** Each fixture runs through the selected revision's complete gate producer. */
async function wholeGate(c: Context, bytes: number, failing = false): Promise<Job[]> {
  let text = ".".repeat(bytes);
  if (failing) {
    const block = `sample.test.ts:\n(fail) synthetic\n${"detail line\n".repeat(8)}`;
    const rows = `${block.repeat(25000)}0 pass\n25000 fail\nRan 25000 tests across 1 file.\n`;
    text = rows + ".".repeat(bytes - rows.length);
  }
  await fs.writeFile(join(c.cwd, "stdout"), text);
  await fs.writeFile(join(c.cwd, "stderr"), "");
  const execute = () =>
    executeWholeGate(c, {
      setup: [],
      source: "detected",
      protectedPaths: [],
      checks: [{ name: "synthetic", run: `cat stdout; cat stderr >&2${failing ? "; exit 1" : ""}` }],
    });
  const run = async () => {
    const drain = { peakQueued: 0, largestChunk: 0, pausedReceipts: 0 };
    const observe = (e: { queued: number; received: number; paused: boolean }) => {
      drain.peakQueued = Math.max(drain.peakQueued, e.queued);
      drain.largestChunk = Math.max(drain.largestChunk, e.received);
      if (e.paused && e.received) drain.pausedReceipts++;
    };
    const value = await (c.a.processDrainObserver
      ? scope(c.a, "processDrainObserver", { observe }, execute)
      : execute());
    return { ...Object(value), ...(c.a.processDrainObserver ? { drain } : {}) };
  };
  const check = (v: unknown) => {
    validate(
      field(v, "setupOk") &&
        field(v, "checks.length") === 1 &&
        field(v, "checks.0.ok") === !failing &&
        field(v, "checks.0.exitCode") === Number(failing),
      "gate exit status",
    );
    if (bytes > 8 * Mi)
      return validate(
        field(v, "checks.0.textPrivacy.output.withheld") === true &&
          field(v, "checks.0.textPrivacy.output.reason") === "capture-cap",
        "capture-cap withheld",
      );
    validate(
      field(v, "checks.0.textPrivacy.output.withheld") === false &&
        field(v, "checks.0.output") === ".".repeat(6000),
      "released under-cap output",
    );
    if (failing)
      validate(
        field(v, "checks.0.testCoverage.summary.failed") === 25000 &&
          field(v, "checks.0.testCoverage.passedFiles.length") === 0,
        "failing Bun summary",
      );
    return "released under-cap output";
  };
  return [["runGates", bytes, run, check]];
}

async function scannerLines({ a, cwd, env }: Context, lines: number, units: number): Promise<Job[]> {
  const file = join(cwd, "lines"),
    handle = await fs.open(file, "w"),
    line = `${".".repeat(units)}\n`;
  try {
    for (let i = 0; i < lines; i++) await handle.writeFile(line);
  } finally {
    await handle.close();
  }
  const baseline = async () => {
    const seen: string[] = [];
    const r = await (a.runProcess as Fn)({
      cmd: ["/bin/cat", file],
      cwd,
      env,
      maxLineLength: 65536,
      tailLimit: 1,
      onStdoutLine: (s: string) => seen.push(s),
    });
    return { r, seen };
  };
  const selected = operation(a, "lineSplitter", baseline);
  const run =
    selected.path === "baseline-equivalent"
      ? baseline
      : () => {
          const seen: string[] = [];
          const parser = selected.run?.((s: string) => seen.push(s), 65536) as {
            push: (s: string) => void;
            flush: () => void;
          };
          for (let i = 0; i < lines; i++) parser.push(line);
          parser.flush();
          return { r: { exitCode: 0 }, seen };
        };
  const check = (v: unknown) =>
    validate(
      field(v, "r.exitCode") === 0 &&
        (field(v, "seen") as string[]).length === lines &&
        (field(v, "seen") as string[]).every((s) => s.endsWith(" [truncated]")),
    );
  return [[`${selected.path}:runProcess/lineSplitter`, units, run, check]];
}

export function describe(name: string, label: string, size: number, api: API) {
  const cap = api.IDENTITY_CAP;
  const identities = typeof cap === "number" && size <= cap && typeof api.gateIdentities === "function";
  return {
    implementation: label.includes("baseline-equivalent")
      ? label
      : label.includes("unavailable")
        ? "unavailable"
        : "revision-local production",
    proofClass: name.startsWith("project-") ? name.slice(8) : undefined,
    productionProjection: name.startsWith("project-")
      ? typeof api.projectGateDiagnostics === "function"
        ? "available"
        : "unavailable"
      : undefined,
    results: name.startsWith("project-") || name === "render-prompts" ? 50 : undefined,
    outputUnits: name.startsWith("project-") ? 6000 : undefined,
    identitiesAtCap: name.startsWith("project-") ? (api.IDENTITY_CAP ?? 65536) : undefined,
    gateEvents: name === "event-drain" ? 5000 : undefined,
    logBytes: name === "land-log" ? 5120000 : undefined,
    policyEntries: name === "land-log" ? 8 : undefined,
    registeredCredentials: name === "land-log" ? 600 : undefined,
    size,
    label,
    sizeUnit:
      name.startsWith("project-") || name === "render-prompts"
        ? "results"
        : name === "events" || name === "event-drain"
          ? "events"
          : name === "land-log"
            ? "entries"
            : ["identities", "long-line", "scanner-overflow"].includes(name)
              ? "U"
              : name === "scanner-files"
                ? "headers"
                : "bytes",
    lines:
      name === "agent-stream" || name === "scanner-overflow" ? 2000 : name === "long-line" ? 1 : undefined,
    holdoutScenarios: name === "agent-stream" ? 8 : name === "holdout-repetitive" ? 1 : undefined,
    publicSourceUnits: name === "agent-stream" ? 20480 : name === "holdout-repetitive" ? 262144 : undefined,
    registeredAgentCredentials: name === "agent-stream" ? 601 : undefined,
    observedLiteralUnits: name === "holdout-repetitive" ? 3802 : undefined,
    observedLiterals: name === "holdout-repetitive" ? 8 : undefined,
    coldClassification: name === "holdout-repetitive" ? true : undefined,
    identityCap: name === "identities" ? (cap ?? null) : undefined,
    identityCoverage: name === "identities" ? identities : undefined,
    identityBytesSource:
      name === "identities"
        ? identities
          ? "gateIdentities"
          : "raw-command; identity-cap-refusal-or-unavailable"
        : undefined,
    streams: name === "gate-cap" ? 2 : undefined,
    joinSeparator: name === "gate-cap" ? "" : undefined,
    units: name === "gate-cap" ? 8 * Mi : undefined,
    stdoutBytes:
      name === "gate-5mib" || name === "gate-concurrent"
        ? 4 * Mi
        : name === "gate-line-8mb"
          ? 8000000
          : name === "gate-line-32mib"
            ? 32 * Mi
            : name === "gate-fail-5mib"
              ? 5 * Mi
              : null,
    stderrBytes:
      name === "gate-5mib" || name === "gate-concurrent"
        ? Mi
        : name.startsWith("gate-line-") || name === "gate-fail-5mib"
          ? 0
          : null,
    unterminatedLines: name.startsWith("gate-line-") ? 1 : undefined,
    failureRows: name === "gate-fail-5mib" ? 25000 : undefined,
    requestedConcurrency: name === "gate-concurrent" ? (api.defaultGateSlots as Fn)() : undefined,
  };
}

export function validateReports(results: { report: unknown }[]) {
  for (const { report } of results) {
    validate(
      Number(field(report, "pid")) > 0 &&
        field(report, "groups") &&
        Array.isArray(field(report, "unavailable")),
      "worker report",
    );
    const groups = Object.values(field(report, "groups") as Record<string, unknown>);
    validate(groups.length || (field(report, "unavailable") as unknown[]).length, "empty worker report");
    for (const group of groups) {
      const raw = field(group, "raw") as Record<string, unknown>[];
      validate(
        Array.isArray(raw) &&
          raw.length === 7 &&
          raw.every((t, i) => t.warmup === i < 2 && Number.isFinite(t.slice)),
        "worker trials",
      );
    }
  }
}

/** Many real testcase nodes exercise traversal as well as XML tokenization; padding fixes byte sizes. */
export function junitReport(bytes: number, failures: number, skipped: number) {
  const count = Math.max(0, Math.floor((bytes - 512) / 256));
  const cases = Array.from(
    { length: count },
    (_, i) => `<testcase file="sample.test.ts" name="${`case-${i}`.padEnd(128, ".")}" time="0"/>`,
  ).join("");
  const head = `<testsuite tests="${count + 1}" failures="${failures}" errors="0" skipped="${skipped}"><testcase file="sample.test.ts" name="case" line="1" time="1">${failures ? "<failure/>" : skipped ? "<skipped/>" : ""}</testcase>${cases}<!--`;
  const tail = "--></testsuite>";
  return head + ".".repeat(bytes - head.length - tail.length) + tail;
}
