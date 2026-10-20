import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { buildClaudeArgs } from "../src/harness/claude.ts";
import { buildCodexArgs } from "../src/harness/codex.ts";
import { readPolicyScope } from "../src/harness/read-policy.ts";
import { seatbeltProfile } from "../src/harness/sandbox.ts";
import { SCRATCH_NAME, writeRoots } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import {
  deployCredentialsDir,
  deployJobStatus,
  deployProcess,
  mainSha,
  removeDeployJob,
  selfRepository,
} from "../src/land/deploy-process.ts";
import { agentEnv, registerCredential, sh } from "../src/util/proc.ts";

import { seatbeltSkip } from "./confinement.ts";

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
function harness(exitCode: number, launches: number, beforeLaunch?: (credentials: string) => void) {
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
      const credentials = join(deployCredentialsDir(root), `${args[3]}.credentials`);
      expect(statSync(credentials).mode & 0o777).toBe(0o600);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      beforeLaunch?.(credentials);
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
    options: { home: root },
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
      const outcome = await deployProcess(
        h.root,
        sha,
        "job-1",
        h.command,
        h.root,
        h.launchctl,
        7417,
        h.options,
      );
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
      expect(
        readdirSync(deployCredentialsDir(h.root)).filter((name) => name.endsWith(".credentials")),
      ).toEqual([]);
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
    const outcome = await deployProcess(
      h.root,
      sha,
      "job-2",
      h.command,
      h.root,
      h.launchctl,
      undefined,
      h.options,
    );
    expect(h.runs()).toBe(0);
    expect(existsSync(credentialFile(h, "job-2"))).toBe(false);
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
    mkdirSync(deployCredentialsDir(h.root), { recursive: true });
    writeFileSync(credentialFile(h, "done"), "[]");
    expect(await removeDeployJob("done", h.command, h.root, h.launchctl, h.options)).toBe(true);
    expect(existsSync(join(h.root, "dev.limitless.deploy.done.status"))).toBe(false);
    expect(existsSync(credentialFile(h, "done"))).toBe(false);
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
        return { ...response, exitCode: kind === "missing" ? 113 : 0 };
      }
      return response;
    };
    try {
      const outcome = await deployProcess(h.root, sha, "stalled", command, h.root, h.launchctl, 7417, {
        ...h.options,
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
      exitCode: args[1] === "remove" ? 1 : present ? 0 : 113,
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

function credentialFile(h: ReturnType<typeof harness>, job: string) {
  return join(deployCredentialsDir(h.root), `dev.limitless.deploy.${job}.credentials`);
}

test("submission failure removes credentials without putting them in arguments or diagnostics", async () => {
  const h = harness(0, 0);
  try {
    const command: typeof sh = async (args) => {
      expect(existsSync(credentialFile(h, "failed-submit"))).toBe(true);
      expect(args.join(" ")).not.toContain(h.secret);
      throw new Error("submission refused");
    };
    await expect(
      deployProcess(h.root, sha, "failed-submit", command, h.root, h.launchctl, 7400, h.options),
    ).rejects.toThrow("submission refused");
    expect(existsSync(credentialFile(h, "failed-submit"))).toBe(false);
  } finally {
    h.cleanup();
  }
});

for (const exitCode of [null, 1, 5, "throw", 113] as const) {
  test(`inspection ${exitCode} retains markers unless absence is definite`, async () => {
    const h = harness(0, 0);
    try {
      const status = join(h.root, "dev.limitless.deploy.inspect.status");
      mkdirSync(deployCredentialsDir(h.root), { recursive: true });
      writeFileSync(credentialFile(h, "inspect"), "[]");
      writeFileSync(`${status}.started`, "");
      const command: typeof sh = () => {
        if (exitCode === "throw") throw new Error("inspection unavailable");
        return Promise.resolve({ ...result(), exitCode });
      };
      expect(
        await deployJobStatus("inspect", 0, command, h.root, h.launchctl, { now: () => 1e9 }),
      ).toMatchObject({ kind: exitCode === 113 ? "missing" : "running" });
      writeFileSync(status, "0\n");
      expect(await removeDeployJob("inspect", command, h.root, h.launchctl, h.options)).toBe(
        exitCode === 113,
      );
      for (const file of [status, `${status}.started`, credentialFile(h, "inspect")])
        expect(existsSync(file)).toBe(exitCode !== 113);
      // A later definite observation permits cleanup of the same job.
      expect(
        await removeDeployJob(
          "inspect",
          async () => ({ ...result(), exitCode: 113 }),
          h.root,
          h.launchctl,
          h.options,
        ),
      ).toBe(true);
      expect(existsSync(credentialFile(h, "inspect"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });
}

test("a completion written during an inconclusive inspection wins", async () => {
  const h = harness(0, 0);
  try {
    const command: typeof sh = async () => {
      writeFileSync(join(h.root, "dev.limitless.deploy.race.status"), "7 1\n");
      throw new Error("inspection failed after completion");
    };
    expect(await deployJobStatus("race", 0, command, h.root, h.launchctl)).toMatchObject({
      kind: "done",
      exitCode: 7,
      filterExitCode: 1,
    });
  } finally {
    h.cleanup();
  }
});

for (const failure of ["invalid JSON", "invalid credentials", "missing", "unlink"] as const) {
  for (const exitCode of [0, 7]) {
    test(`redaction ${failure} drains producer and records deploy ${exitCode} separately`, async () => {
      const h = harness(exitCode, 1, (credentials) => {
        if (failure === "invalid JSON") writeFileSync(credentials, "{");
        if (failure === "invalid credentials") writeFileSync(credentials, "[42]");
        if (failure === "missing") rmSync(credentials);
      });
      try {
        const sentinel = join(h.root, "completed");
        writeFileSync(
          join(h.root, "src/cli/main.ts"),
          `
          import { writeSync, writeFileSync } from "node:fs";
          for (let i = 0; i < 256; i++) writeSync(1, ${JSON.stringify(h.secret)}.repeat(256) + "\\n");
          writeFileSync(${JSON.stringify(sentinel)}, "complete");
          process.exit(${exitCode});
        `,
        );
        const command: typeof sh = async (args, opts) => {
          if (failure === "unlink" && args[1] === "submit") {
            // Inject an unlink failure in the subprocess without relying on root's mode semantics.
            const filter = args.findIndex((arg) => arg.endsWith("/redact-deploy.ts"));
            const loader = join(h.root, "unlink-failure.ts");
            writeFileSync(
              loader,
              `
              import { mock } from "bun:test";
              import * as fs from "node:fs";
              mock.module("node:fs", () => ({ ...fs, unlinkSync: () => { throw new Error("private diagnostic"); } }));
              await import(${JSON.stringify(args[filter])});
            `,
            );
            args[filter] = loader;
          }
          return h.command(args, opts);
        };
        const outcome = await deployProcess(
          h.root,
          sha,
          "filter",
          command,
          h.root,
          h.launchctl,
          7400,
          h.options,
        );
        expect(readFileSync(sentinel, "utf8")).toBe("complete");
        expect(outcome).toMatchObject({
          ok: exitCode === 0,
          exitCode,
          filterExitCode: 1,
          reason: expect.stringContaining("log unavailable"),
        });
        expect(readFileSync(join(h.root, "dev.limitless.deploy.filter.log"), "utf8")).toBe(
          "[deploy output withheld: redaction unavailable]\n",
        );
        expect(await deployJobStatus("filter", 0, h.command, h.root, h.launchctl)).toMatchObject({
          kind: "done",
          exitCode,
          filterExitCode: 1,
        });
        expect(existsSync(credentialFile(h, "filter"))).toBe(false);
      } finally {
        h.cleanup();
      }
    });
  }
}

function policyFixture(root: string) {
  const home = join(root, "home");
  const cwd = join(root, "work");
  const scratchDir = join(root, "scratch-parent", SCRATCH_NAME);
  for (const path of [home, cwd, scratchDir]) mkdirSync(path, { recursive: true });
  const spec: AgentSpec = {
    cwd,
    scratchDir,
    mode: "edit",
    confineReads: true,
    prompt: "probe",
    target: {
      modelId: "fake",
      provider: "fake",
      harness: "fake",
      model: "fake",
      vendor: "fake",
      tier: 1,
      billing: "subscription",
    },
    timeoutMs: 1000,
    idleTimeoutMs: 1000,
    maxToolCalls: 1,
    signal: new AbortController().signal,
    logPath: join(root, "agent.log"),
    onEvent: () => {},
  };
  return { home, cwd, scratchDir, spec };
}

test("deploy credentials are denied by production gate, Claude and Codex policies", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deploy-policy-")));
  try {
    const p = policyFixture(root);
    const file = join(deployCredentialsDir(p.home), "stand-in.credentials");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "[]");
    const contains = (parent: string) => {
      const rel = relative(parent, file);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    readPolicyScope.run({ home: p.home, environment: {} }, () => {
      for (const gate of [false, true]) {
        const policy = writeRoots(p.cwd, p.scratchDir, gate);
        expect(policy.denyRead?.some(contains)).toBe(true);
        expect(policy.allowRead?.some(contains) ?? false).toBe(false);
      }
      for (const mode of ["edit", "readonly"] as const) {
        const spec = { ...p.spec, mode };
        const claude = buildClaudeArgs(spec, "session");
        const settings = JSON.parse(claude[claude.indexOf("--settings") + 1] ?? "{}");
        expect(settings.sandbox.filesystem.denyRead.some(contains)).toBe(true);
        expect(settings.sandbox.filesystem.allowRead?.some(contains) ?? false).toBe(false);
        const codex = buildCodexArgs(spec).find((arg) => arg.startsWith("permissions=")) ?? "";
        expect(codex).not.toBe("");
        // Named profiles use longest-prefix access rules: no readable grant may cover this file
        // more specifically than its deny. Parse the generated entries, not implementation text.
        const entries = [...codex.matchAll(/("(?:[^"\\]|\\.)*")="(none|read|write)"/g)]
          .map((match) => ({ path: String(JSON.parse(match[1] ?? '""')), access: match[2] }))
          .filter((entry) => contains(entry.path))
          .sort((a, b) => b.path.length - a.path.length);
        expect(entries[0]?.access).toBe("none");
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(seatbeltSkip !== null)(
  `deploy credential read denied while fake deploy is active, allowed control succeeds ${seatbeltSkip ?? ""}`,
  async () => {
    const h = harness(0, 1);
    const p = policyFixture(realpathSync(h.root));
    const ready = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const command: typeof sh = async (args, opts) => {
      if (args[1] === "submit") {
        const file = args.find((arg) => arg.endsWith(".credentials"));
        if (!file) throw new Error("Missing credential path");
        ready.resolve(file);
        await release.promise;
      }
      return h.command(args, opts);
    };
    // The fake launcher's submission stays active until the denied and control reads complete.
    const deploying = deployProcess(h.root, sha, "probe", command, h.root, h.launchctl, 7400, h.options);
    try {
      const file = await ready.promise;
      writeFileSync(join(p.cwd, "control"), "allowed");
      await readPolicyScope.run({ home: h.root, environment: {} }, async () => {
        for (const gate of [false, true]) {
          const profile = seatbeltProfile(writeRoots(p.cwd, p.scratchDir, gate));
          const read = (path: string) =>
            sh(["/usr/bin/sandbox-exec", "-p", profile, "/bin/cat", path], {
              cwd: p.cwd,
              env: agentEnv(),
              allowFail: true,
            });
          const denied = await read(file);
          expect(denied.exitCode).toBe(1);
          expect(denied.stdout).toBe("");
          expect(denied.stderr).toMatch(/Operation not permitted|Permission denied/);
          const allowed = await read(join(p.cwd, "control"));
          expect(allowed.exitCode).toBe(0);
          expect(allowed.stdout).toBe("allowed");
        }
      });
    } finally {
      release.resolve();
      await deploying;
      h.cleanup();
    }
  },
);

test("failed credential cleanup keeps markers until a later boot reconciliation", async () => {
  const h = harness(0, 0);
  try {
    const status = join(h.root, "dev.limitless.deploy.cleanup.status");
    writeFileSync(status, "0\n");
    writeFileSync(`${status}.started`, "");
    // An unexpected directory cannot be unlinked as a credential file.
    mkdirSync(credentialFile(h, "cleanup"), { recursive: true });
    await expect(removeDeployJob("cleanup", h.command, h.root, h.launchctl, h.options)).rejects.toThrow();
    expect(existsSync(status)).toBe(true);
    expect(existsSync(`${status}.started`)).toBe(true);
    rmSync(credentialFile(h, "cleanup"), { recursive: true });
    expect(await removeDeployJob("cleanup", h.command, h.root, h.launchctl, h.options)).toBe(true);
    expect(existsSync(status)).toBe(false);
    expect(existsSync(`${status}.started`)).toBe(false);
  } finally {
    h.cleanup();
  }
});
