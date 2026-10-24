import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bwrapGit,
  checkApply,
  elfInterpreter,
  gitBwrapArgs,
  gitConfinement,
  gitSh,
} from "../src/git/confinement.ts";
import { landlockCommand, PAYLOAD_ENV, seccompFilter } from "../src/harness/landlock.ts";
import { ConfinementError, platformConfinement, runSandboxed, SANDBOX_EXEC } from "../src/harness/sandbox.ts";
import { BWRAP, bwrapArgs, linuxForPort, shadow, verifyLinux } from "../src/harness/sandbox-linux.ts";
import type { WriteRoots } from "../src/harness/scratch.ts";
import { agentEnv, invocationScratch, type ProcResult, runProcess } from "../src/util/proc.ts";
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

test("bwrapArgs refuses policies a bind mount cannot enforce", () => {
  const { work, scratch, roots } = layout();
  const sources = { dir: root, file: root };
  // A denied file that does not exist yet could be created inside the writable checkout and read.
  const future = { ...roots, denyRead: [...(roots.denyRead ?? []), join(work, "future.db")] };
  expect(() => bwrapArgs(future, sources)).toThrow("does not exist yet");
  // Outside every bound path the sandbox cannot create it, but the host still could, and the read-only
  // root bind would show it: a visible ancestor is shadowed by a tmpfs holding its current entries.
  const home = join(root, "home");
  symlinkSync("tool", join(home, "link"));
  const absent = { ...roots, denyRead: [join(home, "missing")] };
  const shadowed = bwrapArgs(absent, sources, []);
  const at = (...seq: string[]) => shadowed.findIndex((_, n) => seq.every((v, k) => shadowed[n + k] === v));
  expect(at("--tmpfs", home)).toBeGreaterThan(0);
  expect(shadowed[at("--tmpfs", home) - 2]).toBe("--perms");
  for (const entry of ["credential", "tool", "work"])
    expect(at("--ro-bind-try", join(home, entry), join(home, entry))).toBeGreaterThan(at("--tmpfs", home));
  expect(at("--symlink", "tool", join(home, "link"))).toBeGreaterThan(at("--tmpfs", home));
  // Before the private tmpfs mounts and the write binds, which must override what it binds back.
  expect(at("--tmpfs", home)).toBeLessThan(at("--tmpfs", "/run"));
  expect(at("--bind", work, work)).toBeGreaterThan(
    at("--ro-bind-try", join(home, "work"), join(home, "work")),
  );
  expect(at("--remount-ro", home)).toBeGreaterThan(0);
  expect(shadowed).not.toContain(join(home, "missing"));
  // An ancestor already behind a private tmpfs or a mask shows nothing the host creates there.
  expect(bwrapArgs(absent, sources, [root])).not.toContain("--ro-bind-try");
  expect(bwrapArgs({ ...absent, denyRead: [home, join(home, "missing")] }, sources, [])).not.toContain(
    "--ro-bind-try",
  );
  const otherCommand = join(root, "cmds", "other", "missing");
  expect(bwrapArgs({ ...absent, denyRead: [otherCommand] }, sources, [])).not.toContain(
    join(root, "cmds", "other"),
  );
  // Nothing can shadow the root itself.
  expect(() =>
    bwrapArgs({ ...roots, denyRead: [`/limitless-absent-${crypto.randomUUID()}/x`] }, sources),
  ).toThrow("only existing ancestor is /");
  // A write root under a denied parent without a read allowance would be bound back readable.
  const private_ = join(root, "srv", "private");
  mkdirSync(join(private_, "work"), { recursive: true });
  const nested = { write: [join(private_, "work")], protect: [], denyRead: [private_] };
  expect(() => bwrapArgs(nested, sources)).toThrow("under a denied path");
  expect(() => bwrapArgs({ ...nested, allowRead: [join(private_, "work")] }, sources)).not.toThrow();
  // A write root inside a protected path would drop the protection.
  expect(() => bwrapArgs({ write: [join(private_, "work")], protect: [private_] }, sources)).toThrow(
    "inside a protected path",
  );
  expect(() => bwrapArgs({ ...roots, write: [scratch], protect: [scratch] }, sources)).not.toThrow();
});

