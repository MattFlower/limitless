import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfinementError,
  runConfined,
  runSandboxed,
  verifySeatbelt,
  withCommandScratch,
} from "../src/harness/sandbox.ts";
import { agentEnv, type ProcOptions, type ProcResult, runProcess, sh } from "../src/util/proc.ts";
import { recordingConfinement, seatbeltSkip } from "./confinement.ts";

// Real git and sandboxed subprocesses.
setDefaultTimeout(30_000);

const darwin = process.platform === "darwin";
let root: string;
let cache: string;
let work: string;
let sibling: string;
let home: string;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-test-")));
  cache = join(root, "cache");
  work = join(root, "work");
  sibling = join(root, "sibling");
  home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, "canary"), "home");
  const git = (...args: string[]) =>
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  await git("init", "-q", cache);
  writeFileSync(join(cache, "a.ts"), "test('ok', () => {});\n");
  await git("-C", cache, "add", "-A");
  await git("-C", cache, "commit", "-qm", "base");
  await git("-C", cache, "worktree", "add", "-q", "--detach", work);
  await git("-C", cache, "worktree", "add", "-q", "--detach", sibling);
  writeFileSync(join(sibling, "canary"), "sibling");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const common = () => join(cache, ".git");
const privateDir = () => join(common(), "worktrees", "work");

/** Each target is written by a child of a child; the exit status says whether the write landed. */
async function attempt(target: string): Promise<boolean> {
  const quoted = `'${target.replaceAll("'", "'\\''")}'`;
  const run = await runConfined({
    command: `sh -c "mkdir -p \\"\\$(dirname ${quoted})\\" 2>/dev/null; printf escaped >> ${quoted}"`,
    cwd: work,
    env: agentEnv(),
    timeoutMs: 10_000,
  });
  return run.exitCode === 0;
}

const protectedTargets = () => [
  join(privateDir(), "config"),
  join(common(), "packed-refs"),
  join(common(), "refs", "heads", "planted"),
  join(common(), "config"),
  join(common(), "info", "attributes"),
  join(common(), "info", "exclude"),
  join(common(), "hooks", "pre-commit"),
  join(common(), "objects", "planted"),
  join(common(), "worktrees", "sibling", "HEAD"),
  join(work, ".git"),
  join(sibling, "canary"),
  join(home, "canary"),
];

test.skipIf(seatbeltSkip !== null)(
  `confined commands write the worktree, scratch only ${seatbeltSkip ?? ""}`,
  async () => {
    const before = new Map(
      protectedTargets().map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null]),
    );
    expect(await attempt(join(work, "allowed"))).toBe(true);
    expect(await attempt(join(privateDir(), "allowed"))).toBe(false);
    const scratch = await runConfined({
      command: 'printf ok > "$TMPDIR/f" && printf ok > "$HOME/g" && cat "$TMPDIR/f" "$HOME/g"',
      cwd: work,
      env: agentEnv(),
    });
    expect(scratch.stdout).toBe("okok");
    for (const target of protectedTargets()) expect(await attempt(target)).toBe(false);
    // A symlink inside the worktree does not carry a write outside it.
    symlinkSync(home, join(work, "via-link"));
    expect(await attempt(join(work, "via-link", "canary"))).toBe(false);
    for (const [path, content] of before)
      expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(content);
  },
);

test.skipIf(seatbeltSkip !== null)(
  `an agent cannot plant '*.ts -diff' or a clean filter in the shared repository ${seatbeltSkip ?? ""}`,
  async () => {
    const plant = await runConfined({
      command: [
        "git config filter.x.clean 'touch pwned; cat'",
        "echo '*.ts -diff filter=x' >> \"$(git rev-parse --git-common-dir)/info/attributes\"",
        "echo 'hidden/' >> \"$(git rev-parse --git-common-dir)/info/exclude\"",
      ].join("; "),
      cwd: work,
      env: agentEnv(),
    });
    expect(plant.exitCode).not.toBe(0);
    expect(
      (await sh(["git", "config", "--get", "filter.x.clean"], { cwd: work, allowFail: true })).stdout,
    ).toBe("");
    expect(existsSync(join(common(), "info", "attributes"))).toBe(false);
    expect(readFileSync(join(common(), "info", "exclude"), "utf8")).not.toContain("hidden/");
  },
);

test("a redirected .git is refused before anything runs", async () => {
  writeFileSync(join(work, ".git"), `gitdir: ${join(common(), "worktrees", "sibling")}\n`);
  const marker = join(root, "ran");
  await expect(
    runConfined({ command: `touch '${marker}'`, cwd: work, env: agentEnv() }, async () => {}),
  ).rejects.toThrow("own linked worktree directory");
  expect(existsSync(marker)).toBe(false);
});

const proc = (over: Partial<ProcResult> = {}): ProcResult => ({
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  idleTimedOut: false,
  stdout: "",
  stderr: "",
  truncated: false,
  durationMs: 1,
  ...over,
});

