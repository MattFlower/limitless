import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfinementError, runConfined, verifySeatbelt } from "../src/harness/sandbox.ts";
import { agentEnv, type ProcOptions, type ProcResult, sh } from "../src/util/proc.ts";

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

test.skipIf(!darwin)("confined commands write the worktree, its git directory and scratch only", async () => {
  const before = new Map(protectedTargets().map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null]));
  expect(await attempt(join(work, "allowed"))).toBe(true);
  expect(await attempt(join(privateDir(), "allowed"))).toBe(true);
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
});

test.skipIf(!darwin)(
  "an agent cannot plant '*.ts -diff' or a clean filter in the shared repository",
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

test.skipIf(!darwin)("a redirected .git is refused before anything runs", async () => {
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
function backend(behaviour: "enforced" | "leaky" | "timeout" | "throws") {
  const calls: string[][] = [];
  const run = async (opts: ProcOptions): Promise<ProcResult> => {
    calls.push(opts.cmd);
    if (behaviour === "throws") throw new Error("spawn failed");
    if (behaviour === "timeout") return proc({ exitCode: null, timedOut: true });
    const [inside, outside] = opts.cmd.slice(-2) as [string, string];
    writeFileSync(inside, "ok");
    if (behaviour === "leaky") writeFileSync(outside, "no");
    return proc({ exitCode: behaviour === "leaky" ? 0 : 1 });
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
  for (const behaviour of ["leaky", "timeout", "throws"] as const)
    await expect(verifySeatbelt(backend(behaviour).run, executable, "darwin")).rejects.toThrow();
  // Nothing was cached: an enforcing backend is probed afresh, and only that verdict is remembered.
  const good = backend("enforced");
  await verifySeatbelt(good.run, executable, "darwin");
  await verifySeatbelt(good.run, executable, "darwin");
  expect(good.calls).toHaveLength(1);
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