test("a denied path the host creates while the mounts are built is never bound back", () => {
  const home = join(root, "home");
  mkdirSync(join(home, "tool"), { recursive: true });
  mkdirSync(join(home, ".ssh"));
  const sources = { dir: join(root, "mask-dir"), file: join(root, "mask-file") };
  const [netrc, hosts, npmrc] = [
    join(home, ".netrc"),
    join(home, ".config/gh/hosts.yml"),
    join(home, ".npmrc"),
  ];
  const roots: WriteRoots = { write: [], protect: [], denyRead: [netrc, hosts, npmrc, join(home, ".ssh")] };
  const [readdir, realpath] = [fs.readdirSync, fs.realpathSync];
  let created = false;
  const spies = [
    // Credentials, one under a directory that was missing too, appear just before the shadow's scan.
    spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
      if (path === home) {
        writeFileSync(netrc, "secret");
        mkdirSync(dirname(hosts), { recursive: true });
        writeFileSync(hosts, "secret");
      }
      return readdir(path, options);
    }) as typeof fs.readdirSync),
    // Another appears right after the lookup that found it absent.
    spyOn(fs, "realpathSync").mockImplementation(((path: string, options: never) => {
      try {
        return realpath(path, options);
      } catch (error) {
        if (path === npmrc && !created) {
          created = true;
          writeFileSync(npmrc, "secret");
        }
        throw error;
      }
    }) as typeof fs.realpathSync),
  ];
  let args: string[] = [];
  try {
    args = bwrapArgs(roots, sources, []);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(created).toBe(true);
  const at = (...seq: string[]) => args.findIndex((_, n) => seq.every((v, k) => args[n + k] === v));
  expect(at("--tmpfs", home)).toBeGreaterThan(0);
  expect(at("--ro-bind-try", join(home, "tool"), join(home, "tool"))).toBeGreaterThan(0);
  for (const path of [netrc, npmrc, join(home, ".config")]) expect(args).not.toContain(path);
  // A deny that existed is masked, never bound back first.
  expect(at("--ro-bind", sources.dir, join(home, ".ssh"))).toBeGreaterThan(0);
  expect(at("--ro-bind-try", join(home, ".ssh"), join(home, ".ssh"))).toBe(-1);
});

test("the Linux launch keeps the payload's environment and cwd off the unconfined launcher and bwrap", () => {
  const { work, roots } = layout();
  const secret = `secret-${crypto.randomUUID()}`;
  const env = { BUN_OPTIONS: "--preload /x.js", LD_PRELOAD: "/x.so", NODE_OPTIONS: secret, PATH: "/usr/bin" };
  const launch = linuxForPort(7).launch;
  if (!launch) throw new Error("the Linux backend has no trusted launch");
  const launched = launch(["/bin/true"], roots, { env, cwd: work });
  expect(launched.cwd).toBe("/");
  expect(Object.keys(launched.env).sort()).toEqual(["LIMITLESS_PAYLOAD_ENV", "PATH"]);
  expect(launched.env.PATH).not.toBe(env.PATH);
  expect(JSON.parse(launched.env.LIMITLESS_PAYLOAD_ENV ?? "")).toEqual(env);
  // Argv is world-readable through /proc: nothing from the payload's environment may appear.
  expect(launched.cmd.join("\0")).not.toContain(secret);
  expect(launched.cmd[launched.cmd.indexOf("--chdir") + 1]).toBe(work);
  expect(launched.cmd.slice(-2)).toEqual(["sh", "/bin/true"]);
  expect(launched.cmd).toContain("--ro-bind-data");
});

test("gitBwrapArgs has no network and write binds only for its roots, then hands git to the confining launcher", () => {
  const args = gitBwrapArgs(["/usr/bin/git", "/lib/ld.so"], ["/w/b", "/w"], "/w/b", "bwrap");
  expect(args[0]).toBe("bwrap");
  expect(args).toContain("--unshare-net");
  expect(args.filter((_, i) => args[i - 1] === "--bind")).toEqual(["/w", "/w/b"]);
  expect(args.indexOf("--bind")).toBeLessThan(args.indexOf("--remount-ro"));
  // bwrap enters "/", never the checkout; the launcher confines itself and then enters the cwd.
  const launcher = landlockCommand(0);
  const at = args.indexOf(launcher[0] ?? "");
  expect(args.slice(at - 2, at)).toEqual(["--chdir", "/"]);
  expect(args.slice(at)).toEqual([...launcher, "--git", "/w/b", "/usr/bin/git", "/lib/ld.so", "--"]);
  expect(() => gitBwrapArgs(["/usr/bin/git\n"], [], "/w", "bwrap")).toThrow(ConfinementError);
});

