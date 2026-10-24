import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapGit, elfInterpreter, gitConfinement, gitSh } from "../src/git/confinement.ts";
import { ConfinementError, platformConfinement, runSandboxed, SANDBOX_EXEC } from "../src/harness/sandbox.ts";
import { BWRAP, bwrapArgs, linuxForPort, verifyLinux } from "../src/harness/sandbox-linux.ts";
import type { WriteRoots } from "../src/harness/scratch.ts";
import { agentEnv, type ProcResult } from "../src/util/proc.ts";
import { bwrapSkip } from "./confinement.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "linux-confinement-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A gate-shaped layout: a denied home holding a toolchain, the checkout and a credential. */
function layout() {
  const home = join(root, "home");
  const [tool, work, scratch, commands] = [
    join(home, "tool"),
    join(home, "work"),
    join(root, "scratch"),
    join(root, "cmds"),
  ];
  for (const dir of [tool, join(work, ".git"), scratch, join(commands, "own"), join(commands, "other")])
    mkdirSync(dir, { recursive: true });
  for (const file of [join(home, "credential"), join(work, "secret.db"), join(commands, "own", "x")])
    writeFileSync(file, "secret");
  const roots: WriteRoots = {
    write: [work, scratch],
    protect: [join(work, ".git")],
    denyRead: [home, join(home, "credential"), join(work, "secret.db"), join(home, "missing")],
    allowRead: [tool, work, scratch],
    commands: { root: [commands], own: [join(commands, "own")] },
  };
  return { home, tool, work, scratch, commands, roots };
}

test("bwrapArgs masks denies, then binds allowances, write roots and protected paths, then re-masks specific denies", () => {
  const { home, tool, work, scratch, commands, roots } = layout();
  const sources = { dir: join(root, "mask-dir"), file: join(root, "mask-file") };
  const args = bwrapArgs(roots, sources, []);
  const at = (...seq: string[]) => {
    const i = args.findIndex((_, n) => seq.every((s, k) => args[n + k] === s));
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  };
  // Order is the policy: each later mount overrides the earlier ones beneath it.
  const order = [
    at("--perms", "0111", "--tmpfs", home),
    at("--ro-bind", tool, tool),
    at("--bind", work, work),
    at("--ro-bind", join(work, ".git"), join(work, ".git")),
    at("--ro-bind", sources.file, join(work, "secret.db")),
    at("--perms", "0111", "--tmpfs", commands),
    at("--ro-bind", join(commands, "own"), join(commands, "own")),
    at("--remount-ro", home),
  ];
  expect(order).toEqual([...order].sort((a, b) => a - b));
  at("--remount-ro", commands);
  at("--bind", scratch, scratch);
  // Hidden by the home mask already, or absent: nothing to mount.
  expect(args).not.toContain(join(home, "credential"));
  expect(args).not.toContain(join(home, "missing"));
  for (const hidden of ["/run", "/tmp", "/var/tmp"]) expect(args).toContain(hidden);

  // Inside a private tmpfs only a deny that binds pass through needs a mask; allowances are bound back.
  const inTmp = bwrapArgs(roots, sources, [root]).join(" ");
  expect(inTmp).toContain(`--tmpfs ${home}`);
  expect(inTmp).not.toContain(`${sources.file} ${join(home, "credential")}`);
  expect(inTmp).toContain(`--ro-bind ${tool} ${tool}`);
});

test("bwrapArgs refuses unusual paths and invalid daemon ports", () => {
  const { roots } = layout();
  const sources = { dir: root, file: root };
  expect(() => bwrapArgs({ ...roots, write: [`${root}/a\nb`] }, sources)).toThrow(ConfinementError);
  expect(() => bwrapArgs({ ...roots, denyRead: ["relative"] }, sources)).toThrow(ConfinementError);
  for (const daemonPort of [0, 70000, 1.5])
    expect(() => bwrapArgs({ ...roots, daemonPort }, sources)).toThrow("Invalid daemon port");
});

test("platformConfinement keeps Seatbelt off Linux and runs bwrap behind the Landlock launcher on Linux", () => {
  const { roots } = layout();
  const cmd = ["/bin/true"];
  expect(platformConfinement(7, "darwin").wrap(cmd, roots)[0]).toBe(SANDBOX_EXEC);
  const linux = platformConfinement(7, "linux").wrap(cmd, roots);
  const launcherEnd = linux.indexOf("--");
  expect(linux[launcherEnd - 1]).toBe("7");
  expect(linux[launcherEnd + 1]).toBe(BWRAP);
  expect(linux.slice(-2)).toEqual(["--", "/bin/true"]);
});

const result = (stdout: string, exitCode = 0): ProcResult =>
  ({ exitCode, stdout, stderr: "", cancelled: false, timedOut: false, signal: null }) as ProcResult;

test.skipIf(process.platform !== "linux")(
  "verifyLinux fails closed unless both probes conclude (abstract sockets need linux)",
  async () => {
    const { roots } = layout();
    const bwrap = join(root, "bwrap");
    writeFileSync(bwrap, "");
    const verify = (run: (cmd: string[]) => ProcResult, platform = "linux", path = bwrap) =>
      verifyLinux(roots, {}, async ({ cmd }) => run(cmd), path, platform);
    await expect(verify(() => result(""), "darwin")).rejects.toThrow("darwin has no bubblewrap");
    await expect(verify(() => result(""), "linux", join(root, "missing"))).rejects.toThrow(ConfinementError);
    // The sandbox probe's own word is not enough: a file written outside fails the preflight.
    const leaky = (cmd: string[]) => {
      if (cmd[0] !== "/bin/sh") return result("landlock-verified");
      writeFileSync(cmd[5] ?? "", "ok");
      writeFileSync(cmd[6] ?? "", "leaked");
      return result("linux-verified");
    };
    await expect(verify(leaky)).rejects.toThrow("bubblewrap did not enforce its policy");
    const network = (stdout: string) => (cmd: string[]) => {
      if (cmd[0] !== "/bin/sh") return result(stdout, stdout ? 0 : 1);
      writeFileSync(cmd[5] ?? "", "ok");
      return result("linux-verified");
    };
    await expect(verify(network(""))).rejects.toThrow("Network and signal confinement not verified");
    await verify(network("landlock-verified"));
  },
);

