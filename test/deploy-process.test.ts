import { expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployProcess, mainSha, removeDeployJob, selfRepository } from "../src/land/deploy-process.ts";
import { registerCredential, sh } from "../src/util/proc.ts";

const sha = "b".repeat(40);
const result = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

test("production resolvers read release origin and exact remote main with timeouts", async () => {
  for (const origin of [
    "git@github.com:test/self.git",
    "https://github.com/test/self.git",
    "ssh://git@github.com/test/self.git",
  ]) {
    const command: typeof sh = async (args, opts) => {
      expect(args).toEqual(["git", "remote", "get-url", "origin"]);
      expect(opts).toMatchObject({ cwd: "release", timeoutMs: 10_000 });
      return result(`${origin}\n`);
    };
    expect(await selfRepository("release", command)).toBe("test/self");
  }
  const command: typeof sh = async (args, opts) => {
    expect(args).toEqual(["git", "ls-remote", "origin", "refs/heads/main"]);
    expect(opts).toMatchObject({ cwd: "release", timeoutMs: 30_000 });
    return result(`${sha}\trefs/heads/main\n`);
  };
  expect(await mainSha("release", command)).toBe(sha);
  await expect(mainSha("release", async () => result(""))).rejects.toThrow("main SHA");
  await expect(
    selfRepository("release", async () => result("https://example.com/test/self.git")),
  ).rejects.toThrow("not a GitHub repository");
});

/**
 * A fake release whose `deploy` appends to a counter, and a fake launchctl whose `submit` runs the
 * job `launches` times in a row, as launchd's keep-alive would if the job exited instead of
 * removing itself.
 */
function harness(exitCode: number, launches: number) {
  const root = mkdtempSync(join(tmpdir(), "limitless-deploy-process space-"));
  const secret = `deploy-output-${crypto.randomUUID()}`;
  registerCredential("DEPLOY_PROCESS_TEST", secret);
  const runs = join(root, "runs");
  const removals = join(root, "removals");
  const launchctl = join(root, "fake launchctl");
  writeFileSync(launchctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(removals)}\n`);
  chmodSync(launchctl, 0o755);
  mkdirSync(join(root, "src/cli"), { recursive: true });
  writeFileSync(
    join(root, "src/cli/main.ts"),
    `require("node:fs").appendFileSync(${JSON.stringify(runs)}, "x"); console.log(${JSON.stringify(`lock held ${secret}`)}); process.exit(${exitCode});`,
  );
  const calls: string[][] = [];
  const command: typeof sh = async (args) => {
    calls.push(args);
    if (args[1] === "submit") {
      const log = args[args.indexOf("-o") + 1];
      if (!log) throw new Error("missing deploy log path");
      for (let i = 0; i < launches; i++) {
        const completed = await sh(args.slice(args.indexOf("--") + 1), {
          cwd: root,
          allowFail: true,
          timeoutMs: 10_000,
        });
        appendFileSync(log, completed.stdout + completed.stderr);
      }
    }
    return result();
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  return {
    root,
    secret,
    calls,
    command,
    launchctl,
    runs: () => read(runs).length,
    removals: () => read(removals).trim().split("\n").filter(Boolean),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const exitCode of [0, 1]) {
  test(`deploy job runs exact SHA with smoke once and removes itself, exit ${exitCode}`, async () => {
    const h = harness(exitCode, 2);
    try {
      const outcome = await deployProcess(h.root, sha, "job-1", h.command, h.root, h.launchctl);
      const label = "dev.limitless.deploy.job-1";
      expect(h.calls[0]?.slice(0, 4)).toEqual([h.launchctl, "submit", "-l", label]);
      expect(h.calls[0]).toContain(`LIMITLESS_APP_DIR=${h.root}`);
      expect(h.calls[0]?.slice(-5)).toEqual([
        process.execPath,
        join(h.root, "src/cli/main.ts"),
        "deploy",
        sha,
        "--smoke",
      ]);
      // A keep-alive relaunch must not deploy again, and every launch ends by removing the job.
      expect(h.runs()).toBe(1);
      expect(h.removals()).toEqual([`remove ${label}`, `remove ${label}`]);
      expect(h.calls[1]).toEqual([h.launchctl, "remove", label]);
      expect(outcome.ok).toBe(exitCode === 0);
      if (!outcome.ok) {
        expect(outcome.reason).toContain("lock held");
        expect(outcome.reason).not.toContain(h.secret);
        expect(outcome.reason).toContain("[redacted]");
      }
    } finally {
      h.cleanup();
    }
  });
}

test("a relaunch after an interrupted deploy reports failure without deploying", async () => {
  const h = harness(0, 1);
  try {
    writeFileSync(join(h.root, "dev.limitless.deploy.job-2.status.started"), "");
    const outcome = await deployProcess(h.root, sha, "job-2", h.command, h.root, h.launchctl);
    expect(h.runs()).toBe(0);
    expect(h.removals()).toEqual(["remove dev.limitless.deploy.job-2"]);
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("not deploying again") });
  } finally {
    h.cleanup();
  }
});

test("boot cleanup removes a finished deploy job and leaves a running one alone", async () => {
  const h = harness(0, 1);
  try {
    await removeDeployJob("running", h.command, h.root, h.launchctl);
    expect(h.calls).toEqual([]);
    writeFileSync(join(h.root, "dev.limitless.deploy.done.status"), "0\n");
    await removeDeployJob("done", h.command, h.root, h.launchctl);
    expect(h.calls).toEqual([[h.launchctl, "remove", "dev.limitless.deploy.done"]]);
  } finally {
    h.cleanup();
  }
});