/** Runs a classic-BPF seccomp program over one synthetic seccomp_data, as the kernel would. */
function seccompVerdict(filter: Buffer, arch: number, nr: number, domain = 0n): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(nr >>> 0, 0);
  data.writeUInt32LE(arch >>> 0, 4);
  data.writeBigUInt64LE(domain, 16);
  let a = 0;
  for (let pc = 0; pc < filter.length / 8; pc++) {
    const [code, jt, jf, k] = [
      filter.readUInt16LE(pc * 8),
      filter.readUInt8(pc * 8 + 2),
      filter.readUInt8(pc * 8 + 3),
      filter.readUInt32LE(pc * 8 + 4),
    ];
    if (code === 0x20) a = data.readUInt32LE(k);
    else if (code === 0x15) pc += a === k ? jt : jf;
    else if (code === 0x35) pc += a >= k ? jt : jf;
    else if (code === 0x06) return k;
    else throw new Error(`unexpected BPF instruction ${code}`);
  }
  throw new Error("the program ran past its end");
}

test.each([
  { arch: "x64", audit: 0xc000003e, socket: 41, socketpair: 53, foreign: 0x40000003 },
  { arch: "arm64", audit: 0xc00000b7, socket: 198, socketpair: 199, foreign: 0x40000028 },
])(
  "the Git seccomp filter refuses every way to a Unix socket it can see ($arch)",
  ({ arch, audit, ...nr }) => {
    const [ALLOW, EACCES, ENOSYS, KILL] = [0x7fff0000, 0x0005000d, 0x00050026, 0x80000000];
    const verdict = (call: number, domain = 0n, on: number = audit) =>
      seccompVerdict(seccompFilter(arch), on, call, domain);
    expect(verdict(nr.socket, 1n)).toBe(EACCES);
    expect(verdict(nr.socketpair, 1n)).toBe(EACCES);
    // The kernel reads the domain as an int, so high bits do not make it another family.
    expect(verdict(nr.socket, 0x1_0000_0001n)).toBe(EACCES);
    expect(verdict(nr.socket, 2n)).toBe(ALLOW);
    expect(verdict(nr.socketpair, 2n)).toBe(ALLOW);
    expect(verdict(0, 1n)).toBe(ALLOW);
    // io_uring creates sockets without a socket syscall the filter would see.
    expect(verdict(425)).toBe(ENOSYS);
    expect(verdict(nr.socket, 1n, nr.foreign)).toBe(KILL);
    if (arch === "x64") {
      // x32 calls report AUDIT_ARCH_X86_64 with bit 30 set in the number.
      expect(verdict(0x40000000 | nr.socket, 1n)).toBe(ENOSYS);
      expect(verdict(0x40000000 | nr.socketpair, 1n)).toBe(ENOSYS);
      expect(verdict(0x40000000)).toBe(ENOSYS);
    }
  },
);

test("the Git seccomp filter has no program for an unknown architecture", () => {
  expect(() => seccompFilter("riscv64")).toThrow("no Unix-socket filter");
});

test.skipIf(process.platform !== "linux")(
  "a Linux Git launch keeps the payload's environment and cwd off bwrap and the launcher (needs linux)",
  async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const bwrap = join(root, "bwrap");
    writeFileSync(bwrap, "");
    const secret = `secret-${crypto.randomUUID()}`;
    const env = { ...agentEnv(), LD_PRELOAD: "/x.so", GIT_AUTHOR_NAME: secret };
    const probes: { env?: Record<string, string>; cwd: string }[] = [];
    const run = (async (cmd: string[], opts: { env?: Record<string, string>; cwd: string }) => {
      probes.push(opts);
      return { exitCode: 0, stdout: `${realpathSync(root)}\n`, stderr: "", cmd } as unknown as ProcResult;
    }) as never;
    const launch = await invocationScratch.run(root, () =>
      bwrapGit("linux", bwrap, run).wrap(["git", "status"], { cwd: repo, env }),
    );
    for (const started of [...probes, launch]) {
      expect(started.cwd).toBe("/");
      expect(Object.keys(started.env ?? {}).sort()).toEqual([PAYLOAD_ENV, "PATH"]);
    }
    // The cached installation probe gets a fixed environment; the command gets the caller's.
    expect(probes).toHaveLength(1);
    expect(JSON.parse(probes[0]?.env?.[PAYLOAD_ENV] ?? "")).toEqual({ PATH: "/usr/bin:/bin" });
    expect(JSON.parse(launch.env[PAYLOAD_ENV] ?? "")).toEqual(env);
    expect(launch.cmd.join("\0")).not.toContain(secret);
    expect(launch.cmd.slice(launch.cmd.indexOf("--git") + 1)[0]).toBe(repo);
    expect(launch.cmd.slice(-2)).toEqual([expect.stringMatching(/^--exec-path=/), "status"]);
  },
);

