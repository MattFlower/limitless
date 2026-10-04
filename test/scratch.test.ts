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
import { basename, dirname, join, resolve } from "node:path";
import { buildClaudeArgs, runClaude } from "../src/harness/claude.ts";
import {
  buildCodexArgs,
  type CanaryClasses,
  CodexReaderProbe,
  canaryRoots,
  type ReaderProbeOptions,
  runCodex,
} from "../src/harness/codex.ts";
import {
  createScratch,
  privateReadRoots,
  removeScratch,
  SCRATCH_NAME,
  scratchEnv,
  withScratch,
  writeRoots,
} from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { withholdText } from "../src/pipeline/context.ts";
import type { ProcOptions, ProcResult, runProcess } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";

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
  if (seatbeltSkip) return seatbeltSkip;
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
 * Its private roots are distinct directories standing in for /tmp, the system TMPDIR, home and
 * /var/tmp, whatever the host's layout; `nestedTmpdir` puts TMPDIR under /tmp, as `TMPDIR=/tmp/x`
 * does, and hands the roots to the production selector.
 */
function fakeCodex(sandbox: Sandbox = enforcing, options: ReaderProbeOptions = {}, nestedTmpdir = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "probe-roots-")));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const roots = {
    tmp: join(parent, "slash-tmp"),
    TMPDIR: join(parent, nestedTmpdir ? "slash-tmp/var-folders" : "var-folders"),
    home: join(parent, "home"),
    varTmp: join(parent, "var-tmp"),
  };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  const classes: CanaryClasses = { tmp: roots.tmp, tmpdir: roots.TMPDIR, home: roots.home };
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
  const probe = new CodexReaderProbe(() => cli.path, {
    canaryRoots: () => (nestedTmpdir ? canaryRoots(Object.values(roots), classes) : Object.values(roots)),
    ...options,
  });
  /** Probe attempts that ran to the cwd control, i.e. complete ones. */
  const probes = () => sandboxReads.filter((r) => r.file.startsWith(`${r.cwd}/`)).length;
  return { cli, calls, execs, sandboxReads, roots, classes, runner, probe, probes };
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
      ...Array(5).fill([CODEX, "sandbox"]),
      [CODEX, "exec"],
    ]);
    const negatives = fake.sandboxReads.slice(0, 4);
    const positive = fake.sandboxReads[4];
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
    "codex 0.154.0: denies home and TMPDIR, allows /tmp",
    (f: string, o: ProcOptions) => (f.includes("/slash-tmp/") ? reads(f) : enforcing(f, o)),
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
    "enforces /tmp, TMPDIR and home but allows /var/tmp",
    (f: string, o: ProcOptions) => (f.includes("/var-tmp/") ? reads(f) : enforcing(f, o)),
    "reader profile not enforced",
  ],
  [
    "clean exit without output on a private canary",
    () => ({ exitCode: 0, stdout: SECRET }),
    "probe inconclusive",
  ],
  [
    "denial of a suffixed filename",
    (f: string, o: ProcOptions) => (inRoot(o.cwd, f) ? reads(f) : denies(`${f}.backup`)),
    "probe inconclusive",
  ],
  [
    "denial of a prefixed filename",
    (f: string, o: ProcOptions) => (inRoot(o.cwd, f) ? reads(f) : denies(`/x${f}`)),
    "probe inconclusive",
  ],
  [
    "denial naming a directory that contains the canary",
    (f: string, o: ProcOptions) => (inRoot(o.cwd, f) ? reads(f) : denies(`/unrelated directory ${f}`)),
    "probe inconclusive",
  ],
  [
    "denial of a differently cased canary",
    (f: string, o: ProcOptions) =>
      inRoot(o.cwd, f) ? reads(f) : denies(f.replace(/canary\.txt$/, "CANARY.TXT")),
    "probe inconclusive",
  ],
  [
    "unrelated permission error on the canary's line",
    (f: string, o: ProcOptions) =>
      inRoot(o.cwd, f)
        ? reads(f)
        : { exitCode: 1, stderr: `cat: ${f}: Is a directory (/etc/x: Permission denied)` },
    "probe inconclusive",
  ],
  ["timed out after leaking a canary", (f: string) => ({ ...reads(f), timedOut: true }), "probe timed out"],
  [
    "signalled after leaking a canary",
    (f: string) => ({ ...reads(f), exitCode: null, signal: "SIGKILL" }),
    "probe inconclusive",
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

test("codex 0.154.0 is unsafe because /tmp leaks, even with home and TMPDIR denied", async () => {
  const { spec, cleanup } = confinedFixture();
  const fake = fakeCodex((f, o) => (inRoot(fake.roots.tmp, f) ? reads(f) : enforcing(f, o)), {
    canaryRoots: () => [fake.roots.TMPDIR, fake.roots.home, fake.roots.tmp],
  });
  try {
    const result = await runCodex(spec, fake.runner, fake.probe);
    expect(result.confinement).toMatchObject({ ok: false, reason: "reader profile not enforced" });
    const order = fake.sandboxReads.map((r) => [inRoot(fake.roots.tmp, r.file), r.access]);
    // TMPDIR and home were denied first; the verdict rests on the /tmp canary alone.
    expect(order).toEqual([
      [false, "none"],
      [false, "none"],
      [true, "none"],
    ]);
    expect(fake.execs).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("a probe cleanup error fails the call closed promptly and the next call probes again", async () => {
  const { spec, cleanup } = confinedFixture();
  let failing = true;
  const fake = fakeCodex(enforcing, {
    backoffMs: 0,
    remove: (dir) => {
      rmSync(dir, { recursive: true, force: true });
      if (failing) throw Object.assign(new Error(`EBUSY ${SECRET}`), { code: "EBUSY" });
    },
  });
  try {
    const first = await runCodex(spec, fake.runner, fake.probe);
    expect(first.status).toBe("unavailable");
    expect(first.confinement).toMatchObject({ ok: false, reason: "probe inconclusive" });
    expect(fake.execs).toHaveLength(0);
    failing = false;
    expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
    expect(fake.probes()).toBe(2);
  } finally {
    cleanup();
  }
});

test("the probe's scratch and denyRead match the real reader's", async () => {
  const { spec, cleanup } = confinedFixture();
  const extra = realpathSync(mkdtempSync(join(tmpdir(), "limitless-deny-test-")));
  cleanups.push(() => rmSync(extra, { recursive: true, force: true }));
  const fake = fakeCodex();
  let deny: string[] = [];
  const probe = new CodexReaderProbe(() => CODEX, {
    canaryRoots: (d) => {
      deny = d;
      return Object.values(fake.roots);
    },
  });
  try {
    expect((await runCodex({ ...spec, denyRead: [extra] }, fake.runner, probe)).status).toBe("ok");
    expect(deny).toContain(extra);
    for (const read of fake.sandboxReads) {
      expect(codexAccess(read.cmd, join(extra, "x"))).toBe("none");
      const scratch = writeGrant(read.cmd);
      expect(basename(scratch)).toBe(SCRATCH_NAME);
      expect(basename(dirname(scratch))).toStartWith("lr-");
    }
  } finally {
    cleanup();
  }
});

test("a verdict for one denyRead list is not reused for a caller denying more", async () => {
  const { spec, cleanup } = confinedFixture();
  const extra = realpathSync(mkdtempSync(join(tmpdir(), "limitless-deny-test-")));
  cleanups.push(() => rmSync(extra, { recursive: true, force: true }));
  // Enforces the standard roots but leaves the second caller's extra denied path readable.
  const fake = fakeCodex((f, o) => (inRoot(extra, f) ? reads(f) : enforcing(f, o)), {
    canaryRoots: (deny) => [...Object.values(fake.roots), ...(deny.includes(extra) ? [extra] : [])],
  });
  try {
    expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
    const second = await runCodex({ ...spec, denyRead: [extra] }, fake.runner, fake.probe);
    expect(second.confinement).toMatchObject({ ok: false, reason: "reader profile not enforced" });
    expect(fake.sandboxReads.filter((r) => inRoot(extra, r.file))).toHaveLength(1);
    expect(fake.execs).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("a retargeted denyRead symlink is probed again instead of reusing the old verdict", async () => {
  const { spec, cleanup } = confinedFixture();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "limitless-deny-test-")));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const [a, b, link] = [join(parent, "a"), join(parent, "b"), join(parent, "link")];
  for (const dir of [a, b]) mkdirSync(dir);
  symlinkSync(a, link);
  // Enforces everything except the second target, which stays readable.
  const fake = fakeCodex((f, o) => (inRoot(b, f) ? reads(f) : enforcing(f, o)), {
    canaryRoots: (deny) => [...Object.values(fake.roots), ...deny.filter((d) => d === a || d === b)],
  });
  try {
    const confined = { ...spec, denyRead: [link] };
    expect((await runCodex(confined, fake.runner, fake.probe)).status).toBe("ok");
    expect(fake.sandboxReads.filter((r) => inRoot(a, r.file))).toHaveLength(1);
    rmSync(link);
    symlinkSync(b, link);
    const second = await runCodex(confined, fake.runner, fake.probe);
    expect(second.confinement).toMatchObject({ ok: false, reason: "reader profile not enforced" });
    expect(fake.sandboxReads.filter((r) => inRoot(b, r.file))).toHaveLength(1);
    expect(fake.execs).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("a denyRead symlink retargeted during the version lookup fails closed instead of reusing a verdict", async () => {
  const { spec, cleanup } = confinedFixture();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "limitless-deny-test-")));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const [a, b, link] = [join(parent, "a"), join(parent, "b"), join(parent, "link")];
  for (const dir of [a, b]) mkdirSync(dir);
  const retarget = (target: string) => {
    rmSync(link);
    symlinkSync(target, link);
  };
  symlinkSync(b, link);
  const fake = fakeCodex(enforcing, {
    canaryRoots: (deny) => [...Object.values(fake.roots), ...deny.filter((d) => d === a || d === b)],
  });
  let duringLookup: string | null = null;
  const runner = async (opts: ProcOptions) => {
    if (opts.cmd[1] === "--version" && duringLookup) retarget(duringLookup);
    return fake.runner(opts);
  };
  try {
    const confined = { ...spec, denyRead: [link] };
    expect((await runCodex(confined, runner, fake.probe)).status).toBe("ok");
    // The profile is built for A, but by the time the verdict is looked up the link is back on B.
    retarget(a);
    duringLookup = b;
    const second = await runCodex(confined, runner, fake.probe);
    expect(second.status).toBe("unavailable");
    expect(second.error).toContain("denied paths changed");
    expect(second.confinement).toMatchObject({ ok: false, reason: "probe inconclusive" });
    expect(fake.execs).toHaveLength(1);
    // A was probed on its own, never taken for the cached B verdict.
    expect(fake.sandboxReads.filter((r) => inRoot(a, r.file))).toHaveLength(1);
    expect(fake.probes()).toBe(2);
  } finally {
    cleanup();
  }
});

test("a verdict for one CLI is not reused for another that denies the first's path", async () => {
  const { spec, cleanup } = confinedFixture();
  const [a, b] = ["/opt/codex-a/bin/codex", "/opt/codex-b/bin/codex"];
  const fake = fakeCodex();
  try {
    fake.cli.path = a;
    expect((await runCodex({ ...spec, denyRead: [b] }, fake.runner, fake.probe)).status).toBe("ok");
    fake.cli.path = b;
    const second = await runCodex({ ...spec, denyRead: [a] }, fake.runner, fake.probe);
    expect(second.status).toBe("ok");
    expect(second.confinement?.path).toBe(b);
    expect(fake.probes()).toBe(2);
    expect(fake.sandboxReads.map((r) => r.cmd[0])).toContain(b);
  } finally {
    cleanup();
  }
});

test("canaries cover each distinct writable private root the production profile denies", async () => {
  try {
    const roots = canaryRoots(privateReadRoots());
    for (const root of ["/tmp", "/var/tmp", tmpdir()])
      if (existsSync(root)) expect(roots).toContain(realpathSync(root));
    const home = realpathSync(homedir());
    expect(roots.filter((root) => root === home || root === join(home, ".limitless"))).toHaveLength(1);
    expect(new Set(roots).size).toBe(roots.length);
  } catch (error) {
    // A confined gate cannot plant a real-HOME or /tmp canary. The fixture matrix below still runs.
    if (process.env.LIMITLESS_CONFINED !== "1") throw error;
    expect((error as Error).message).toBe("mandatory private root has no writable canary location");
  }

  const parent = realpathSync(mkdtempSync(join(tmpdir(), "canary-roots-")));
  cleanups.push(() => {
    for (const dir of ["locked", "home"]) chmodSync(join(parent, dir), 0o755);
    rmSync(parent, { recursive: true, force: true });
  });
  for (const dir of ["outer/inner", "locked", "other", "home/.limitless"])
    mkdirSync(join(parent, dir), { recursive: true });
  symlinkSync(join(parent, "outer/inner"), join(parent, "alias"));
  chmodSync(join(parent, "locked"), 0o555);
  const at = (...dirs: string[]) => dirs.map((d) => join(parent, d));
  const deny = at("outer", "outer/inner", "alias", "locked", "missing", "other", "home");
  const classes = { tmp: join(parent, "outer"), tmpdir: join(parent, "alias"), home: join(parent, "home") };
  // Aliases merge; a root nested in another is a distinct class and keeps its own canary; an optional
  // root we cannot write to is skipped, and home's canary goes in the factory directory.
  expect(canaryRoots(deny, classes)).toEqual(at("outer", "outer/inner", "other", "home/.limitless"));
  rmSync(join(parent, "home/.limitless"), { recursive: true });
  expect(canaryRoots(deny, classes)).toEqual(at("outer", "outer/inner", "other", "home"));
  // A mandatory class with no writable location, or one the profile does not deny, is never dropped.
  chmodSync(join(parent, "home"), 0o555);
  expect(() => canaryRoots(deny, classes)).toThrow();
  expect(() => canaryRoots(deny, { ...classes, home: join(parent, "other") })).not.toThrow();
  expect(() =>
    canaryRoots(deny, { ...classes, tmp: join(parent, "locked"), home: join(parent, "other") }),
  ).toThrow();
  expect(() =>
    canaryRoots(
      deny.filter((d) => d !== join(parent, "outer")),
      classes,
    ),
  ).toThrow();
  expect(() => canaryRoots(deny)).toThrow();

  // The probe derives its canaries from the same deny list the real invocation gets.
  const { spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  const seen: string[][] = [];
  const probe = new CodexReaderProbe(() => CODEX, {
    canaryRoots: (d) => {
      seen.push(d);
      return Object.values(fake.roots);
    },
  });
  try {
    expect((await runCodex(spec, fake.runner, probe)).status).toBe("ok");
    expect(seen).toEqual([privateReadRoots()]);
  } finally {
    cleanup();
  }
});

test("a TMPDIR nested under /tmp keeps a /tmp canary outside it", async () => {
  const { spec, cleanup } = confinedFixture();
  // Denies TMPDIR, home and /var/tmp, but allows the rest of /tmp, where other readers' scratch lives.
  const partial = fakeCodex(
    (f, o) => (f.includes("/slash-tmp/") && !f.includes("/var-folders/") ? reads(f) : enforcing(f, o)),
    {},
    true,
  );
  const full = fakeCodex(enforcing, {}, true);
  try {
    expect(canaryRoots(Object.values(partial.roots), partial.classes)).toEqual(Object.values(partial.roots));
    const result = await runCodex(spec, partial.runner, partial.probe);
    expect(result.confinement).toMatchObject({ ok: false, reason: "reader profile not enforced" });
    expect(partial.execs).toHaveLength(0);
    const outer = partial.sandboxReads.filter(
      (r) => inRoot(partial.roots.tmp, r.file) && !inRoot(partial.roots.TMPDIR, r.file),
    );
    expect(outer).toHaveLength(1);

    expect((await runCodex(spec, full.runner, full.probe)).status).toBe("ok");
    expect(full.sandboxReads).toHaveLength(5);
    for (const root of Object.values(full.roots))
      expect(full.sandboxReads.filter((r) => dirname(dirname(r.file)) === root)).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("a read-only home is still probed through its factory directory, or not trusted at all", async () => {
  const { spec, cleanup } = confinedFixture();
  const fake = fakeCodex();
  const factory = join(fake.roots.home, ".limitless");
  mkdirSync(factory);
  cleanups.unshift(() => {
    for (const dir of [fake.roots.home, factory]) chmodSync(dir, 0o755);
  });
  chmodSync(fake.roots.home, 0o555);
  const selector = () => canaryRoots(Object.values(fake.roots), fake.classes);
  try {
    const probe = new CodexReaderProbe(() => CODEX, { canaryRoots: selector });
    expect((await runCodex(spec, fake.runner, probe)).status).toBe("ok");
    const home = fake.sandboxReads.filter((r) => inRoot(fake.roots.home, r.file));
    expect(home.map((r) => inRoot(factory, r.file))).toEqual([true]);
    expect(home[0]?.access).toBe("none");
    expect(readdirSync(factory)).toEqual([]);

    // Nowhere writable in home: the probe is inconclusive rather than narrower, and exec never starts.
    chmodSync(factory, 0o555);
    fake.sandboxReads.length = 0;
    const result = await runCodex(
      spec,
      fake.runner,
      new CodexReaderProbe(() => CODEX, { canaryRoots: selector }),
    );
    expect(result.confinement).toMatchObject({ ok: false, reason: "probe inconclusive", exitCode: null });
    expect(fake.sandboxReads).toHaveLength(0);
    expect(fake.execs).toHaveLength(1);
  } finally {
    cleanup();
  }
});

for (const destination of ["tmp", "home-sibling"] as const) {
  for (const writableHome of [true, false]) {
    test(`a factory symlink to ${destination} cannot replace coverage of ${writableHome ? "writable" : "read-only"} home`, async () => {
      const { spec, cleanup } = confinedFixture();
      // This CLI denies temporary roots but leaks home; testing the symlink target would trust it.
      const fake = fakeCodex((file, opts) => (file.includes("/home/") ? reads(file) : enforcing(file, opts)));
      const destinationRoot = destination === "tmp" ? fake.roots.tmp : `${fake.roots.home}-sibling`;
      mkdirSync(destinationRoot, { recursive: true });
      const sentinel = join(destinationRoot, "existing.txt");
      writeFileSync(sentinel, "caller-owned");
      const factory = join(fake.roots.home, ".limitless");
      symlinkSync(destinationRoot, factory);
      cleanups.unshift(() => chmodSync(fake.roots.home, 0o755));
      if (!writableHome) chmodSync(fake.roots.home, 0o555);
      const probe = new CodexReaderProbe(() => CODEX, {
        canaryRoots: () => canaryRoots(Object.values(fake.roots), fake.classes),
      });
      try {
        const result = await runCodex(spec, fake.runner, probe);
        expect(result.status).toBe("unavailable");
        expect(result.confinement).toMatchObject({
          ok: false,
          reason: writableHome ? "reader profile not enforced" : "probe inconclusive",
        });
        expect(fake.execs).toHaveLength(0);
        if (writableHome) {
          const homeReads = fake.sandboxReads.filter((read) => inRoot(fake.roots.home, read.file));
          expect(homeReads).toHaveLength(1);
          expect(homeReads[0]).toMatchObject({ existed: true, access: "none" });
          expect(dirname(dirname(homeReads[0]?.file ?? ""))).toBe(fake.roots.home);
        } else {
          expect(fake.sandboxReads).toHaveLength(0);
        }
        for (const read of fake.sandboxReads) expect(existsSync(dirname(read.file))).toBe(false);
        expect(realpathSync(factory)).toBe(destinationRoot);
        expect(readFileSync(sentinel, "utf8")).toBe("caller-owned");
        expect(readdirSync(destinationRoot)).toEqual(["existing.txt"]);
      } finally {
        cleanup();
      }
    });
  }
}

for (const [name, shape] of [
  ["cat", (f: string) => `cat: ${f}: Permission denied`],
  ["full program path and quotes", (f: string) => `/bin/cat: '${f}': Operation not permitted`],
  ["errno with a trailing note", (f: string) => `${f}: EACCES (os error 13)`],
] as const)
  test(`a denial diagnostic naming the canary exactly counts: ${name}`, async () => {
    const { spec, cleanup } = confinedFixture();
    const fake = fakeCodex((f, o) =>
      inRoot(o.cwd, f) ? reads(f) : { exitCode: 1, stderr: `${shape(f)}\n` },
    );
    try {
      expect((await runCodex(spec, fake.runner, fake.probe)).status).toBe("ok");
      expect(fake.execs).toHaveLength(1);
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
  ["clean exit without canary contents", () => ({ exitCode: 0, stdout: "" })],
  ["leaking timeout", (f: string) => ({ ...reads(f), timedOut: true })],
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

/** A linked worktree of an owned repository, with a sibling, and a scratch for the first. */
function editFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "edit-roots-")));
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  };
  const cache = join(root, "cache");
  git("init", "-q", cache);
  git("-C", cache, "commit", "-q", "--allow-empty", "-m", "base");
  const cwd = join(root, "work");
  git("-C", cache, "worktree", "add", "-q", "--detach", cwd);
  git("-C", cache, "worktree", "add", "-q", "--detach", join(root, "sibling"));
  const scratchDir = createScratch(cwd);
  const spec: AgentSpec = { ...specFor(cwd, scratchDir), mode: "edit", logPath: join(root, "log") };
  cleanups.push(() => {
    removeScratch(scratchDir);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    cache,
    cwd,
    scratchDir,
    spec,
    common: join(cache, ".git"),
    admin: join(cache, ".git/worktrees/work"),
  };
}

test("write roots are the worktree and scratch; admin and common stay read-only", () => {
  const { root, cwd, scratchDir, common, admin } = editFixture();
  const roots = writeRoots(cwd, scratchDir);
  expect(roots.write.sort()).toEqual([cwd, realpathSync(scratchDir)].sort());
  expect(roots.protect).toEqual([join(cwd, ".git"), admin]);
  expect(roots.write).not.toContain(common);
  // A symlinked spelling is granted alongside the canonical path, never its parent.
  symlinkSync(cwd, join(root, "alias"));
  const aliased = writeRoots(join(root, "alias"), scratchDir);
  expect(aliased.write).toContain(join(root, "alias"));
  expect(aliased.write).toContain(cwd);
  expect(aliased.write).not.toContain(root);
  // A .git redirected at another worktree's or the shared directory is refused.
  for (const target of [join(common, "worktrees/sibling"), common, join(root, "sibling")]) {
    writeFileSync(join(cwd, ".git"), `gitdir: ${target}\n`);
    expect(() => writeRoots(cwd, scratchDir)).toThrow("own linked worktree directory");
  }
  rmSync(join(cwd, ".git"));
  symlinkSync(admin, join(cwd, ".git"));
  expect(() => writeRoots(cwd, scratchDir)).toThrow("file or directory");
});

const codexFilesystem = (args: string[]) =>
  Object.fromEntries(
    [
      ...(profileArgs(args)
        .join("")
        .match(/("(?:[^"\\]|\\.)*")="(\w+)"/g) ?? []),
    ].map((entry) => {
      const [, path = "", access = ""] = entry.match(/^("(?:[^"\\]|\\.)*")="(\w+)"$/) ?? [];
      return [JSON.parse(path) as string, access];
    }),
  );

test("codex editors get an explicit write profile, fresh or resumed, and nothing more", () => {
  const { cwd, scratchDir, spec, common, admin } = editFixture();
  for (const resume of [undefined, "thread-1"]) {
    const args = buildCodexArgs({ ...spec, ...(resume ? { resumeSessionId: resume } : {}) });
    expect(codexFilesystem(args)).toEqual({
      "/": "read",
      [cwd]: "write",
      [admin]: "read",
      [realpathSync(scratchDir)]: "write",
      [join(cwd, ".git")]: "read",
    });
    expect(profileArgs(args).join("")).toContain("network={enabled=true}");
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--strict-config"])
      expect(args).toContain(flag);
    expect(args).not.toContain("workspace-write");
    expect(args).not.toContain("--add-dir");
    expect(JSON.stringify(args)).not.toContain(`"${common}"`);
    if (resume) expect(args.slice(-3)).toEqual(["resume", resume, "-"]);
  }
  expect(() => buildCodexArgs({ ...spec, addDirs: [common] })).toThrow("cannot grant additional directories");
  expect(() => buildCodexArgs({ ...spec, scratchDir: undefined })).toThrow("requires a scratch");
});

test("claude editors confine Bash and native edits to the same roots; project settings cannot widen them", () => {
  const { cwd, scratchDir, spec, admin } = editFixture();
  // Project settings an agent could commit: exclusions, hooks and broad permissions.
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(
    join(cwd, ".claude/settings.json"),
    JSON.stringify({
      sandbox: { excludedCommands: ["sh"], allowUnsandboxedCommands: true },
      permissions: { allow: ["Edit(//**)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/pwned" }] }] },
    }),
  );
  for (const variant of [{}, { fast: true }]) {
    const t = { ...spec.target, provider: "claude" };
    const args = buildClaudeArgs({ ...spec, ...variant, target: t }, "session");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    // The config directory is read-only inside the boundary: no transcript is written there.
    expect(args).toContain("--no-session-persistence");
    expect(args.slice(-2)).toEqual(["--session-id", "session"]);
    const settings = args.flatMap((a, i) => (args[i - 1] === "--settings" ? [JSON.parse(a)] : []));
    expect(settings).toHaveLength(1);
    const { sandbox, disableAllHooks, fastMode } = settings[0];
    expect(fastMode).toBe("fast" in variant ? true : undefined);
    expect(disableAllHooks).toBe(true);
    expect(sandbox).toMatchObject({
      enabled: false,
      failIfUnavailable: true,
      allowUnsandboxedCommands: true,
      excludedCommands: [],
      filesystem: { denyWrite: [join(cwd, ".git"), admin], disabled: false },
    });
    expect(sandbox.filesystem.allowWrite.sort()).toEqual([cwd, realpathSync(scratchDir)].sort());
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    for (const bare of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(allowed).not.toContain(bare);
    expect(allowed).toContain(`Edit(/${cwd}/**)`);
    expect(allowed.filter((a) => a.startsWith("Edit("))).toHaveLength(2);
    expect(args).toContain(`Edit(/${join(cwd, ".git")}/**)`);
  }
  expect(() => buildClaudeArgs({ ...spec, addDirs: ["/"] }, "s")).toThrow(
    "cannot grant additional directories",
  );
  // An unpersisted session has no transcript to continue; refusing is cheaper than a failed launch.
  expect(() => buildClaudeArgs({ ...spec, resumeSessionId: "s-1" }, "s")).toThrow("cannot resume");
});

/** A fake `codex sandbox` honouring (or, when leaky, ignoring) the editor profile's most specific entry. */
function editCodex(
  behaviour: "enforcing" | "leaky" | "timeout" | "admin-leak" | "common-leak" = "enforcing",
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "edit-probe-roots-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const cli = { version: "codex-cli 0.160.0", path: CODEX };
  const runner = async (opts: ProcOptions): Promise<ProcResult> => {
    calls.push(opts.cmd);
    if (opts.cmd[1] === "--version") return { ...procResult, stdout: `${cli.version}\n` };
    if (opts.cmd[1] !== "sandbox") {
      opts.onStdoutLine?.('{"type":"turn.completed","usage":{}}');
      return procResult;
    }
    if (behaviour === "timeout") return { ...procResult, exitCode: null, timedOut: true };
    const pointer = readFileSync(join(opts.cwd, ".git"), "utf8");
    expect(pointer.startsWith("gitdir: ")).toBe(true);
    const admin = pointer.slice(8).trim();
    const common = resolve(admin, readFileSync(join(admin, "commondir"), "utf8").trim());
    expect(readFileSync(join(admin, "gitdir"), "utf8")).toBe(join(opts.cwd, ".git"));
    expect(dirname(dirname(admin))).toBe(common);
    const [token = "", file = ""] = opts.cmd.slice(-2);
    const entries = Object.entries(codexFilesystem(opts.cmd)).filter(
      ([path]) => file === path || file.startsWith(`${path === "/" ? "" : path}/`),
    );
    const access = entries.sort(([a], [b]) => b.length - a.length)[0]?.[1];
    if (
      behaviour === "leaky" ||
      (behaviour === "admin-leak" && file.startsWith(`${admin}/`)) ||
      (behaviour === "common-leak" && dirname(file) === common) ||
      access === "write"
    ) {
      writeFileSync(file, token);
      return procResult;
    }
    return { ...procResult, exitCode: 1, stderr: `sh: ${file}: Operation not permitted` };
  };
  const probe = new CodexReaderProbe(() => cli.path, { canaryRoots: () => [root], backoffMs: 0 });
  const execs = () => calls.filter((c) => c[1] === "exec");
  const sandboxes = () => calls.filter((c) => c[1] === "sandbox");
  return { runner, probe, execs, sandboxes, cli, root };
}

test("codex editors run only after a probe writes cwd and scratch and is denied a canary and .git", async () => {
  const { spec } = editFixture();
  const fake = editCodex();
  const result = await runCodex(spec, fake.runner, fake.probe);
  expect(result.status).toBe("ok");
  expect(result.confinement).toMatchObject({ ok: true, version: "codex-cli 0.160.0" });
  // Negative canary, the probe's own .git, then cwd and scratch writes.
  expect(fake.sandboxes()).toHaveLength(6);
  expect(fake.execs()).toHaveLength(1);
  expect(readdirSync(fake.root)).toEqual([]);
  // Cached for this CLI and version; a new version is probed again.
  await runCodex(spec, fake.runner, fake.probe);
  expect(fake.sandboxes()).toHaveLength(6);
  fake.cli.version = "codex-cli 0.161.0";
  await runCodex(spec, fake.runner, fake.probe);
  expect(fake.sandboxes()).toHaveLength(12);
  fake.cli.path = `${CODEX}-alternate`;
  await runCodex(spec, fake.runner, fake.probe);
  expect(fake.sandboxes()).toHaveLength(18);
});

for (const behaviour of ["leaky", "timeout", "admin-leak", "common-leak"] as const)
  test(`a ${behaviour} editor probe never starts exec`, async () => {
    const { spec } = editFixture();
    const fake = editCodex(behaviour);
    for (let i = 0; i < 2; i++) {
      const result = await runCodex(spec, fake.runner, fake.probe);
      expect(result.status).toBe("unavailable");
      expect(result.error).toContain("Codex write confinement not verified");
      expect(result.confinement?.reason).toBe(
        behaviour === "timeout" ? "probe timed out" : "write profile not enforced",
      );
    }
    expect(fake.execs()).toHaveLength(0);
    // A definitive leak is cached; a timeout is probed again.
    expect(fake.sandboxes()).toHaveLength(behaviour === "leaky" ? 1 : behaviour === "admin-leak" ? 3 : 2);
    expect(readdirSync(fake.root)).toEqual([]);
  });

test("a cancelled editor probe removes its files and never starts exec", async () => {
  const { spec } = editFixture();
  const fake = editCodex();
  const abort = new AbortController();
  const runner = async (opts: ProcOptions) => {
    if (opts.cmd[1] === "sandbox") abort.abort();
    return fake.runner(opts);
  };
  const result = await runCodex({ ...spec, signal: abort.signal }, runner, fake.probe);
  expect(result.status).toBe("cancelled");
  expect(fake.execs()).toHaveLength(0);
  await Bun.sleep(10);
  expect(readdirSync(fake.root)).toEqual([]);
});

test.skipIf(codexSkip !== null)(
  `the real Codex sandbox enforces the editor profile ${codexSkip ?? ""}`,
  () => {
    const { root, cwd, scratchDir, spec, common, admin } = editFixture();
    const profile = buildCodexArgs(spec).filter(
      (arg, i, all) => all[i - 1] === "-c" && /permissions/.test(arg),
    );
    const write = (file: string) =>
      Bun.spawnSync(
        [
          "codex",
          "sandbox",
          ...profile.flatMap((p) => ["-c", p]),
          "--",
          "/bin/sh",
          "-c",
          'sh -c "printf x >> \\"$1\\"" _ "$1"',
          "_",
          file,
        ],
        { cwd, env: { ...process.env, TMPDIR: scratchDir }, stdout: "ignore", stderr: "ignore" },
      ).exitCode === 0;
    for (const allowed of [join(cwd, "a"), join(scratchDir, "s")]) expect(write(allowed)).toBe(true);
    const config = readFileSync(join(common, "config"), "utf8");
    for (const denied of [
      join(admin, "probe"),
      join(common, "config"),
      join(common, "info/attributes"),
      join(root, "sibling/x"),
      join(cwd, ".git"),
      join(root, "outside"),
    ])
      expect(write(denied)).toBe(false);
    expect(readFileSync(join(common, "config"), "utf8")).toBe(config);
    expect(existsSync(join(common, "info/attributes"))).toBe(false);
  },
);

test.skipIf(process.platform !== "darwin")(
  `Claude edit launches put native tools inside the probed exact boundary, fast or not`,
  async () => {
    const { spec, cwd, scratchDir, admin, common } = editFixture();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({
        sandbox: { enabled: false, excludedCommands: ["*"] },
        hooks: { SessionStart: [{ command: "touch escaped" }] },
      }),
    );
    for (const fast of [false, true]) {
      let probes = 0;
      let payloads = 0;
      const outcome = await runClaude({ ...spec, fast }, async (opts) => {
        expect(opts.cmd[0]).toBe("/usr/bin/sandbox-exec");
        const profile = opts.cmd[2] ?? "";
        for (const path of [cwd, scratchDir, admin]) expect(profile).toContain(`(subpath "${path}")`);
        expect(profile).not.toContain(`(subpath "${common}")`);
        expect(profile).toContain(`(deny file-write* (subpath "${cwd}/.git") (subpath "${admin}"))`);
        if (!opts.cmd.includes("claude")) {
          probes++;
          writeFileSync(opts.cmd.at(-2) ?? "", "ok");
          return { ...procResult, stdout: "verified" };
        }
        payloads++;
        expect(probes).toBe(1);
        expect(opts.cmd[opts.cmd.indexOf("--setting-sources") + 1]).toBe("");
        expect(opts.cmd).toContain("--strict-mcp-config");
        expect(opts.env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
        expect(opts.env.HOME).toBe(process.env.HOME);
        const settings = JSON.parse(opts.cmd[opts.cmd.indexOf("--settings") + 1] ?? "{}");
        expect(settings.sandbox.enabled).toBe(false);
        expect(settings.sandbox.allowUnsandboxedCommands).toBe(true);
        expect(opts.cmd).toContain("--no-session-persistence");
        // Without the CLI sandbox, the Bash cwd record goes to $CLAUDE_CODE_TMPDIR itself.
        expect(opts.env.CLAUDE_CODE_TMPDIR).toBe(scratchDir);
        opts.onStdoutLine?.(opts.cmd[7] ?? "");
        opts.onStdoutLine?.('{"type":"result","subtype":"success","result":"ok"}');
        return procResult;
      });
      expect(outcome.status).toBe("ok");
      expect(payloads).toBe(1);
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  `Claude preserves a custom authentication directory without copying or granting writes to it`,
  async () => {
    const { root, spec, scratchDir } = editFixture();
    const config = join(root, "persistent-auth");
    mkdirSync(config);
    for (const name of [".credentials.json", ".claude.json"])
      writeFileSync(join(config, name), '{"ownedAuthCanary":true}');
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      for (const exitCode of [0, 1]) {
        const result = await runClaude(spec, async (opts) => {
          if (!opts.cmd.includes("claude")) {
            writeFileSync(opts.cmd.at(-2) ?? "", "ok");
            return { ...procResult, stdout: "verified" };
          }
          expect(opts.env.CLAUDE_CONFIG_DIR).toBe(config);
          expect(opts.env.HOME).toBe(process.env.HOME);
          expect(opts.cmd[2]).not.toContain(config);
          expect(existsSync(join(scratchDir, ".claude"))).toBe(false);
          opts.onStdoutLine?.(opts.cmd[7] ?? "");
          if (!exitCode) opts.onStdoutLine?.('{"type":"result","result":"ok"}');
          return { ...procResult, exitCode, stderr: exitCode ? "authentication failed" : "" };
        });
        expect(result.status).toBe(exitCode ? "error" : "ok");
        for (const name of [".credentials.json", ".claude.json"])
          expect(readFileSync(join(config, name), "utf8")).toBe('{"ownedAuthCanary":true}');
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  `Claude does not launch untrusted code when its boundary probe leaks`,
  async () => {
    const { spec } = editFixture();
    let calls = 0;
    await expect(
      runClaude(spec, async (opts) => {
        calls++;
        expect(opts.cmd).not.toContain("claude");
        writeFileSync(opts.cmd.at(-2) ?? "", "ok");
        writeFileSync(opts.cmd.at(-1) ?? "", "escaped");
        return procResult;
      }),
    ).rejects.toThrow("Write confinement not verified");
    expect(calls).toBe(1);
  },
);
