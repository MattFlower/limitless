/** Synthetic producer and consumer workloads; no owner configuration or external services. */
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import {
  type API,
  type Checker,
  consumerCounters,
  describe,
  environment,
  type Fn,
  registry,
  validate,
  validateReports,
} from "../test/benchmark-gate-output-support.ts";
import { consumerRegistry } from "./benchmark-gate-consumers.ts";
import * as bench from "./benchmark-privacy-boundary.ts";

Object.assign(registry, consumerRegistry);

export { environment, operation, registry, validate } from "../test/benchmark-gate-output-support.ts";

const field = (v: unknown, path: string): unknown =>
  path.split(".").reduce((o, k) => Reflect.get(Object(o), k), v);
export async function worker(root: string, name: string) {
  validate(Object.hasOwn(registry, name), "unknown workload");
  const paths =
    "util/proc util/privacy-boundary util/privacy-checker util/privacy-chunks util/privacy-proof util/privacy-policy gates/text-privacy gates/output gates/run gates/junit gates/test-coverage harness/sandbox harness/read-policy pipeline/context pipeline/prompts pipeline/report server/http".split(
      " ",
    );
  const modules = await Promise.all(
    paths.map((p) => (existsSync(join(root, `src/${p}.ts`)) ? import(join(root, `src/${p}.ts`)) : {})),
  );
  const a = Object.assign({}, ...modules) as API,
    env = environment(root),
    cwd = join(root, "fixture");
  await Promise.all([env.LIMITLESS_CONFIG_DIR, cwd].map((d) => fs.mkdir(d)));
  await fs.writeFile(join(cwd, "sample.test.ts"), "");
  const fixture = bench.workload("plain"),
    key = Buffer.alloc(32, 17);
  const strings = fixture.entries.map((e) => e.value).join("\n");
  await fs.writeFile(join(env.LIMITLESS_CONFIG_DIR, "private-strings.txt"), strings);
  await fs.writeFile(join(env.LIMITLESS_CONFIG_DIR, "privacy-proof.key"), key, { mode: 0o600 });
  (a.privacyRegistry as Checker["registry"]).replacePolicy(fixture.entries);
  fixture.credentials.forEach((s, i) => void (a.registerCredential as Fn)(`BENCHMARK_${i}`, s));
  let checker: Checker;
  const jobs = await registry[name]?.({ a, cwd, env, checker: () => checker, key });
  const operations: Record<string, bench.ProducerOperation> = {},
    unavailable: object[] = [];
  for (const [label, size, run, check, prepare] of jobs ?? []) {
    const dimensions = describe(name, label, size, a);
    if (!run) {
      unavailable.push({ dimensions, status: "unavailable" });
      continue;
    }
    let submissionMs: number[], latencyMs: number[], parses: number, elapsed: number;
    operations[`${label}/${size}`] = {
      dimensions,
      prepare: async (current) => {
        checker = current;
        await prepare?.();
      },
      run: async (current, own) => {
        [checker, submissionMs, latencyMs, parses] = [current, [], [], 0];
        const start = performance.now(),
          protect = checker.protectText;
        const enter = (phase: string, f: Fn) =>
          function (this: unknown, ...x: unknown[]) {
            return own(phase, () => f.apply(this, x));
          };
        const original = Bun.XML.parse,
          parse = original as Fn;
        Bun.XML.parse = enter("XML.parse", (...x) => [parses++, parse(...x)][1]) as typeof original;
        checker.protectText = (i, c) => {
          const start = performance.now(),
            result = own("submission", () => protect(i, c));
          submissionMs.push(performance.now() - start);
          return result.then(
            enter("consume", (v) => [latencyMs.push(performance.now() - start), v][1]),
          ) as typeof result;
        };
        try {
          return await run();
        } finally {
          elapsed = performance.now() - start;
          Bun.XML.parse = original;
        }
      },
      check: (v) => ({
        counters: consumerCounters(name, v),
        outcome:
          name === "junit" && !parses
            ? validate(
                v === undefined || field(v, "reason") === "JUnit report missing, stale or unsafe",
                "cap-refusal/fallback",
              )
            : check(v),
        parses,
        addedLatencyMs:
          name === "gate-5mib" && submissionMs.length
            ? elapsed - Number(field(v, "checks.0.durationMs"))
            : null,
        submissionMs,
        latencyMs,
        producer:
          name === "gate-5mib"
            ? submissionMs.length
              ? "adopted"
              : "baseline-without-producer-adoption"
            : undefined,
      }),
    };
  }
  return { pid: process.pid, name, unavailable, ...(await bench.measureWorker(root, undefined, operations)) };
}
export async function compare(refs: string[], names: string[], invoke = bench.launch) {
  const usage = "usage: bun scripts/benchmark-gate-output.ts <baseline-ref> <candidate-ref> [workloads]";
  if (refs.length !== 2) throw Error(`expected two refs, got ${refs.length}; ${usage}`);
  const unknown = names.filter((n) => !Object.hasOwn(registry, n));
  if (unknown.length)
    throw Error(`unknown workload(s) ${unknown.join(", ")}; known: ${Object.keys(registry).join(", ")}`);
  const [shas, revParse] = [[] as string[], ["git", "rev-parse", "--verify", "--end-of-options"]];
  const bad = (ref: string) => () =>
    Promise.reject(Error(`ref ${JSON.stringify(ref)} does not name a commit`));
  for (const ref of refs) shas.push(await bench.command([...revParse, `${ref}^{commit}`]).catch(bad(ref)));
  const script = ["--preload", join(import.meta.dir, "benchmark-resumptions.ts"), import.meta.path];
  const results = await bench.runRevisions(shas, names, (job) => invoke(job, script, environment));
  validateReports(results);
  return {
    units:
      "ms; U=UTF-16 code units; MiB=1048576 bytes; worker CPU=process minus main thread, including runtime helper threads",
    revisions: shas,
    deferred: ["checker-refusals", "worker-ingress"],
    results,
  };
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    const result =
      args[0] === "--worker"
        ? await worker(args[1] ?? "", args[2] ?? "")
        : await compare(args.slice(0, 2), args.length > 2 ? args.slice(2) : Object.keys(registry));
    console.log(JSON.stringify(result));
  } catch (error) {
    const where = args[0] === "--worker" ? `worker ${args[2]}` : "benchmark-gate-output";
    console.error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