test("bwrap and launcher stderr is a confinement failure on Linux only", () => {
  for (const stderr of ["bwrap: x", "landlock: Landlock is unavailable"]) {
    const failed = { exitCode: 125, stderr };
    expect(() => checkApply(failed, "linux")).toThrow(ConfinementError);
    expect(() => checkApply(failed, "darwin")).not.toThrow();
  }
  expect(() => checkApply({ exitCode: 128, stderr: "fatal: not a git repository" }, "linux")).not.toThrow();
});

test.skipIf(process.platform !== "linux")(
  "verifyLinux reports a leak before a cancellation and releases everything when setup fails (needs linux)",
  async () => {
    const { work, roots } = layout();
    const bwrap = join(root, "bwrap");
    writeFileSync(bwrap, "");
    const controller = new AbortController();
    const leakyThenAborted = async ({ cmd }: { cmd: string[] }) => {
      if (cmd[0] !== "/bin/sh") return result("landlock-verified");
      writeFileSync(cmd[6] ?? "", "leaked");
      controller.abort(new Error("cancelled"));
      return result("linux-verified");
    };
    await expect(
      verifyLinux(roots, { signal: controller.signal }, leakyThenAborted as never, bwrap),
    ).rejects.toThrow(ConfinementError);

    // The network probe's report of a leak is evidence too, even when shutdown then killed it; a cancel
    // without that report is still a cancellation.
    const killed = { exitCode: null, signal: "SIGKILL", cancelled: true, cancelKilled: true };
    const networkThenAborted =
      (signal: AbortController, stderr: string) =>
      async ({ cmd }: { cmd: string[] }) => {
        if (cmd[0] === "/bin/sh") {
          writeFileSync(cmd[5] ?? "", "ok");
          return result("linux-verified");
        }
        signal.abort(new Error("cancelled"));
        return { ...result(""), ...killed, stderr } as ProcResult;
      };
    const leak = new AbortController();
    await expect(
      verifyLinux(
        roots,
        { signal: leak.signal },
        networkThenAborted(leak, "landlock: reached daemon port\n") as never,
        bwrap,
      ),
    ).rejects.toThrow("Network and signal confinement not verified");
    const cancel = new AbortController();
    await expect(
      verifyLinux(roots, { signal: cancel.signal }, networkThenAborted(cancel, "") as never, bwrap),
    ).rejects.toThrow("cancelled");

    const before = readdirSync(work);
    const real = Bun.listen;
    let calls = 0;
    const listener = { stopped: false };
    const spy = spyOn(Bun, "listen").mockImplementation(((options: Parameters<typeof Bun.listen>[0]) => {
      if (++calls === 2) throw new Error("EMFILE");
      const first = real(options);
      const stop = first.stop.bind(first);
      first.stop = (force?: boolean) => {
        listener.stopped = true;
        return stop(force);
      };
      return first;
    }) as typeof Bun.listen);
    try {
      await expect(verifyLinux(roots, {}, async () => result(""), bwrap)).rejects.toThrow(ConfinementError);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(work)).toEqual(before);
    expect(listener.stopped).toBe(true);
  },
);

