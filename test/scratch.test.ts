import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClaudeArgs, runClaude } from "../src/harness/claude.ts";
import { buildCodexArgs, CodexReaderProbe, type ReaderProbeOptions, runCodex } from "../src/harness/codex.ts";
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
const SECRET = "sk-live-SENTINEL-4242";
const denies = (file: string) => ({
  exitCode: 1,
  stderr: `cat: ${file}: Operation not permitted\n${SECRET}\n`,
});
const reads = (file: string) => ({ exitCode: 0, stdout: readFileSync(file, "utf8") });
type Sandbox = (
  file: string,
  opts: ProcOptions,
) => Partial<ProcResult> | Error | Promise<Partial<ProcResult> | Error>;
/** An enforcing sandbox: the probe's cwd is readable, anything else is a permission denial. */
const enforcing: Sandbox = (file, opts) => (file.startsWith(`${opts.cwd}/`) ? reads(file) : denies(file));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface SandboxRead {
  file: string;
  existed: boolean;
  access: string;
  cwd: string;
  cmd: string[];
  codexHome: string | undefined;
  homeEmpty: boolean;
  /** The production reader profile for the probe's cwd and scratch. */
  built: string[];
}

/**
 * A fake Codex CLI: `--version`, `sandbox` reads answered by `sandbox`, and a completing `exec`.
 * Its private roots are distinct directories standing in for /tmp, the system TMPDIR and home,
 * whatever the host's layout.
 */
function fakeCodex(sandbox: Sandbox = enforcing, options: ReaderProbeOptions = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "probe-roots-")));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const roots = {
    tmp: join(parent, "slash-tmp"),
    TMPDIR: join(parent, "var-folders"),
    home: join(parent, "home"),
  };
  for (const dir of Object.values(roots)) mkdirSync(dir);
  const cli = {
    path: CODEX as string | null,
    version: "codex-cli 0.157.1",
    lookup: null as Partial<ProcResult> | Error | null,
  };
  const calls: string[][] = [];
  const execs: ProcOptions[] = [];
  const sandboxReads: SandboxRead[] = [];
  const runner = async (opts: ProcOptions): Promise<ProcResult> => {
    calls.push(opts.cmd);
    if (opts.cmd[1] === "--version") {
      if (cli.lookup instanceof Error) throw cli.lookup;
      return { ...procResult, stdout: `${cli.version}\n`, ...cli.lookup };
    }
    if (opts.cmd[1] === "sandbox") {
      const file = opts.cmd.at(-1) ?? "";
      const codexHome = opts.env.CODEX_HOME;
      sandboxReads.push({
        file,
        existed: existsSync(file),
        access: codexAccess(opts.cmd, file),
        cwd: opts.cwd,
        cmd: opts.cmd,
        codexHome,
        homeEmpty: !!codexHome && readdirSync(codexHome).length === 0,
        built: profileArgs(
          buildCodexArgs({ ...specFor(opts.cwd, writeGrant(opts.cmd)), confineReads: true }),
        ),
      });
      await Bun.sleep(1);
      const out = await sandbox(file, opts);
      if (out instanceof Error) throw out;
      return { ...procResult, ...out };
    }
    execs.push(opts);
    opts.onStdoutLine?.('{"type":"turn.completed","usage":{}}');
    return procResult;
  };
  const probe = new CodexReaderProbe(() => cli.path, { canaryRoots: () => Object.values(roots), ...options });
  /** Probe attempts that ran to the cwd control, i.e. complete ones. */
  const probes = () => sandboxReads.filter((r) => r.file.startsWith(`${r.cwd}/`)).length;
  return { cli, calls, execs, sandboxReads, roots, runner, probe, probes };
}
const profileArgs = (cmd: string[] = []) =>
  cmd.filter((arg, i) => cmd[i - 1] === "-c" && /permissions/.test(arg));
const writeGrant = (cmd: string[]) =>
  JSON.parse(
    profileArgs(cmd)
      .join("")
      .match(/("(?:[^"\\]|\\.)*")="write"/)?.[1] ?? '""',
  ) as string;

