/** Synthetic fixtures and outcome validators shared by the producer benchmark and its regressions. */
import type { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ProducerOperation } from "../scripts/benchmark-privacy-boundary.ts";
export type Fn = (...args: unknown[]) => unknown;
export type API = Record<string, unknown>;
export type Checker = Parameters<ProducerOperation["run"]>[0];
type Job = [string, number, (() => unknown) | undefined, (v: unknown) => string];
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
const field = (v: unknown, path: string): unknown =>
  path.split(".").reduce((o, k) => Reflect.get(Object(o), k), v);
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
type Context = {
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
    const run = () => operation(a, "runGates").run?.(cwd, cfg, new AbortController().signal, { env });
    const read = () => scope(a, "readPolicyScope", { home: env.HOME, environment: env }, run);
    const confined = () =>
      scope(a, "confinementScope", { verify: async () => {}, wrap: (cmd: string[]) => cmd }, read);
    const go = () =>
      a.gatePrivacyScope
        ? scope(
            a,
            "gatePrivacyScope",
            { checker: checker(), registry: checker().registry, signer: () => key },
            confined,
          )
        : confined();
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
              field(v, "checks.0.output") === ".".repeat(6000),
          ),
      ],
    ];
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
    size,
    label,
    sizeUnit: ["identities", "long-line", "scanner-overflow"].includes(name)
      ? "U"
      : name === "scanner-files"
        ? "headers"
        : "bytes",
    lines: name === "scanner-overflow" ? 2000 : name === "long-line" ? 1 : undefined,
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
    stdoutBytes: name === "gate-5mib" ? 4 * Mi : null,
    stderrBytes: name === "gate-5mib" ? Mi : null,
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