test.skipIf(bwrapSkip !== null)(
  `nothing from the payload's environment or the checkout runs before confinement (${bwrapSkip})`,
  async () => {
    const { work, roots } = layout();
    const marker = join(root, "preload-ran");
    const preload = join(root, "preload.js");
    writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
    // A hostile checkout: a bunfig.toml preload in the payload's cwd, and one in its environment.
    writeFileSync(join(work, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
    const run = await runSandboxed(
      {
        cmd: ["/bin/sh", "-c", 'pwd; echo "$KEEP"; test -n "$LIMITLESS_INVOCATION" && echo marked'],
        cwd: work,
        env: { ...agentEnv(), BUN_OPTIONS: `--preload ${preload}`, BUN_BE_BUN: "1", KEEP: "it's here" },
      },
      roots,
      undefined,
      undefined,
      linuxForPort(0),
    );
    expect(existsSync(marker)).toBe(false);
    expect(run.stdout.trim().split("\n")).toEqual([work, "it's here", "marked"]);
  },
);

test.skipIf(bwrapSkip !== null)(
  `confined Git cannot connect to a host Unix socket (${bwrapSkip})`,
  async () => {
    const repo = join(root, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    let connections = 0;
    const server = Bun.listen({
      unix: join(repo, "s.sock"),
      socket: { open: () => void connections++, data() {} },
    });
    try {
      const git = await gitConfinement.run(bwrapGit(), () =>
        gitSh(["git", "credential-cache", `--socket=${join(repo, "s.sock")}`, "get"], {
          cwd: repo,
          env: agentEnv(),
          stdin: "protocol=https\nhost=example.com\n\n",
          allowFail: true,
        }),
      );
      expect(git.exitCode).not.toBe(0);
    } finally {
      server.stop(true);
    }
    expect(connections).toBe(0);
  },
);

test.skipIf(bwrapSkip !== null)(
  `nothing from the payload's environment runs before Git confinement, and git still gets it (${bwrapSkip})`,
  async () => {
    const repo = join(root, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const debug = join(repo, "loader");
    mkdirSync(debug);
    // glibc's loader writes LD_DEBUG_OUTPUT.<pid>, naming the program it loads for, in every dynamically
    // linked process that inherits it. The directory is writable inside and outside the sandbox alike.
    const env = {
      ...agentEnv(),
      LD_DEBUG: "files",
      LD_DEBUG_OUTPUT: join(debug, "ld"),
      GIT_AUTHOR_NAME: "Kept",
      GIT_AUTHOR_EMAIL: "kept@example.com",
    };
    const git = await gitConfinement
      .run(bwrapGit(), () => gitSh(["git", "var", "GIT_AUTHOR_IDENT"], { cwd: repo, env, allowFail: true }))
      .catch((error) => error as Error);
    const loaded = new Set(
      readdirSync(debug).flatMap((file) =>
        [...readFileSync(join(debug, file), "utf8").matchAll(/needed by (\S+)/g)].map((m) => m[1]),
      ),
    );
    // The installation probe and the command itself: git, and nothing that ran before confinement.
    expect([...loaded]).toEqual([realpathSync(Bun.which("git") ?? "git")]);
    expect(git instanceof Error ? git.message : git.stdout).toContain("Kept <kept@example.com>");
  },
);

test.skipIf(bwrapSkip !== null)(
  `a shadowed directory keeps its entries and hides a denied path the host creates later (${bwrapSkip})`,
  async () => {
    const { home, tool, work } = layout();
    symlinkSync("tool", join(home, "link"));
    const denied = join(home, "missing");
    const script = `echo ready > ready; i=0; while [ ! -e go ]; do i=$((i+1)); [ "$i" -lt 3000 ] || exit 9; sleep .01; done
      echo $(ls '${home}')
      readlink '${home}/link'
      ls '${tool}' >/dev/null && echo toolchain
      if head -c 1 '${denied}' >/dev/null 2>&1; then echo leaked; else echo hidden; fi
      if touch '${home}/new' 2>/dev/null; then echo writable; else echo read-only; fi`;
    const sandbox = runProcess({
      cmd: [
        BWRAP,
        ...["--unshare-user", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"],
        ...shadow(home),
        ...["--bind", work, work, "--remount-ro", home, "--chdir", work, "--", "/bin/sh", "-c", script],
      ],
      cwd: work,
      env: agentEnv(),
      timeoutMs: 60_000,
    });
    for (let i = 0; !existsSync(join(work, "ready")); i++) {
      if (i > 3000) throw new Error("the sandbox never became ready");
      await Bun.sleep(10);
    }
    writeFileSync(denied, "secret");
    writeFileSync(join(work, "go"), "");
    const run = await sandbox;
    expect(run.stdout.trim().split("\n"), run.stderr).toEqual([
      "credential link tool work",
      "tool",
      "toolchain",
      "hidden",
      "read-only",
    ]);
    expect(existsSync(join(home, "new"))).toBe(false);
  },
);
