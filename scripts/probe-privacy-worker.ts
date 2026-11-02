/** Manual real-worker probe for source and packaged entries (macOS, Linux); see docs/privacy-boundaries.md. */
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { release } from "../src/release.ts";
import { createPrivacyRegistry } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker, privacyWorkerEntry, startPrivacyWorker } from "../src/util/privacy-checker.ts";
import { consumeBoundaryChunk } from "../src/util/privacy-chunks.ts";

const fail = (stage: string): never => {
  throw new Error(`Privacy worker probe failed: ${stage}`);
};
const cases = [
  ["synthetic safe probe", "synthetic safe probe true false undefined"],
  ["a synthetic-private-probe", "[withheld: private text] false true private-match"],
];
async function check(staged?: string) {
  const registry = createPrivacyRegistry();
  registry.replacePolicy([{ entry: 0, value: "synthetic-private-probe" }]);
  const [entry, exits] = [privacyWorkerEntry(), [] as Promise<unknown>[]];
  const construct = (path: string) => {
    const worker = new Worker(path);
    exits.push(once(worker, "exit"));
    return worker;
  };
  const workerFactory = () => startPrivacyWorker(entry, construct);
  const checker = createPrivacyChecker({ registry, workerFactory });
  try {
    for (const [text = "", want] of cases) {
      const receipt = await checker.protectText({ text, provenance: { kind: "complete" } });
      const chunks = [consumeBoundaryChunk(receipt, 0)];
      while (!chunks.at(-1)?.done) chunks.push(consumeBoundaryChunk(receipt, chunks.length));
      const { checkedComplete, withheld, reason } = chunks.at(-1) ?? fail("no result chunk");
      const got = `${Buffer.concat(chunks.map((c) => c.bytes))} ${checkedComplete} ${withheld} ${reason}`;
      if (got !== want) fail(`${release.kind} result for ${JSON.stringify(text)}`);
    }
  } finally {
    await checker.dispose();
    const late = new Promise((done) => setTimeout(done, 5000, "late").unref());
    if ((await Promise.race([Promise.all(exits), late])) === "late") fail(`${release.kind} disposal`);
  }
  if (exits.length !== 1) fail(`${release.kind} worker count ${exits.length}`);
  if (staged !== undefined && existsSync(staged)) fail("staged source still visible");
  return { kind: release.kind, entry, workers: exits.length, results: "safe, private-match", disposed: true };
}
async function packaged(root = resolve(import.meta.dir, "..")) {
  const scratch = await mkdtemp(join(tmpdir(), "privacy-worker-probe-"));
  const at = (path: string) => join(scratch, path);
  const [stage, out, cwd, ui] = [at("stage"), at("out"), at("cwd"), at("ui")];
  try {
    await cp(join(root, "src"), join(stage, "src"), { recursive: true });
    await cp(join(root, "package.json"), join(stage, "package.json"));
    await cp(import.meta.path, join(stage, "scripts/probe-privacy-worker.ts"));
    await symlink(join(root, "node_modules"), join(stage, "node_modules"), "dir");
    await writeFile(join(stage, "src/cli/probe.ts"), 'import "../../scripts/probe-privacy-worker.ts";\n');
    await Promise.all([mkdir(ui), mkdir(cwd)]);
    // A candidate identity: the release build's own clean-tree SHA check stays unchanged.
    const { buildConfig } = await import(join(root, "scripts/build-binary.ts"));
    const config = buildConfig({ version: "0.0.0-probe", sha: "0".repeat(40) }, out, ui);
    const entrypoints = ["src/cli/probe.ts", "src/util/privacy-worker.ts"].map((p) => join(stage, p));
    const built = await Bun.build({ ...config, entrypoints });
    if (!built.success) throw new AggregateError(built.logs, "Privacy worker probe failed: packaged build");
    await unlink(join(stage, "node_modules"));
    await rm(stage, { recursive: true, force: true });
    const { runProcess } = await import(join(root, "src/util/proc.ts"));
    const env = { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), LANG: "C.UTF-8" };
    const cmd = [join(out, "limitless"), "--probe-packaged", stage];
    const child = await runProcess({ cmd, cwd, env, timeoutMs: 60_000, tailLimit: 100_000 });
    if (child.exitCode !== 0) fail(`packaged process: ${child.stderr.trim()}`);
    const report = JSON.parse(child.stdout) as Awaited<ReturnType<typeof check>>;
    if (report.kind !== "packaged" || !report.entry.startsWith("/$bunfs/")) fail("packaged entry");
    return report;
  } finally {
    await unlink(join(stage, "node_modules")).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}
const flag = process.argv.indexOf("--probe-packaged");
if (flag > 0) console.log(JSON.stringify(await check(process.argv[flag + 1] ?? fail("staged path"))));
else if (import.meta.main) {
  const source = await check();
  console.log(JSON.stringify({ platform: [process.platform, process.arch, Bun.version], source }));
  console.log(JSON.stringify({ packaged: await packaged(), sourceCopyRemoved: true }));
}