test.skipIf(bwrapSkip !== null)(
  `real bwrap and Landlock enforce every guarantee row (${bwrapSkip})`,
  async () => {
    const { home, tool, work, commands, roots } = layout();
    const daemon = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const other = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const abstract = `linux-confinement-${crypto.randomUUID()}`;
    const unix = Bun.listen({ unix: `\0${abstract}`, socket: { data() {} } });
    const outside = Bun.spawn(["sleep", "30"]);
    const beside = join(root, "beside");
    const marker = `linux-confinement-${crypto.randomUUID()}`;
    const net = `
    const { connect } = require("node:net");
    const reach = (o) => new Promise((r) => { const s = connect(o); s.once("connect", () => { s.destroy(); r("reached"); }); s.once("error", () => r("refused")); });
    let signal = "reached"; try { process.kill(${outside.pid}, 0); } catch { signal = "refused"; }
    console.log("daemon", await reach({ host: "127.0.0.1", port: ${daemon.port} }), "other", await reach({ host: "127.0.0.1", port: ${other.port} }),
      "abstract", await reach({ path: "\\0${abstract}" }), "signal", signal);`;
    const check = (label: string, command: string) =>
      `if (${command}) >/dev/null 2>&1; then echo "${label} allowed"; else echo "${label} refused"; fi`;
    const script = [
      check("write checkout", "echo ok > f"),
      // Lands in the private /tmp at most: only the host can tell it was refused.
      `echo x > '${beside}' 2>/dev/null`,
      check("write .git", "echo x > .git/config"),
      check("read secret.db", "head -c 1 secret.db"),
      check("list home", `ls -A '${home}'`),
      check("read credential", `head -c 1 '${home}/credential'`),
      check("read toolchain", `ls '${tool}'`),
      check("list other command", `ls '${commands}/other'`),
      check("read own command", `cat '${commands}/own/x'`),
      check("write own command", `echo x > '${commands}/own/x'`),
      // Codex's nested bubblewrap needs a writable /tmp; this one is private to the sandbox.
      check("write private /tmp", `echo x > /tmp/${marker}`),
      check("runtime dir", 'ls "$XDG_RUNTIME_DIR"/bus'),
      check("signal outside", `kill -0 ${outside.pid}`),
      `'${process.execPath}' -e '${net.replaceAll("'", "'\\''")}'`,
    ].join("\n");
    try {
      const run = await runSandboxed(
        {
          cmd: ["/bin/sh", "-c", script],
          cwd: work,
          env: { ...agentEnv(), XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/run/user/0" },
        },
        roots,
        undefined,
        undefined,
        linuxForPort(daemon.port),
      );
      expect(run.stdout.trim().split("\n")).toEqual([
        "write checkout allowed",
        "write .git refused",
        "read secret.db refused",
        "list home refused",
        "read credential refused",
        "read toolchain allowed",
        "list other command refused",
        "read own command allowed",
        "write own command refused",
        "write private /tmp allowed",
        "runtime dir refused",
        "signal outside refused",
        "daemon refused other reached abstract refused signal refused",
      ]);
      expect(existsSync(beside)).toBe(false);
      expect(existsSync(join("/tmp", marker))).toBe(false);
    } finally {
      outside.kill();
      for (const listener of [daemon, other, unix]) listener.stop(true);
    }
  },
);

test.skipIf(bwrapSkip !== null)(
  `real Linux Git confinement runs git but no other program, network or outside write (${bwrapSkip})`,
  async () => {
    const repo = join(root, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    expect(elfInterpreter(realpathSync(Bun.which("git") ?? "git"))).toBeDefined();
    const marker = join(root, "fsmonitor-ran");
    const git = (args: string[]) =>
      gitConfinement.run(bwrapGit(), () =>
        gitSh(["git", ...args], { cwd: repo, env: agentEnv(), allowFail: true }),
      );
    expect(
      (await git(["-c", "user.name=n", "-c", "user.email=a@b", "commit", "--allow-empty", "-qm", "x"]))
        .exitCode,
    ).toBe(0);
    expect((await git(["-c", "alias.x=!true", "x"])).stderr).toContain("Permission denied");
    await git(["-c", `core.fsmonitor=/usr/bin/touch ${marker}`, "status"]);
    expect(existsSync(marker)).toBe(false);
    let connections = 0;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open: () => void connections++, data() {} },
    });
    try {
      expect((await git(["ls-remote", `http://127.0.0.1:${server.port}/repo.git`])).exitCode).not.toBe(0);
    } finally {
      server.stop(true);
    }
    expect(connections).toBe(0);
    expect((await git(["init", "-q", join(repo, "..", "outside")])).exitCode).toBe(0);
    expect(existsSync(join(root, "outside"))).toBe(false);
  },
);

test.skipIf(process.platform !== "linux")(
  "elfInterpreter refuses a git that is not an ELF executable (needs linux)",
  () => {
    const script = join(root, "git");
    writeFileSync(script, "#!/bin/sh\n");
    expect(() => elfInterpreter(script)).toThrow(ConfinementError);
  },
);
