import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClaudeArgs, runClaude } from "../src/harness/claude.ts";
import { buildCodexArgs, CodexReaderProbe, runCodex } from "../src/harness/codex.ts";
import {
  createScratch,
  removeScratch,
  SCRATCH_NAME,
  scratchEnv,
  withScratch,
} from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { withholdText } from "../src/pipeline/context.ts";
import type { ProcOptions, ProcResult, runProcess } from "../src/util/proc.ts";

const specFor = (cwd: string, scratchDir: string): AgentSpec => ({
  cwd,
  scratchDir,
  prompt: "test",
  mode: "readonly",
  timeoutMs: 1000,
  idleTimeoutMs: 1000,
  maxToolCalls: 10,
  logPath: join(scratchDir, "log"),
  signal: new AbortController().signal,
  onEvent: () => {},
  target: {
    modelId: "test/model",
    provider: "test",
    harness: "fake",
    model: "test",
    vendor: "test",
    tier: 4,
    billing: "subscription",
  },
});
const procResult: ProcResult = {
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  idleTimedOut: false,
  stdout: "",
  stderr: "",
  truncated: false,
  durationMs: 1,
};

test("scratch is outside inherited TMPDIR in checkout, unique concurrently, removed after throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "scratch-test-"));
  const inherited = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const paths: string[] = [];
  try {
    process.env.TMPDIR = root;
    await Promise.all(
      [0, 1, 2].map((n) =>
        withScratch(root, async (path) => {
          paths.push(path);
          expect(path.startsWith(realpathSync(root))).toBe(false);
          writeFileSync(join(path, "fixture"), "data");
          await Bun.sleep(5);
          expect(existsSync(path)).toBe(true);
          expect(process.env.TMPDIR).toBe(root);
          if (n === 2) throw new Error("failure");
        }).catch((e: Error) => expect(e.message).toBe("failure")),
      ),
    );
    expect(new Set(paths).size).toBe(3);
    for (const path of paths) expect(existsSync(dirname(path))).toBe(false);
    expect(process.env.TMP).toBe(inherited.TMP);
    expect(process.env.TEMP).toBe(inherited.TEMP);
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("native arguments restrict reading writes and preserve no-tools isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "args with spaces-"));
  const cwd = join(root, "worktree");
  const scratch = join(root, "scratch space", SCRATCH_NAME);
  mkdirSync(cwd);
  mkdirSync(scratch, { recursive: true });
  try {
    const spec = specFor(cwd, scratch);
    const codex = buildCodexArgs(spec);
    expect(codex).toContain("--strict-config");
    expect(codex).toContain("--ignore-user-config");
    expect(codex).not.toContain("workspace-write");
    expect(codex).not.toContain("--add-dir");
    const policy = codex.find((arg) => arg.startsWith("permissions="));
    expect(policy).toBe(
      `permissions={limitless-reader={filesystem={"/"="read",${JSON.stringify(realpathSync(scratch))}="write"},network={enabled=false}}}`,
    );
    const claude = buildClaudeArgs(spec, "id");
    const settings = JSON.parse(claude[claude.indexOf("--settings") + 1] ?? "{}");
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [realpathSync(scratch)], denyWrite: [realpathSync(cwd)] },
    });
    expect(claude[claude.indexOf("--setting-sources") + 1]).toBe("");
    // Claude derives its sandbox TMPDIR from the parent; another name would silently diverge.
    const misnamed = join(root, "misnamed");
    mkdirSync(misnamed);
    expect(() => buildClaudeArgs({ ...spec, scratchDir: misnamed }, "id")).toThrow(SCRATCH_NAME);
    for (const build of [buildCodexArgs, (s: AgentSpec) => buildClaudeArgs(s, "id")]) {
      expect(() => build({ ...spec, addDirs: [root] })).toThrow("additional directories");
      expect(() => build({ ...spec, scratchDir: cwd })).toThrow("separate");
      expect(() => build({ ...spec, scratchDir: undefined })).toThrow("requires a scratch");
    }
    const noTools = buildCodexArgs({ ...spec, noTools: true });
    expect(noTools).toContain("read-only");
    expect(noTools).toContain("shell_tool");
    expect(noTools.some((arg) => arg.startsWith("permissions="))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("denyRead keeps tool-enabled readers out of a parallel worktree", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deny-read-")));
  const cwd = join(root, "snapshot");
  const implementer = join(root, "implementer");
  const scratch = join(root, "scratch", SCRATCH_NAME);
  for (const dir of [cwd, implementer, scratch]) mkdirSync(dir, { recursive: true });
  try {
    const spec = { ...specFor(cwd, scratch), denyRead: [implementer] };
    expect(codexAccess(buildCodexArgs(spec), join(implementer, "marker.txt"))).toBe("none");
    const claude = buildClaudeArgs(spec, "id");
    const settings = JSON.parse(claude[claude.indexOf("--settings") + 1] ?? "{}");
    expect(settings.sandbox.filesystem.denyRead).toEqual([implementer]);
    expect(claude.slice(claude.indexOf("--disallowedTools"))).toContain(`Read(/${implementer}/**)`);
    for (const build of [buildCodexArgs, (s: AgentSpec) => buildClaudeArgs(s, "id")]) {
      expect(() => build({ ...spec, denyRead: [root] })).toThrow("outside");
      expect(() => build({ ...spec, confineReads: true, denyRead: [root] })).toThrow("outside");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Access the Codex profile grants `path`: the most specific entry wins; `:minimal` is system files. */
function codexAccess(args: string[], path: string): string {
  const policy = args.find((arg) => arg.startsWith("permissions=")) ?? "";
  let best: [string, string] | null = null;
  for (const [, key = "", access = ""] of policy.matchAll(/("(?:[^"\\]|\\.)*")="(read|write|none)"/g)) {
    const entry = JSON.parse(key) as string;
    if (entry.startsWith(":") || !(path === entry || path.startsWith(entry === "/" ? "/" : `${entry}/`)))
      continue;
    if (!best || entry.length > best[0].length) best = [entry, access];
  }
  return best?.[1] ?? "none";
}

/** Whether Claude's sandbox lets Bash read `path`: allowRead wins inside denyRead; reads default on. */
function claudeSandboxReads(args: string[], path: string): boolean {
  const { denyRead = [], allowRead = [] } = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}").sandbox
    .filesystem as { denyRead?: string[]; allowRead?: string[] };
  const inside = (root: string) => path === root || path.startsWith(`${root}/`);
  return allowRead.some(inside) || !denyRead.some(inside);
}

function confinedFixture() {
  const parent = mkdtempSync(join(tmpdir(), "limitless-holdout-test-"));
  const cwd = join(parent, "base");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "base.txt"), "base\n");
  const scratch = createScratch(cwd);
  return {
    cwd,
    scratch,
    spec: { ...specFor(cwd, scratch), confineReads: true },
    cleanup: () => {
      removeScratch(scratch);
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

test("confined readers are granted reads only in their cwd and scratch", () => {
  const { cwd, scratch, spec, cleanup } = confinedFixture();
  const home = homedir();
  const other = mkdtempSync(join(tmpdir(), "limitless-private-test-"));
  try {
    const privatePaths = [
      home,
      join(home, ".claude", "projects", "-Users-x--limitless-work-run", "s.jsonl"),
      join(home, ".codex", "sessions", "2026", "rollout.jsonl"),
      join(home, ".ssh", "id_ed25519"),
      join(home, ".limitless", "limitless.db"),
      join(other, "inv-1.log"),
      realpathSync(other),
      "/tmp/lr-other/claude-0/notes.md",
    ];
    const codex = buildCodexArgs(spec);
    const policy = codex.find((arg) => arg.startsWith("permissions=")) ?? "";
    expect(policy).not.toContain('"/"="read"');
    expect(policy).toContain('":minimal"="read"');
    const granted = [...policy.matchAll(/("(?:[^"\\]|\\.)*")="(read|write)"/g)]
      .map(([, key = ""]) => JSON.parse(key) as string)
      .filter((path) => path !== ":minimal");
    const spelled = (path: string) => [...new Set([path, realpathSync(path)])];
    expect(new Set(granted)).toEqual(new Set([...spelled(cwd), ...spelled(scratch)]));
    expect(codexAccess(codex, join(realpathSync(cwd), "base.txt"))).toBe("read");
    expect(codexAccess(codex, join(realpathSync(scratch), "n"))).toBe("write");

    const claude = buildClaudeArgs(spec, "id");
    const allowed = claude.slice(claude.indexOf("--allowedTools") + 1, claude.indexOf("--disallowedTools"));
    // A bare Read, Grep or Glob allow would reach every path; Read rules also govern Grep and Glob.
    expect(allowed).not.toContain("Read");
    expect(allowed).not.toContain("Grep");
    expect(allowed).not.toContain("Glob");
    expect(allowed).toEqual([...[...spelled(cwd), ...spelled(scratch)].map((p) => `Read(/${p}/**)`), "Bash"]);
    expect(claudeSandboxReads(claude, join(realpathSync(cwd), "base.txt"))).toBe(true);
    expect(claudeSandboxReads(claude, join(realpathSync(scratch), "n"))).toBe(true);

    for (const path of privatePaths) {
      expect(codexAccess(codex, path)).toBe("none");
      expect(claudeSandboxReads(claude, path)).toBe(false);
      const readRoots = allowed.filter((rule) => rule.startsWith("Read(")).map((rule) => rule.slice(6, -4));
      expect(readRoots.some((root) => path === root || path.startsWith(`${root}/`))).toBe(false);
    }
  } finally {
    cleanup();
    rmSync(other, { recursive: true, force: true });
  }
});

/** Why the real Codex sandbox can't be exercised here, or null when it can. */
function codexSandboxUnavailable(): string | null {
  if (!Bun.which("codex")) return "codex CLI not installed";
  const probe = Bun.spawnSync(["codex", "sandbox", "--", "true"], { stdout: "ignore", stderr: "ignore" });
  return probe.exitCode === 0 ? null : `codex sandbox cannot start here (exit ${probe.exitCode})`;
}
const codexSkip = codexSandboxUnavailable();

test.skipIf(codexSkip !== null)(
  `the real Codex sandbox enforces the confined reader profile${codexSkip ? ` (skipped: ${codexSkip})` : ""}`,
  () => {
    const { cwd, scratch, spec, cleanup } = confinedFixture();
    const other = mkdtempSync(join("/tmp", "other-run-"));
    const factory = realpathSync(mkdtempSync(join(tmpdir(), "factory-home-")));
    writeFileSync(join(other, "marker.txt"), "implementation marker\n");
    writeFileSync(join(factory, "secrets.env"), "implementation marker\n");
    symlinkSync(other, join(cwd, "link"));
    try {
      const policy = buildCodexArgs({ ...spec, denyRead: [factory] }).find((arg) =>
        arg.startsWith("permissions="),
      );
      const sandboxed = (command: string) => {
        const proc = Bun.spawnSync(
          [
            "codex",
            "sandbox",
            "-c",
            'default_permissions="limitless-reader"',
            "-c",
            policy ?? "",
            "--",
            "/bin/sh",
            "-c",
            command,
          ],
          { cwd, env: { ...process.env, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe" },
        );
        return { code: proc.exitCode, out: proc.stdout.toString() };
      };
      expect(sandboxed("cat base.txt")).toEqual({ code: 0, out: "base\n" });
      expect(sandboxed('echo note > "$TMPDIR/n" && cat "$TMPDIR/n"')).toEqual({ code: 0, out: "note\n" });
      for (const command of [
        `cat ${other}/marker.txt`,
        "cat link/marker.txt",
        `cat ${factory}/secrets.env`,
        `ls ${homedir()}`,
        "ls /tmp",
      ]) {
        const denied = sandboxed(command);
        expect(denied.code).not.toBe(0);
        expect(denied.out).not.toContain("implementation marker");
      }
    } finally {
      cleanup();
      rmSync(other, { recursive: true, force: true });
      rmSync(factory, { recursive: true, force: true });
    }
  },
);

const CODEX = "/opt/codex/bin/codex";
const denies = (canary: string) => ({ exitCode: 1, stderr: `cat: ${canary}: Operation not permitted\n` });

/** A fake Codex CLI: `--version`, the `sandbox` probe (answered by `sandbox`), and a completing `exec`. */
function fakeCodex(sandbox: (canary: string) => Partial<ProcResult> | Error = denies) {
  const cli = { path: CODEX as string | null, version: "codex-cli 0.157.1" as string | null, sandboxes: 0 };
  const calls: string[][] = [];
  const canaries: string[] = [];
  const runner = async (opts: ProcOptions): Promise<ProcResult> => {
    calls.push(opts.cmd);
    if (opts.cmd[1] === "--version")
      return cli.version ? { ...procResult, stdout: `${cli.version}\n` } : { ...procResult, exitCode: 1 };
    if (opts.cmd[1] === "sandbox") {
      cli.sandboxes++;
      const canary = opts.cmd.at(-1) ?? "";
      canaries.push(canary);
      await Bun.sleep(5);
      const out = sandbox(canary);
      if (out instanceof Error) throw out;
      return { ...procResult, ...out };
    }
    opts.onStdoutLine?.('{"type":"turn.completed","usage":{}}');
    return procResult;
  };
  return { cli, calls, canaries, runner, probe: new CodexReaderProbe(() => cli.path) };
}
const profileArgs = (cmd: string[] = []) =>
  cmd.filter((arg, i) => cmd[i - 1] === "-c" && /permissions/.test(arg));

test("a denied canary read lets confined codex exec run with the probed CLI and profile", async () => {
  const { cwd, spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  try {
    const result = await runCodex(spec, fake.runner, fake.probe);
    expect(result.status).toBe("ok");
    expect(result.confinement).toEqual({ ok: true, path: CODEX, version: "codex-cli 0.157.1", reason: null });
    expect(fake.calls.map((cmd) => cmd.slice(0, 2))).toEqual([
      [CODEX, "--version"],
      [CODEX, "sandbox"],
      [CODEX, "exec"],
    ]);
    const [, probe, exec] = fake.calls;
    expect(profileArgs(exec)).toHaveLength(2);
    expect(profileArgs(probe)).toEqual(profileArgs(exec));
    const canary = fake.canaries[0] ?? "";
    expect(canary.startsWith(realpathSync(cwd))).toBe(false);
    expect(codexAccess(exec ?? [], canary)).toBe("none");
    expect(existsSync(canary)).toBe(false);
  } finally {
    cleanup();
  }
});

for (const [name, sandbox, change, reason] of [
  [
    "readable canary",
    (c: string) => ({ exitCode: 0, stdout: readFileSync(c, "utf8") }),
    {},
    "allowed reading",
  ],
  [
    "unrelated error",
    () => ({ exitCode: 2, stderr: "error: unexpected argument '-c'" }),
    {},
    "did not report",
  ],
  ["other path denied", () => ({ exitCode: 1, stderr: "cat: /x: Permission denied" }), {}, "did not report"],
  [
    "timeout",
    (c: string) => ({ exitCode: null, timedOut: true, stderr: denies(c).stderr }),
    {},
    "did not finish",
  ],
  [
    "signaled denial",
    (c: string) => ({ exitCode: null, signal: "SIGKILL", stderr: denies(c).stderr }),
    {},
    "did not finish (SIGKILL)",
  ],
  ["sandbox startup", () => new Error("spawn EACCES"), {}, "failed to start: spawn EACCES"],
  ["missing CLI", denies, { path: null }, "codex CLI not found"],
  ["version lookup", denies, { version: null }, "--version failed"],
] as const)
  test(`confined codex exec never starts when the probe fails: ${name}`, async () => {
    const { spec, cleanup } = confinedFixture();
    const fake = fakeCodex(sandbox);
    Object.assign(fake.cli, change);
    try {
      const result = await runCodex(spec, fake.runner, fake.probe);
      expect(result.status).toBe("unavailable");
      expect(result.confinement?.ok).toBe(false);
      expect(result.confinement?.reason).toContain(reason);
      expect(result.error).toContain(reason);
      expect(fake.calls.some((cmd) => cmd[1] === "exec")).toBe(false);
      for (const canary of fake.canaries) expect(existsSync(canary)).toBe(false);
    } finally {
      cleanup();
    }
  });

test("one probe per CLI path and version, shared by concurrent and later invocations", async () => {
  const { spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  const failing = fakeCodex(() => ({ exitCode: 0 }));
  try {
    await Promise.all([0, 1, 2].map(() => runCodex(spec, fake.runner, fake.probe)));
    expect(fake.cli.sandboxes).toBe(1);
    expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
    expect(fake.cli.sandboxes).toBe(1);
    fake.cli.version = "codex-cli 0.158.0";
    await runCodex(spec, fake.runner, fake.probe);
    expect(fake.cli.sandboxes).toBe(2);
    fake.cli.path = "/usr/local/bin/codex";
    await runCodex(spec, fake.runner, fake.probe);
    expect(fake.cli.sandboxes).toBe(3);
    expect(fake.calls.filter((cmd) => cmd[1] === "exec")).toHaveLength(6);
    for (const _ of [0, 1])
      expect((await runCodex(spec, failing.runner, failing.probe)).status).toBe("unavailable");
    expect(failing.cli.sandboxes).toBe(1);
  } finally {
    cleanup();
  }
});

test("cancelling during the probe stops it, never starts exec, and is not cached", async () => {
  const { spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  const abort = new AbortController();
  const signals: (AbortSignal | undefined)[] = [];
  const runner = async (opts: ProcOptions): Promise<ProcResult> => {
    signals.push(opts.signal);
    if (opts.cmd[1] !== "sandbox" || opts.signal !== abort.signal) return fake.runner(opts);
    await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
    return { ...procResult, exitCode: null, signal: "SIGTERM", cancelled: true };
  };
  try {
    const pending = runCodex({ ...spec, signal: abort.signal }, runner, fake.probe);
    await Bun.sleep(5);
    abort.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(signals.slice(0, 2)).toEqual([abort.signal, abort.signal]);
    expect(fake.calls.some((cmd) => cmd[1] === "exec")).toBe(false);
    expect((await runCodex(spec, runner, fake.probe)).status).toBe("ok");
    expect(fake.cli.sandboxes).toBe(1);
  } finally {
    cleanup();
  }
});

test("private logs keep the stream's structure but withhold its text", async () => {
  const { cwd, scratch, spec, cleanup } = confinedFixture();
  try {
    const probed = fakeCodex();
    const runConfinedCodex = (s: AgentSpec, runner: typeof runProcess) =>
      runCodex(s, (o) => (o.cmd[1] === "exec" ? runner(o) : probed.runner(o)), probed.probe);
    for (const run of [runClaude, runConfinedCodex]) {
      const logPath = join(scratch, `${run.name}.log`);
      await run({ ...spec, logPath, redactOutput: withholdText }, async (opts: ProcOptions) => {
        opts.onStdoutLine?.(JSON.stringify({ type: "assistant", text: "H-1 private scenario", n: 3 }));
        opts.onStderrLine?.("stderr H-1 private scenario");
        return procResult;
      });
      const log = readFileSync(logPath, "utf8");
      expect(log).not.toContain("private scenario");
      expect(log).toContain('{"type":"[private]","text":"[private]","n":3}');
    }
  } finally {
    cleanup();
  }
  expect(existsSync(cwd)).toBe(false);
});

for (const outcome of ["success", "error", "timeout", "cancelled"] as const) {
  test(`native injected process environment and cleanup: ${outcome}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "env-test-"));
    const parent = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    const paths: string[] = [];
    try {
      for (const run of [runClaude, runCodex]) {
        await withScratch(cwd, async (scratchDir) => {
          paths.push(scratchDir);
          const spec = specFor(cwd, scratchDir);
          spec.target.backend = { baseUrl: "http://backend.invalid", authToken: "backend-only-token" };
          const runner = async (opts: ProcOptions): Promise<ProcResult> => {
            expect(opts.env).toMatchObject(scratchEnv(spec));
            expect(opts.env.GH_TOKEN).toBe("limitless-agents-have-no-github-access");
            if (run === runClaude) {
              expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBe("backend-only-token");
              expect(opts.env.CLAUDE_CODE_TMPDIR).toBe(dirname(scratchDir));
              expect(join(opts.env.CLAUDE_CODE_TMPDIR ?? "", SCRATCH_NAME)).toBe(scratchDir);
            } else expect(opts.env.CLAUDE_CODE_TMPDIR).toBeUndefined();
            expect(existsSync(scratchDir)).toBe(true);
            writeFileSync(join(scratchDir, "fixture"), "ok");
            if (outcome === "error") throw new Error("injected process failure");
            opts.onStdoutLine?.(
              run === runClaude
                ? '{"type":"result","subtype":"success","result":"ok"}'
                : '{"type":"turn.completed","usage":{}}',
            );
            return { ...procResult, timedOut: outcome === "timeout", cancelled: outcome === "cancelled" };
          };
          if (outcome === "error")
            await expect(run(spec, runner)).rejects.toThrow("injected process failure");
          else expect((await run(spec, runner)).status).toBe(outcome === "success" ? "ok" : outcome);
        });
      }
      expect(paths[0]).not.toBe(paths[1]);
      for (const path of paths) expect(existsSync(dirname(path))).toBe(false);
      expect({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }).toEqual(parent);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("scratch falls back to the next base when the preferred one denies writes", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limitless-scratch-")));
  const denied = join(dir, "denied");
  const allowed = join(dir, "allowed");
  const worktree = join(dir, "worktree");
  for (const path of [denied, allowed, worktree]) mkdirSync(path);
  chmodSync(denied, 0o500);
  try {
    const scratch = createScratch(worktree, [denied, allowed]);
    expect(dirname(dirname(scratch))).toBe(allowed);
    expect(scratch.endsWith(SCRATCH_NAME)).toBe(true);
    removeScratch(scratch);
  } finally {
    chmodSync(denied, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scratch still fails when no base is writable", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "limitless-scratch-")));
  const denied = join(dir, "denied");
  const worktree = join(dir, "worktree");
  for (const path of [denied, worktree]) mkdirSync(path);
  chmodSync(denied, 0o500);
  try {
    expect(() => createScratch(worktree, [denied])).toThrow("No temporary directory");
  } finally {
    chmodSync(denied, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