test("an enforcing CLI runs exec only after a readable cwd and a denial in every private root", async () => {
  const { cwd, scratch, spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  try {
    const result = await runCodex(spec, fake.runner, fake.probe);
    expect(result.status).toBe("ok");
    expect(result.confinement).toEqual({
      ok: true,
      path: CODEX,
      version: "codex-cli 0.157.1",
      reason: null,
      exitCode: 0,
    });
    expect(fake.calls.map((cmd) => cmd.slice(0, 2))).toEqual([
      [CODEX, "--version"],
      ...Array(4).fill([CODEX, "sandbox"]),
      [CODEX, "exec"],
    ]);
    const negatives = fake.sandboxReads.slice(0, 3);
    const positive = fake.sandboxReads[3];
    if (!positive) throw new Error("no cwd control");
    for (const root of Object.values(fake.roots))
      expect(negatives.filter((r) => r.file.startsWith(`${root}/`))).toHaveLength(1);
    for (const read of negatives) {
      expect(read.existed).toBe(true);
      expect(read.access).toBe("none");
      expect(read.file.startsWith(`${read.cwd}/`)).toBe(false);
      expect(read.file.startsWith(`${writeGrant(read.cmd)}/`)).toBe(false);
    }
    expect(positive).toMatchObject({ existed: true, access: "read" });
    expect(positive.file.startsWith(`${positive.cwd}/`)).toBe(true);
    // The probe's own cwd and scratch, not the caller's; the profile comes from the production builder.
    expect([positive.cwd, writeGrant(positive.cmd)]).not.toContain(realpathSync(cwd));
    expect(writeGrant(positive.cmd)).not.toBe(realpathSync(scratch));
    for (const read of fake.sandboxReads) {
      expect(profileArgs(read.cmd)).toEqual(read.built);
      expect(read.cmd).not.toContain("--ignore-user-config");
      expect(read.codexHome).toBe(positive.codexHome);
      expect(read.homeEmpty).toBe(true);
    }
    expect(positive.codexHome).not.toBe(process.env.CODEX_HOME);
    expect(positive.codexHome).not.toBe(join(homedir(), ".codex"));
    expect(profileArgs(fake.calls.at(-1))).toEqual(profileArgs(buildCodexArgs(spec)));
    expect(fake.execs[0]?.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    // Probe-owned files are gone; the roots and the caller's files are not.
    for (const read of fake.sandboxReads) expect(existsSync(dirname(read.file))).toBe(false);
    expect(existsSync(positive.codexHome ?? "")).toBe(false);
    expect(existsSync(writeGrant(positive.cmd))).toBe(false);
    for (const root of Object.values(fake.roots)) expect(existsSync(root)).toBe(true);
    expect(readFileSync(join(cwd, "base.txt"), "utf8")).toBe("base\n");
    expect(existsSync(scratch)).toBe(true);
  } finally {
    cleanup();
  }
});

const inRoot = (root: string, file: string) => file.startsWith(`${root}/`);
const deferred = () => Promise.withResolvers<void>();

for (const [name, sandbox, reason] of [
  [
    "codex 0.154.0: denies TMPDIR, allows /tmp and home",
    (f: string) => (f.includes("/var-folders/") ? denies(f) : reads(f)),
    "reader profile not enforced",
  ],
  [
    "readable home canary",
    (f: string, o: ProcOptions) => (f.includes("/home/") ? reads(f) : enforcing(f, o)),
    "reader profile not enforced",
  ],
  [
    "private canary leaked despite a nonzero exit",
    (f: string, o: ProcOptions) => (inRoot(o.cwd, f) ? reads(f) : { ...reads(f), exitCode: 1 }),
    "reader profile not enforced",
  ],
  [
    "clean exit without output on a private canary",
    () => ({ exitCode: 0, stdout: SECRET }),
    "reader profile not enforced",
  ],
  ["denies every read, including the cwd", denies, "probe inconclusive"],
  [
    "ENOENT on an existing canary",
    (f: string, o: ProcOptions) =>
      f.includes("/slash-tmp/")
        ? { exitCode: 1, stderr: `cat: ${f}: No such file or directory ${SECRET}` }
        : enforcing(f, o),
    "probe inconclusive",
  ],
  [
    "ENOENT reported alongside a denial",
    (f: string, o: ProcOptions) =>
      inRoot(o.cwd, f)
        ? reads(f)
        : { exitCode: 1, stderr: `cat: ${f}: Permission denied\ncat: ${f}: No such file or directory` },
    "probe inconclusive",
  ],
  [
    "another path denied",
    (f: string, o: ProcOptions) => (inRoot(o.cwd, f) ? reads(f) : denies("/x")),
    "probe inconclusive",
  ],
  [
    "unrelated error",
    () => ({ exitCode: 2, stderr: `error: unexpected argument '-c' ${SECRET}` }),
    "probe inconclusive",
  ],
  [
    "malformed output",
    () => ({ exitCode: 1, stdout: `\u0000{${SECRET}`, stderr: "garbage" }),
    "probe inconclusive",
  ],
  [
    "signalled denial",
    (f: string) => ({ exitCode: null, signal: "SIGKILL", stderr: denies(f).stderr }),
    "probe inconclusive",
  ],
  [
    "cwd control missing",
    (f: string, o: ProcOptions) =>
      inRoot(o.cwd, f) ? { exitCode: 1, stderr: `cat: ${f}: No such file or directory` } : denies(f),
    "probe inconclusive",
  ],
  [
    "cwd control returns other contents",
    (f: string, o: ProcOptions) =>
      inRoot(o.cwd, f) ? { exitCode: 0, stdout: `canary-other ${SECRET}` } : denies(f),
    "probe inconclusive",
  ],
  [
    "timeout",
    (f: string) => ({ exitCode: null, timedOut: true, stderr: denies(f).stderr }),
    "probe timed out",
  ],
  [
    "idle timeout",
    (f: string) => ({ exitCode: 1, idleTimedOut: true, stderr: denies(f).stderr }),
    "probe timed out",
  ],
  ["sandbox startup", () => new Error(`spawn EACCES ${SECRET}`), "codex sandbox failed to start"],
] as const)
  test(`confined codex exec never starts when the probe fails: ${name}`, async () => {
    const { spec, cleanup } = confinedFixture();
    const fake = fakeCodex(sandbox as Sandbox);
    try {
      const result = await runCodex(spec, fake.runner, fake.probe);
      expect(result.status).toBe("unavailable");
      expect(result.confinement).toMatchObject({
        ok: false,
        path: CODEX,
        version: "codex-cli 0.157.1",
        reason,
      });
      expect(result.error).toContain(reason);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain("canary-");
      expect(fake.execs).toHaveLength(0);
      for (const read of fake.sandboxReads) {
        expect(read.existed).toBe(true);
        expect(existsSync(dirname(read.file))).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

test("a canary that cannot be created makes the probe inconclusive and removes the others", async () => {
  const { spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  const missing = join(fake.roots.home, "missing");
  const probe = new CodexReaderProbe(() => CODEX, { canaryRoots: () => [fake.roots.tmp, missing] });
  try {
    const result = await runCodex(spec, fake.runner, probe);
    expect(result.confinement).toMatchObject({ ok: false, reason: "probe inconclusive", exitCode: null });
    expect(fake.sandboxReads).toHaveLength(0);
    expect(fake.execs).toHaveLength(0);
    expect(readdirSync(fake.roots.tmp)).toEqual([]);
    const empty = new CodexReaderProbe(() => CODEX, { canaryRoots: () => [] });
    expect((await runCodex(spec, fake.runner, empty)).confinement?.reason).toBe("probe inconclusive");
    expect(fake.sandboxReads).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("a missing CLI fails closed without output", async () => {
  const { spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  fake.cli.path = null;
  try {
    const result = await runCodex(spec, fake.runner, fake.probe);
    expect(result.status).toBe("unavailable");
    expect(result.confinement).toEqual({
      ok: false,
      path: null,
      version: null,
      reason: "codex sandbox failed to start",
      exitCode: null,
    });
    expect(fake.calls).toHaveLength(0);
  } finally {
    cleanup();
  }
});

for (const [name, lookup, reason, exitCode] of [
  ["nonzero exit", { exitCode: 1, stdout: "codex-cli 0.157.1\n" }, "probe inconclusive", 1],
  ["startup error", new Error(`spawn ENOENT ${SECRET}`), "codex sandbox failed to start", null],
  ["malformed output", { stdout: `codex-cli 0.157.1 ${SECRET}\n` }, "probe inconclusive", 0],
  ["unrelated output", { stdout: `${SECRET}\n` }, "probe inconclusive", 0],
  ["timeout with plausible output", { exitCode: 0, timedOut: true }, "probe timed out", 0],
  ["signal with plausible output", { exitCode: null, signal: "SIGTERM" }, "probe inconclusive", null],
] as const)
  test(`an unknown version fails closed and never reuses a cached verdict: ${name}`, async () => {
    const { spec, cleanup } = confinedFixture();
    const fake = fakeCodex();
    try {
      expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
      const before = fake.calls.length;
      fake.cli.lookup = lookup;
      const result = await runCodex(spec, fake.runner, fake.probe);
      expect(result.status).toBe("unavailable");
      expect(result.confinement).toEqual({ ok: false, path: CODEX, version: null, reason, exitCode });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(fake.calls.slice(before).map((cmd) => cmd[1])).toEqual(["--version"]);
      fake.cli.lookup = null;
      expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
      expect(fake.probes()).toBe(1);
      expect(fake.execs).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

test("definitive verdicts are cached per CLI path and version, shared by concurrent callers", async () => {
  const { spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  const old = fakeCodex((f) => (f.includes("/var-folders/") ? denies(f) : reads(f)));
  try {
    await Promise.all([0, 1, 2].map(() => runCodex(spec, fake.runner, fake.probe)));
    expect(fake.probes()).toBe(1);
    expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
    expect(fake.probes()).toBe(1);
    fake.cli.version = "codex-cli 0.158.0";
    await runCodex(spec, fake.runner, fake.probe);
    expect(fake.probes()).toBe(2);
    fake.cli.path = "/usr/local/bin/codex";
    await runCodex(spec, fake.runner, fake.probe);
    expect(fake.probes()).toBe(3);
    expect(fake.execs).toHaveLength(6);

    const results = await Promise.all([0, 1, 2].map(() => runCodex(spec, old.runner, old.probe)));
    results.push(await runCodex(spec, old.runner, old.probe));
    for (const result of results) expect(result.confinement?.reason).toBe("reader profile not enforced");
    const attempts = old.sandboxReads.length;
    expect(attempts).toBeGreaterThan(0);
    expect(new Set(old.sandboxReads.map((r) => r.cwd)).size).toBe(1);
    expect(old.execs).toHaveLength(0);
    old.cli.version = "codex-cli 0.154.1";
    await runCodex(spec, old.runner, old.probe);
    expect(new Set(old.sandboxReads.map((r) => r.cwd)).size).toBe(2);
    old.cli.path = "/usr/local/bin/codex";
    await runCodex(spec, old.runner, old.probe);
    expect(new Set(old.sandboxReads.map((r) => r.cwd)).size).toBe(3);
    expect(old.execs).toHaveLength(0);
  } finally {
    cleanup();
  }
});

for (const [name, first] of [
  ["timeout", (f: string) => ({ exitCode: null, timedOut: true, stderr: denies(f).stderr })],
  ["startup error", () => new Error("spawn EAGAIN")],
  ["inconclusive", () => ({ exitCode: 1, stderr: "sandbox: unexpected failure" })],
] as const)
  test(`a ${name} probe fails closed, is not cached, and is retried after the backoff`, async () => {
    const { spec, cleanup } = confinedFixture();
    let now = 1_000;
    const sleeps: number[] = [];
    let failing = true;
    const fake = fakeCodex(
      (f, o) => (failing ? (first as (f: string) => Partial<ProcResult> | Error)(f) : enforcing(f, o)),
      {
        backoffMs: 250,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );
    try {
      const failed = await runCodex(spec, fake.runner, fake.probe);
      expect(failed.status).toBe("unavailable");
      expect(fake.execs).toHaveLength(0);
      const attempts = fake.sandboxReads.length;
      expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("unavailable");
      expect(sleeps).toEqual([250]);
      expect(fake.sandboxReads.length).toBeGreaterThan(attempts);
      failing = false;
      now += 100;
      expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
      expect(sleeps).toEqual([250, 150]);
      expect(fake.execs).toHaveLength(1);
      expect(fake.probes()).toBe(1);
      expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
      expect(sleeps).toHaveLength(2);
      expect(fake.probes()).toBe(1);
    } finally {
      cleanup();
    }
  });

/** Sandbox reads wait for `gate`; an aborted read ends as a cancelled process. */
function gatedSandbox(gate: Promise<void>, signals: (AbortSignal | undefined)[]): Sandbox {
  return async (file, opts) => {
    signals.push(opts.signal);
    const aborted = new Promise<"aborted">((resolve) => {
      if (opts.signal?.aborted) resolve("aborted");
      opts.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    if ((await Promise.race([gate.then(() => "open" as const), aborted])) === "aborted")
      return { exitCode: null, signal: "SIGTERM", cancelled: true };
    return enforcing(file, opts);
  };
}

test("a cancelled waiter settles at once while the probe it joined completes for others", async () => {
  const { spec, cleanup } = confinedFixture();
  const gate = deferred();
  const signals: (AbortSignal | undefined)[] = [];
  const fake = fakeCodex(gatedSandbox(gate.promise, signals));
  const abort = new AbortController();
  try {
    const live = runCodex(spec, fake.runner, fake.probe);
    while (!fake.sandboxReads.length) await Bun.sleep(1);
    const cancelled = runCodex({ ...spec, signal: abort.signal }, fake.runner, fake.probe);
    await Bun.sleep(5);
    abort.abort();
    expect((await cancelled).status).toBe("cancelled");
    expect(fake.sandboxReads).toHaveLength(1);
    gate.resolve();
    expect((await live).status).toBe("ok");
    expect(fake.execs).toHaveLength(1);
    expect(signals.every((s) => s !== abort.signal && !s?.aborted)).toBe(true);
  } finally {
    gate.resolve();
    cleanup();
  }
});

test("cancelling the caller that started a probe leaves it running for a live waiter", async () => {
  const { spec, cleanup } = confinedFixture();
  const gate = deferred();
  const signals: (AbortSignal | undefined)[] = [];
  const fake = fakeCodex(gatedSandbox(gate.promise, signals));
  const abort = new AbortController();
  try {
    const initiator = runCodex({ ...spec, signal: abort.signal }, fake.runner, fake.probe);
    while (!fake.sandboxReads.length) await Bun.sleep(1);
    const live = runCodex(spec, fake.runner, fake.probe);
    await Bun.sleep(5);
    abort.abort();
    const settled = await initiator;
    expect(settled.status).toBe("cancelled");
    expect(settled.confinement).toBeUndefined();
    gate.resolve();
    expect((await live).status).toBe("ok");
    expect(fake.probes()).toBe(1);
    expect(fake.execs).toHaveLength(1);
  } finally {
    gate.resolve();
    cleanup();
  }
});

test("cancelling the only caller stops its probe, never starts exec, and is not cached", async () => {
  const { spec, cleanup } = confinedFixture();
  const gate = deferred();
  const signals: (AbortSignal | undefined)[] = [];
  const fake = fakeCodex(gatedSandbox(gate.promise, signals));
  const abort = new AbortController();
  try {
    const pending = runCodex({ ...spec, signal: abort.signal }, fake.runner, fake.probe);
    while (!fake.sandboxReads.length) await Bun.sleep(1);
    abort.abort();
    expect((await pending).status).toBe("cancelled");
    await Bun.sleep(5);
    expect(signals[0]?.aborted).toBe(true);
    expect(fake.execs).toHaveLength(0);
    for (const read of fake.sandboxReads) expect(existsSync(dirname(read.file))).toBe(false);
    gate.resolve();
    expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
    expect(fake.probes()).toBe(1);
  } finally {
    gate.resolve();
    cleanup();
  }
});

test("cancelling during the backoff returns promptly and is not cached", async () => {
  const { spec, cleanup } = confinedFixture();
  let now = 0;
  let failing = true;
  const fake = fakeCodex((f, o) => (failing ? { exitCode: 1, stderr: "?" } : enforcing(f, o)), {
    backoffMs: 60_000,
    now: () => now,
  });
  const abort = new AbortController();
  try {
    expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("unavailable");
    const attempts = fake.sandboxReads.length;
    const started = Date.now();
    const waiting = runCodex({ ...spec, signal: abort.signal }, fake.runner, fake.probe);
    await Bun.sleep(5);
    abort.abort();
    expect((await waiting).status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fake.sandboxReads).toHaveLength(attempts);
    failing = false;
    now = 60_000;
    expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
    expect(fake.execs).toHaveLength(1);
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