/** A fake backend: writes what the profile would allow (`inside`) and, if leaky, what it must deny. */
function backend(behaviour: "enforced" | "leaky" | "timeout" | "throws" | "incomplete") {
  const calls: string[][] = [];
  const run = async (opts: ProcOptions): Promise<ProcResult> => {
    calls.push(opts.cmd);
    if (behaviour === "throws") throw new Error("spawn failed");
    if (behaviour === "timeout") return proc({ exitCode: null, timedOut: true });
    const [inside, outside] = opts.cmd.slice(-2) as [string, string];
    writeFileSync(inside, "ok");
    if (behaviour === "leaky") writeFileSync(outside, "no");
    return proc({
      exitCode: behaviour === "leaky" ? 1 : 0,
      stdout: behaviour === "incomplete" ? "" : "verified",
    });
  };
  return { run, calls };
}

test("unavailable, ineffective or inconclusive Seatbelt fails closed and is never cached", async () => {
  const executable = join(root, "sandbox-exec");
  writeFileSync(executable, "");
  await expect(verifySeatbelt(backend("enforced").run, join(root, "missing"), "darwin")).rejects.toThrow(
    ConfinementError,
  );
  await expect(verifySeatbelt(backend("enforced").run, executable, "linux")).rejects.toThrow(
    "linux has no Seatbelt",
  );
  for (const behaviour of ["leaky", "timeout", "throws", "incomplete"] as const)
    await expect(verifySeatbelt(backend(behaviour).run, executable, "darwin")).rejects.toThrow();
  // Every launch is probed afresh, including after an earlier successful check.
  const good = backend("enforced");
  await verifySeatbelt(good.run, executable, "darwin");
  await verifySeatbelt(good.run, executable, "darwin");
  expect(good.calls).toHaveLength(2);
});

test("the payload never runs after a failed verification or once cancelled", async () => {
  const marker = join(root, "payload-ran");
  const opts = { command: `touch '${marker}'`, cwd: work, env: agentEnv() };
  await expect(
    runConfined(opts, async () => {
      throw new ConfinementError("not verified");
    }),
  ).rejects.toThrow("not verified");
  const abort = new AbortController();
  await expect(runConfined({ ...opts, signal: abort.signal }, async () => abort.abort())).rejects.toThrow();
  expect(existsSync(marker)).toBe(false);
});

test.skipIf(darwin)("platforms without Seatbelt refuse confined commands", async () => {
  const marker = join(root, "payload-ran");
  await expect(runConfined({ command: `touch '${marker}'`, cwd: work, env: agentEnv() })).rejects.toThrow(
    ConfinementError,
  );
  expect(existsSync(marker)).toBe(false);
});

test("a backend startup failure after successful verification is operational, never a gate exit", async () => {
  const opts = { command: "exit 71", cwd: work, env: agentEnv() };
  for (const failure of [
    proc({ exitCode: 71, stderr: "sandbox initialization failed" }),
    proc({ exitCode: null, timedOut: true }),
    proc({ cancelled: true }),
  ]) {
    await expect(
      runConfined(
        opts,
        async () => {},
        async () => failure,
      ),
    ).rejects.toThrow(ConfinementError);
  }
  // A launched command may itself exit 71; the trusted shell handshake distinguishes that result.
  const result = await runConfined(
    opts,
    async () => {},
    async (opts) => {
      const token = opts.cmd[7];
      if (!token) throw new Error("missing launch token");
      opts.onStdoutLine?.(token);
      return proc({ exitCode: 71, stdout: `${token}\nuser output` });
    },
  );
  expect(result.exitCode).toBe(71);
  expect(result.stdout).toBe("user output");
});

test("the effective profile is probed before the native-tool process and failed probes never launch it", async () => {
  const roots = { write: [work], protect: [join(work, ".git")] };
  for (const behaviour of ["leaky", "timeout", "throws", "incomplete"] as const) {
    const fake = backend(behaviour);
    await expect(
      runSandboxed({ cmd: ["native-tool"], cwd: work, env: agentEnv() }, roots, fake.run, () =>
        verifySeatbelt(fake.run, "/bin/sh", "darwin", roots),
      ),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.[2]).toContain(`(subpath "${work}")`);
    expect(fake.calls.flat()).not.toContain("native-tool");
  }
});

test("command scratch persists across setup, checks and retry scopes, with readable toolchains", async () => {
  let scratch = "";
  const opts = { command: "unused", cwd: work, env: agentEnv({ HOME: home }) };
  mkdirSync(join(home, ".cargo"));
  writeFileSync(join(home, ".cargo", "config.toml"), "[net]\nretry = 2\n");
  const run = async (opts: ProcOptions) => {
    expect(opts.env.HOME).toBe(opts.env.TMPDIR);
    expect(opts.env.RUSTUP_HOME).toBe(join(home, ".rustup"));
    const current = opts.env.TMPDIR ?? "";
    expect(readFileSync(join(opts.env.CARGO_HOME ?? "", "config.toml"), "utf8")).toContain("retry = 2");
    if (scratch) {
      expect(current).toBe(scratch);
      expect(readFileSync(join(current, "setup"), "utf8")).toBe("ready");
    } else {
      scratch = current;
      writeFileSync(join(current, "setup"), "ready");
    }
    opts.onStdoutLine?.(opts.cmd[7] ?? "");
    return proc();
  };
  await withCommandScratch(work, async () => {
    await runConfined(opts, async () => {}, run);
    await withCommandScratch(work, () => runConfined(opts, async () => {}, run));
    await runConfined(opts, async () => {}, run);
    expect(existsSync(scratch)).toBe(true);
  });
  expect(existsSync(scratch)).toBe(false);
});

