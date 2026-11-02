import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { release } from "../src/release.ts";
import { createPrivacyRegistry } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker, privacyWorkerEntry, startPrivacyWorker } from "../src/util/privacy-checker.ts";
import { consumeBoundaryChunk } from "../src/util/privacy-chunks.ts";
import { runProcess } from "../src/util/proc.ts";

const cases = [
  ["synthetic safe probe", "synthetic safe probe true false undefined"],
  ["a synthetic-private-probe", "[withheld: private text] false true private-match"],
];
async function check(hidden: string[] = []) {
  const registry = createPrivacyRegistry();
  registry.replacePolicy([{ entry: 0, value: "synthetic-private-probe" }]);
  const [entry, exits] = [privacyWorkerEntry(), [] as Promise<unknown>[]];
  const construct = (path: string, worker = new Worker(path)) =>
    Object.assign(worker, { exited: exits.push(once(worker, "exit")) });
  const workerFactory = () => startPrivacyWorker(entry, construct);
  const checker = createPrivacyChecker({ registry, workerFactory });
  try {
    for (const [text = "", want] of cases) {
      const receipt = await checker.protectText({ text, provenance: { kind: "complete" } });
      const chunks = [consumeBoundaryChunk(receipt, 0)];
      while (!chunks.at(-1)?.done) chunks.push(consumeBoundaryChunk(receipt, chunks.length));
      const { checkedComplete, withheld, reason } = chunks.at(-1) ?? {};
      const got = `${Buffer.concat(chunks.map((c) => c.bytes))} ${checkedComplete} ${withheld} ${reason}`;
      assert.equal(got, want, `${release.kind} result`);
    }
  } finally {
    await checker.dispose();
    const late = new Promise((done) => setTimeout(done, 5000, "late").unref());
    assert.notEqual(await Promise.race([Promise.all(exits), late]), "late", `${release.kind} disposal`);
  }
  assert.equal(exits.length, 1, `${release.kind} worker count`);
  const visible = hidden.filter((path) => {
    try {
      readFileSync(join(path, "src/util/privacy-worker.ts"));
      return true;
    } catch {
      return false;
    }
  });
  return { kind: release.kind, entry, workers: 1, results: "safe, private-match", disposed: true, visible };
}
/** Hides the checkout from the packaged child: Seatbelt on macOS, a private tmpfs mount on Linux. */
const confine = (root: string, cmd: string[]) =>
  (process.platform === "darwin"
    ? ["sandbox-exec", "-p", `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(root)}))`]
    : ["unshare", "-rm", "sh", "-c", 'mount -t tmpfs none "$0" && exec "$@"', root]
  ).concat(cmd);
async function packaged(root = realpathSync(resolve(import.meta.dir, ".."))) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "privacy-worker-probe-")));
  const [stage = "", out = "", cwd = "", ui = ""] = ["stage", "out", "cwd", "ui"].map((p) => join(dir, p));
  const env = { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() };
  const run = (cmd: string[]) => runProcess({ cmd: confine(root, cmd), cwd, env, timeoutMs: 60_000 });
  try {
    for (const path of ["src", "scripts", "package.json", "node_modules"]) // Copies: no path leads back.
      await cp(join(root, path), join(stage, path), { recursive: true });
    await writeFile(join(stage, "src/cli/probe.ts"), 'import "../../scripts/probe-privacy-worker.ts";\n');
    await Promise.all([mkdir(ui), mkdir(cwd)]);
    const { buildConfig } = await import(join(root, "scripts/build-binary.ts")); // Its SHA check stays unused.
    const entrypoints = ["src/cli/probe.ts", "src/util/privacy-worker.ts"].map((p) => join(stage, p));
    const config = { ...buildConfig({ version: "0.0.0-probe", sha: "0".repeat(40) }, out, ui), entrypoints };
    const built = await Bun.build(config);
    if (!built.success) throw new AggregateError(built.logs, "Privacy worker probe: packaged build failed");
    await rm(stage, { recursive: true, force: true });
    const hidden = await run(["/bin/sh", "-c", `test ! -e "${root}/package.json"`]);
    assert.equal(hidden.exitCode, 0, `The OS refused to hide the checkout: ${hidden.stderr.trim()}`);
    const child = await run([join(out, "limitless"), "--probe-packaged", root, stage]);
    assert.equal(child.exitCode, 0, `Packaged process failed: ${child.stderr.trim()}`);
    const report = JSON.parse(child.stdout) as Awaited<ReturnType<typeof check>>;
    assert.deepEqual([report.kind, report.entry.split("/")[1], report.visible], ["packaged", "$bunfs", []]);
    return { ...report, checkoutHidden: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const flag = process.argv.indexOf("--probe-packaged");
if (flag > 0) console.log(JSON.stringify(await check(process.argv.slice(flag + 1))));
else if (import.meta.main) {
  const platform = [process.platform, process.arch, Bun.version];
  console.log(JSON.stringify({ platform, source: await check() }));
  console.log(JSON.stringify({ packaged: await packaged() }));
}
