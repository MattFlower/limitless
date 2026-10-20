import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployJobStatus,
  deployProcess,
  mainSha,
  removeDeployJob,
  selfRepository,
} from "../src/land/deploy-process.ts";
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
    `require("node:fs").appendFileSync(${JSON.stringify(runs)}, "x"); console.log(${JSON.stringify(`lock held ${secret}`)}); console.error(${JSON.stringify(`stderr ${secret}`)}); process.exit(${exitCode});`,
  );
  const calls: string[][] = [];
  const command: typeof sh = async (args) => {
    calls.push(args);
    if (args[1] === "submit") {
      const credentials = join(root, `${args[3]}.credentials`);
      expect(statSync(credentials).mode & 0o777).toBe(0o600);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      for (let i = 0; i < launches; i++) {
        const completed = await sh(args.slice(args.indexOf("--") + 1), {
          cwd: root,
          allowFail: true,
          timeoutMs: 10_000,
        });
        // launchd output is discarded; the wrapper writes only filtered output to the log.
        expect(completed.stdout).toBe("");
        expect(completed.stderr).toBe("");
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
      const outcome = await deployProcess(h.root, sha, "job-1", h.command, h.root, h.launchctl, 7417);
      const label = "dev.limitless.deploy.job-1";
      expect(h.calls[0]?.slice(0, 4)).toEqual([h.launchctl, "submit", "-l", label]);
      expect(h.calls[0]).toContain(`LIMITLESS_APP_DIR=${h.root}`);
      expect(h.calls[0]).toContain("LIMITLESS_PORT=7417");
      if (process.env.HOME) expect(h.calls[0]).toContain(`HOME=${process.env.HOME}`);
      expect(JSON.stringify(h.calls[0])).not.toContain(h.secret);
      const log = readFileSync(join(h.root, `${label}.log`), "utf8");
      expect(log).toContain("lock held [redacted]");
      expect(log).toContain("stderr [redacted]");
      expect(log).not.toContain(h.secret);
      expect(readdirSync(h.root).filter((name) => name.endsWith(".credentials"))).toEqual([]);
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
    expect(await removeDeployJob("running", h.command, h.root, h.launchctl)).toBe(false);
    expect(h.calls).toEqual([[h.launchctl, "list", "dev.limitless.deploy.running"]]);
    h.calls.length = 0;
    writeFileSync(join(h.root, "dev.limitless.deploy.done.status"), "0\n");
    expect(await removeDeployJob("done", h.command, h.root, h.launchctl)).toBe(true);
    expect(existsSync(join(h.root, "dev.limitless.deploy.done.status"))).toBe(false);
    expect(h.calls).toEqual([[h.launchctl, "remove", "dev.limitless.deploy.done"]]);
  } finally {
    h.cleanup();
  }
});

for (const kind of ["missing", "expired"] as const) {
  test(`deploy wait stops for ${kind} job and attempts removal`, async () => {
    const h = harness(0, 0);
    let now = 0;
    const command: typeof sh = async (args, opts) => {
      const response = await h.command(args, opts);
      if (args[1] === "list") {
        now += 5;
        return { ...response, exitCode: kind === "missing" ? 1 : 0 };
      }
      return response;
    };
    try {
      const outcome = await deployProcess(h.root, sha, "stalled", command, h.root, h.launchctl, 7417, {
        pollMs: 1,
        deadlineMs: 10,
        now: () => now,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toContain("dev.limitless.deploy.stalled");
        expect(outcome.reason).toContain(kind === "missing" ? "disappeared" : "within 10ms");
      }
      expect(h.calls).toContainEqual([h.launchctl, "remove", "dev.limitless.deploy.stalled"]);
    } finally {
      h.cleanup();
    }
  }, 3000);
}

test("status wins over disappearance and cleanup retries until the job is gone", async () => {
  const h = harness(0, 0);
  try {
    const status = join(h.root, "dev.limitless.deploy.finished.status");
    writeFileSync(status, "1\n");
    writeFileSync(`${status}.started`, "");
    let present = true;
    const command: typeof sh = async () => ({ ...result(), exitCode: present ? 0 : 1 });
    expect(await deployJobStatus("finished", 0, command, h.root, h.launchctl)).toMatchObject({
      kind: "done",
      exitCode: 1,
    });
    const failedRemove: typeof sh = async (args) => ({
      ...result(),
      exitCode: args[1] === "remove" ? 1 : present ? 0 : 1,
    });
    expect(await removeDeployJob("finished", failedRemove, h.root, h.launchctl)).toBe(false);
    expect(existsSync(status)).toBe(true);
    present = false;
    expect(await removeDeployJob("finished", failedRemove, h.root, h.launchctl)).toBe(true);
    expect(existsSync(status)).toBe(false);
    expect(existsSync(`${status}.started`)).toBe(false);
  } finally {
    h.cleanup();
  }
});