test.skipIf(seatbeltSkip !== null)(
  `installed rustup discovery survives command confinement ${seatbeltSkip ?? ""}`,
  async () => {
    // No download or network: run the installed toolchain only when this host has one.
    const normal = await runProcess({ cmd: ["cargo", "--version"], cwd: work, env: agentEnv() });
    if (normal.exitCode !== 0) return;
    const confined = await runConfined({ command: "cargo --version", cwd: work, env: agentEnv() });
    expect(confined.exitCode).toBe(0);
    expect(confined.stdout).toBe(normal.stdout);
  },
);

test("later commands never copy trusted config through setup-created scratch symlinks", async () => {
  mkdirSync(join(home, ".cargo"));
  writeFileSync(join(home, ".cargo", "config.toml"), "[net]\nretry = 2\n");
  const protectedDir = join(home, "protected");
  mkdirSync(protectedDir);
  const opts = { command: "unused", cwd: work, env: agentEnv({ HOME: home }) };
  let calls = 0;
  await withCommandScratch(work, async () => {
    const runner = async (opts: ProcOptions) => {
      calls++;
      const cargo = opts.env.CARGO_HOME ?? "";
      if (calls === 1) {
        rmSync(cargo, { recursive: true });
        symlinkSync(protectedDir, cargo);
      }
      opts.onStdoutLine?.(opts.cmd[7] ?? "");
      return proc();
    };
    await runConfined(opts, async () => {}, runner);
    await runConfined(opts, async () => {}, runner);
  });
  expect(calls).toBe(2);
  expect(existsSync(join(protectedDir, "config.toml"))).toBe(false);
});

test("confined environment retains installed cargo discovery without a live sandbox backend", async () => {
  const normal = await runProcess({ cmd: ["cargo", "--version"], cwd: work, env: agentEnv() });
  if (normal.exitCode !== 0) return;
  const result = await runConfined(
    { command: "cargo --version", cwd: work, env: agentEnv() },
    async () => {},
    async (opts) => {
      opts.onStdoutLine?.(opts.cmd[7] ?? "");
      return runProcess({ ...opts, cmd: opts.cmd.slice(8) });
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(normal.stdout);
});

test.skipIf(seatbeltSkip !== null)(
  `private admin metadata cannot be removed or linked ${seatbeltSkip ?? ""}`,
  async () => {
    const admin = privateDir();
    const before = readFileSync(join(admin, "commondir"));
    for (const command of [
      `rm '${admin}/commondir'`,
      `rm '${work}/.git'`,
      `mv '${work}/.git' '${work}/moved-git'`,
      `ln '${home}/canary' '${work}/hardlink'`,
      `echo bad > '${admin}/config'`,
      `ln -sf '${home}/canary' '${admin}/logs/HEAD'`,
    ]) {
      expect((await runConfined({ command, cwd: work, env: agentEnv() })).exitCode).not.toBe(0);
    }
    expect(readFileSync(join(admin, "commondir"))).toEqual(before);
    expect(existsSync(join(admin, "config"))).toBe(false);
  },
);

test("portable backend exercises startup and roots off macOS; production remains Seatbelt", async () => {
  const { backend: fake, calls } = recordingConfinement();
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("missing platform descriptor");
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const opts = {
      cwd: work,
      env: agentEnv({ GIT_OPTIONAL_LOCKS: "1" }),
      command: "git status --porcelain && git diff && git log -1 --format=%s",
    };
    const newer = new Date(Date.now() + 5000);
    utimesSync(join(work, "a.ts"), newer, newer);
    const before = readFileSync(join(privateDir(), "index"));
    for (const command of ["git status --porcelain", "git diff", "git log -1 --format=%s"]) {
      const result = await runConfined({ ...opts, command }, undefined, undefined, fake);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(privateDir(), "index")), command).toEqual(before);
    }
    expect(calls[0]?.roots.protect).toContain(privateDir());
    expect(calls[0]?.roots.write).not.toContain(privateDir());
    expect(calls[0]?.opts.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(calls[0]?.opts.env.LIMITLESS_CONFINED).toBe("1");
    await expect(runConfined({ ...opts, command: "touch should-not-start" })).rejects.toThrow(
      ConfinementError,
    );
    expect(existsSync(join(work, "should-not-start"))).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
