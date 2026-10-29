import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { worktreeGit } from "../src/git/command.ts";
import {
  bwrapGit,
  checkApply,
  elfInterpreter,
  gitBwrapArgs,
  gitConfinement,
  gitSh,
} from "../src/git/confinement.ts";
import { bwrapOptions, landlockCommand, PAYLOAD_ENV, seccompFilter } from "../src/harness/landlock.ts";
import { configureReadPolicy, readPolicyScope } from "../src/harness/read-policy.ts";
import { ConfinementError, platformConfinement, runSandboxed, SANDBOX_EXEC } from "../src/harness/sandbox.ts";
import { BWRAP, bwrapArgs, linuxForPort, shadow, verifyLinux } from "../src/harness/sandbox-linux.ts";
import { type WriteRoots, writeRoots } from "../src/harness/scratch.ts";
import { agentEnv, invocationScratch, type ProcResult, runProcess, sh } from "../src/util/proc.ts";
import { bwrapProbeSkip, bwrapSkip } from "./confinement.ts";
import { seeded } from "./seeded.ts";

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
  const args = bwrapArgs(roots, sources);
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

test.skipIf(bwrapSkip !== null)(
  `the bwrap skip probe detects a binary without fd binds (${bwrapSkip})`,
  async () => {
    const wrapper = join(root, "old-bwrap");
    const marker = join(root, "probe-args");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > '${marker.replaceAll("'", "'\\''")}'
[[ " $* " != *" --ro-bind-fd "* ]]
`,
      { mode: 0o755 },
    );
    expect(await bwrapProbeSkip(wrapper)).toContain("--ro-bind-fd");
    expect(readFileSync(marker, "utf8").split("\n")).toContain("--ro-bind-fd");
  },
);

test("platformConfinement keeps Seatbelt off Linux and runs bwrap behind the Landlock launcher on Linux", () => {
  const { roots } = layout();
  const cmd = ["/bin/true"];
  expect(platformConfinement(7, "darwin").wrap(cmd, roots)[0]).toBe(SANDBOX_EXEC);
  const linux = platformConfinement(7, "linux").wrap(cmd, roots);
  const launcherEnd = linux.indexOf("--bwrap");
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
    // A bwrap without descriptor binds names the requirement.
    const old = (cmd: string[]) =>
      cmd[0] === "/bin/sh"
        ? { ...result("", 1), stderr: "bwrap: Unknown option --ro-bind-fd\n" }
        : result("");
    await expect(verify(old)).rejects.toThrow("has no --ro-bind-fd: install bubblewrap 0.10 or later");
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
    // The ELF loader runs whatever an exec transport names, from the command line or repository config.
    const loader = elfInterpreter(realpathSync(Bun.which("git") ?? "git")) ?? "";
    const touch = (name: string) => `ext::${loader} ${Bun.which("touch")} ${join(repo, name)}`;
    await git(["-c", "protocol.ext.allow=always", "ls-remote", touch("ext-cmdline")]);
    await git(["config", "protocol.ext.allow", "always"]);
    await git(["config", "remote.x.url", touch("ext-config")]);
    expect((await git(["fetch", "x"])).stderr).toContain("transport 'ext' not allowed");
    for (const marker of ["ext-cmdline", "ext-config"]) expect(existsSync(join(repo, marker))).toBe(false);
    // Bundles, which workers fetch, still work.
    expect((await git(["bundle", "create", join(repo, "b.bundle"), "HEAD"])).exitCode).toBe(0);
    expect((await git(["fetch", "-q", join(repo, "b.bundle"), "HEAD"])).exitCode).toBe(0);
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

const loaderFixture = seeded(async (dir) => {
  const repo = join(dir, "repo");
  await sh(["git", "init", "-qb", "main", repo], { cwd: dir });
  // No arguments needed: both the editor's message file and textconv's temporary blob are ELF.
  const source = join(dir, "payload.c");
  writeFileSync(
    source,
    '#include <stdio.h>\nint main(void) { FILE *f = fopen("payload-ran", "w"); if (f) fclose(f); return 0; }\n',
  );
  await sh(["cc", "-o", "payload", source], { cwd: repo });
  writeFileSync(join(repo, ".gitattributes"), "payload diff=x\n");
  writeFileSync(join(repo, ".git/info/attributes"), "payload diff=x\n");
  await sh(["git", "add", "."], { cwd: repo });
  await sh(["git", "commit", "-qm", "payload"], { cwd: repo });
});

test.each(["2028", "2029"])(
  "Linux Git blanks textconv drivers whose names contain Unicode separators (U+%s)",
  async (separator) => {
    await sh(["git", "init", "-q"], { cwd: root });
    const driver = `x${String.fromCodePoint(Number.parseInt(separator, 16))}y`;
    writeFileSync(join(root, ".git/info/attributes"), `payload diff=${driver}\n`);
    await sh(["git", "config", `diff.${driver}.textconv`, "touch textconv-ran"], { cwd: root });
    const blob = await sh(["git", "hash-object", "-w", "--stdin"], { cwd: root, stdin: "payload" });
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) throw new Error("Missing process platform descriptor");
    try {
      // Exercise Linux's config discovery on macOS too; the identity backend isolates Git overrides.
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await gitConfinement.run({ wrap: async (cmd) => cmd }, () =>
        worktreeGit(["git", "cat-file", "--textconv", "--path=payload", blob.stdout.trim()], {
          cwd: root,
          env: agentEnv(),
          allowFail: true,
        }),
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(existsSync(join(root, "textconv-ran"))).toBe(false);
  },
);

for (const confined of [false, true])
  for (const route of ["editor", "show", "cat-file", ...(!confined ? ["cat-file-fallback"] : []), "ssh-key"])
    test.skipIf(process.platform !== "linux" || (confined && bwrapSkip !== null))(
      `Linux Git blocks the loader ${route} route (${confined ? `real bwrap: ${bwrapSkip}` : "portable launch"})`,
      async () => {
        await loaderFixture(root);
        const repo = join(root, "repo");
        const loader = elfInterpreter(realpathSync(Bun.which("git") ?? "git"));
        if (!loader) throw new Error("Git has no ELF interpreter");
        const fallback = route === "cat-file-fallback";
        const env: Record<string, string> = { ...agentEnv(), GIT_EDITOR: loader };
        if (fallback) {
          // Config-file discovery is cached by environment, so earlier routes must not supply it.
          env.GIT_CONFIG_GLOBAL = join(root, "fallback-config");
          writeFileSync(env.GIT_CONFIG_GLOBAL, "");
        }
        let configFileQueries = 0;
        let fallbackQueries = 0;
        const backend = bwrapGit("linux", process.execPath, async () =>
          sh(["git", "--exec-path"], { cwd: root }),
        );
        const portable = {
          async wrap(cmd: string[], opts: Parameters<typeof sh>[1]) {
            // Git 2.40 lacks the config-file queries; exercise the uncached key-discovery path too.
            if (fallback && cmd.includes("var")) {
              configFileQueries++;
              cmd = ["git", "var", "UNKNOWN"];
            }
            if (cmd.includes("--get-regexp")) fallbackQueries++;
            const launch = await backend.wrap(cmd, opts);
            // Exercise the production payload argv/environment with real Git, without namespaces.
            return {
              cmd: launch.cmd.slice(launch.cmd.indexOf("--") + 1),
              env: JSON.parse(launch.env[PAYLOAD_ENV] ?? "{}") as Record<string, string>,
              cwd: opts.cwd,
            };
          },
        };
        const configs = [
          // bwrap hides setup.ts's temporary global config. Without an explicit identity, commit
          // aborts before reaching the editor or signing, and a missing marker proves nothing.
          "user.name=Test",
          "user.email=test@example.invalid",
          `core.editor=${loader}`,
          `commit.template=${join(repo, "payload")}`,
          "commit.status=false",
          `diff.x.textconv=${loader}`,
          "gpg.format=ssh",
          `gpg.ssh.defaultKeyCommand=${loader} ${join(repo, "payload")}`,
        ].flatMap((value) => ["-c", value]);
        const args =
          route === "editor"
            ? ["commit", "--allow-empty"]
            : route === "ssh-key"
              ? ["commit", "--allow-empty", "-S", "-m", "signed"]
              : route === "show"
                ? ["show", "HEAD"]
                : ["cat-file", "--textconv", "HEAD:payload"];
        const result = await gitConfinement.run(confined ? bwrapGit() : portable, () =>
          worktreeGit(["git", ...configs, ...args], {
            cwd: repo,
            env,
            allowFail: true,
          }),
        );
        if (fallback) {
          expect(configFileQueries).toBe(2);
          expect(fallbackQueries).toBe(1);
        }
        expect(existsSync(join(repo, "payload-ran"))).toBe(false);
        if (route === "editor") {
          expect(readFileSync(join(repo, ".git/COMMIT_EDITMSG"))).toEqual(
            readFileSync(join(repo, "payload")),
          );
          expect(result.stderr).toContain("editor '/dev/null'");
        }
        if (route === "show") expect(result.exitCode).toBe(0);
        else expect(result.exitCode).not.toBe(0);
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
  const shadowed = bwrapArgs(absent, sources, ["/run"]);
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
  const privateRoot = bwrapArgs(absent, sources, [root]);
  expect(bwrapOptions([...privateRoot, "--"]).options).toContainEqual(["--tmpfs", root]);
  expect(privateRoot).not.toContain("--ro-bind-try");
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

test("review: a later nested shadow cannot restore an earlier excluded missing subtree", () => {
  const home = join(root, "home");
  mkdirSync(home);
  const config = join(home, ".config");
  const hosts = join(config, "gh/hosts.yml");
  const sources = { dir: join(root, "mask-dir"), file: join(root, "mask-file") };
  const realpath = fs.realpathSync;
  let created = false;
  const spy = spyOn(fs, "realpathSync").mockImplementation(((path: string, options: never) => {
    const value = realpath(path, options);
    // The first absent deny records home/.config as its first missing component;
    // the next deny now observes .config as an existing ancestor.
    if (path === home && !created) {
      created = true;
      mkdirSync(dirname(hosts), { recursive: true });
      writeFileSync(hosts, "secret");
    }
    return value;
  }) as typeof fs.realpathSync);
  let args: string[] = [];
  try {
    args = bwrapArgs({ write: [], protect: [], denyRead: [hosts, join(config, "missing")] }, sources, []);
  } finally {
    spy.mockRestore();
  }
  expect(created).toBe(true);
  const at = (...seq: string[]) => args.findIndex((_, n) => seq.every((v, k) => args[n + k] === v));
  expect(at("--tmpfs", home)).toBeGreaterThan(0);
  expect(at("--ro-bind-try", config, config)).toBe(-1);
  // Home's tmpfs already hides .config, so no second shadow is mounted over it.
  expect(at("--tmpfs", config)).toBe(-1);
  expect(at("--ro-bind", sources.file, hosts)).toBe(-1);
  expect(at("--ro-bind-try", join(config, "gh"), join(config, "gh"))).toBe(-1);
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
    const env = {
      ...agentEnv(),
      LD_PRELOAD: "/x.so",
      GIT_AUTHOR_NAME: secret,
      GIT_ALLOW_PROTOCOL: "ext:file",
      GIT_EDITOR: "/editor",
      GIT_SEQUENCE_EDITOR: "/sequence-editor",
      GIT_ASKPASS: "/askpass",
      SSH_ASKPASS: "/ssh-askpass",
    };
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
    // Only local transports: an exec transport could start the loader with any program (#867).
    expect(JSON.parse(launch.env[PAYLOAD_ENV] ?? "")).toEqual({
      ...env,
      GIT_ALLOW_PROTOCOL: "file",
      GIT_EDITOR: "/dev/null",
      GIT_SEQUENCE_EDITOR: "/dev/null",
      GIT_ASKPASS: "/dev/null",
      SSH_ASKPASS: "/dev/null",
    });
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

const within = (parent: string, path: string) =>
  path === parent || path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/**
 * The denied paths a sandbox built from `args` lets a process read, judged from the host as it is when bwrap
 * runs: the last mount at or above a path decides what is there, a mask or a tmpfs shows nothing, and a bind
 * shows its source's file at the same offset. As in the launcher, a bind source that is gone or reached
 * through a symlink is skipped for `-try` and ends the launch otherwise.
 */
function readableDenies(args: string[], masks: string[], denied: string[]): string[] {
  const symlinkFree = (path: string) => {
    try {
      return realpathSync(path) === path;
    } catch {
      return false;
    }
  };
  const mounts: { at: string; from?: string }[] = [];
  for (const [option = "", a = "", b = ""] of bwrapOptions([...args, "--"]).options) {
    if (option === "--tmpfs") mounts.push({ at: a });
    else if (option === "--symlink") mounts.push({ at: b, from: "" });
    else if (option.includes("bind") && option !== "--ro-bind-data") {
      if (masks.includes(a)) mounts.push({ at: b });
      else if (symlinkFree(a)) mounts.push({ at: b, from: a });
      else if (!option.endsWith("-try")) return [];
    }
  }
  return denied.filter((path) => {
    if (!existsSync(path)) return false;
    const real = realpathSync(path);
    const last = mounts.findLast((m) => within(m.at, real));
    if (last?.from === undefined) return false;
    return last.from === "" || existsSync(join(last.from, relative(last.at, real)));
  });
}

/** Builds a plan; a refusal is a pass, and a plan must leave every denied path unreadable after `after`. */
function expectNothingReadable(build: () => string[], denied: string[], after = () => {}): string[] | null {
  const masks = [join(root, "mask-dir"), join(root, "mask-file")];
  let args: string[] | null = null;
  try {
    args = build();
  } catch (error) {
    if (!(error instanceof ConfinementError)) throw error;
  }
  after();
  if (args) expect(readableDenies(args, masks, denied)).toEqual([]);
  return args;
}

test.each([false, true])("review: symlinked deny parent swaps (existing=%s)", (existing) => {
  const home = join(root, "home");
  const [old, next, alias] = [join(home, "old"), join(home, "next"), join(home, "config")];
  for (const dir of [old, next]) mkdirSync(dir, { recursive: true });
  symlinkSync("old", alias);
  const denied = join(alias, "secret");
  if (existing) writeFileSync(denied, "secret");
  const realpath = fs.realpathSync;
  let swapped = false;
  const spy = spyOn(fs, "realpathSync").mockImplementation(((path: string, options: never) => {
    const result = realpath(path, options);
    if (path === (existing ? denied : alias) && !swapped) {
      swapped = true;
      rmSync(alias);
      symlinkSync("next", alias);
    }
    return result;
  }) as typeof fs.realpathSync);
  expectNothingReadable(
    () => {
      try {
        return bwrapArgs(
          { write: [], protect: [], denyRead: [denied] },
          { dir: join(root, "mask-dir"), file: join(root, "mask-file") },
          [],
        );
      } finally {
        spy.mockRestore();
      }
    },
    [denied],
    () => {
      expect(swapped).toBe(true);
      writeFileSync(denied, "secret");
    },
  );
});

test("a denied symlink is refused even if the host removes it after resolution", () => {
  const target = join(root, "target");
  const denied = join(root, "alias");
  writeFileSync(target, "secret");
  symlinkSync("target", denied);
  const realpath = fs.realpathSync;
  const spy = spyOn(fs, "realpathSync").mockImplementation(((path: string, options: never) => {
    const real = realpath(path, options);
    if (path === denied && existsSync(denied)) rmSync(denied);
    return real;
  }) as typeof fs.realpathSync);
  try {
    expect(() => bwrapArgs({ write: [], protect: [], denyRead: [denied] }, undefined, [])).toThrow(
      `Cannot confine ${denied}: denied pathname resolves through a symlink`,
    );
  } finally {
    spy.mockRestore();
  }
});

test("a dangling denied symlink is refused without rejecting an ordinary absent path", () => {
  const denied = join(root, "alias");
  symlinkSync("missing", denied);
  const roots: WriteRoots = { write: [], protect: [], denyRead: [denied] };
  expect(() => bwrapArgs(roots, undefined, [])).toThrow(
    `Cannot confine ${denied}: denied pathname goes through a symlink at ${denied}`,
  );
  rmSync(denied);
  expect(() => bwrapArgs(roots, undefined, [])).not.toThrow();
});

test("the destination restriction follows an earlier protected bind's own parent", () => {
  const work = join(root, "work");
  const protectedDir = join(work, "sub", "protected");
  const denied = join(protectedDir, "secret");
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(denied, "secret");
  expect(() =>
    bwrapArgs({ write: [work], protect: [protectedDir], denyRead: [denied] }, undefined, []),
  ).toThrow(
    `Cannot confine ${denied}: destination parent ${join(work, "sub")} beneath live bind ${work} can be replaced by the host`,
  );
});

test("a readonly toolchain bind with an intermediate destination parent is refused", () => {
  const { tool, roots } = layout();
  const denied = join(tool, "sub", "secret");
  mkdirSync(dirname(denied));
  writeFileSync(denied, "secret");
  expect(() => bwrapArgs({ ...roots, denyRead: [...(roots.denyRead ?? []), denied] }, undefined, [])).toThrow(
    `Cannot confine ${denied}: destination parent ${dirname(denied)} beneath live bind ${tool} can be replaced by the host`,
  );
});

test("a tmpfs hiding a deny beneath a live bind cannot use a replaceable destination", () => {
  const work = join(root, "work");
  const commands = join(work, "commands");
  const denied = join(commands, "secret");
  mkdirSync(commands, { recursive: true });
  writeFileSync(denied, "secret");
  expect(() =>
    bwrapArgs(
      { write: [work], protect: [], denyRead: [denied], commands: { root: [commands], own: [] } },
      undefined,
      [],
    ),
  ).toThrow(
    `Cannot confine ${denied}: destination parent ${commands} beneath live bind ${work} can be replaced by the host`,
  );
});

test("unrelated symlinks and a direct child of a pinned write root stay supported", () => {
  const work = join(root, "work");
  mkdirSync(work);
  const denied = join(work, "secret");
  writeFileSync(denied, "secret");
  symlinkSync("secret", join(work, "unrelated"));
  expect(() => bwrapArgs({ write: [work], protect: [], denyRead: [denied] }, undefined, [])).not.toThrow();
});

test("review: a host rename while the plan is built cannot bind a missing denied path back under a write root", () => {
  // Round 5 of #841: the deny's lookup sees config moved away after the write root was resolved.
  const config = join(root, "home", "config");
  const [work, secret] = [join(config, "work"), join(config, "work", "secret")];
  mkdirSync(work, { recursive: true });
  const realpath = fs.realpathSync;
  let calls = 0;
  const spy = spyOn(fs, "realpathSync").mockImplementation(((path: string, options: never) => {
    if (path === work && ++calls === 2) renameSync(config, `${config}.away`);
    return realpath(path, options);
  }) as typeof fs.realpathSync);
  const sources = { dir: join(root, "mask-dir"), file: join(root, "mask-file") };
  const args = expectNothingReadable(
    () => {
      try {
        return bwrapArgs({ write: [work], protect: [], denyRead: [secret] }, sources, []);
      } finally {
        spy.mockRestore();
      }
    },
    [secret],
    () => {
      renameSync(`${config}.away`, config);
      writeFileSync(secret, "secret");
    },
  );
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(args).toBeNull();
});

test("whatever the host changes while the plan is built, a plan leaves every denied path unreadable", () => {
  const seed = Number(process.env.LIMITLESS_RACE_SEED ?? Math.floor(Math.random() * 2 ** 31));
  let state = seed;
  // mulberry32: a small seeded generator, so a failure can be replayed.
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
  const sources = { dir: join(root, "mask-dir"), file: join(root, "mask-file") };
  const spied = {
    realpathSync: fs.realpathSync,
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    readlinkSync: fs.readlinkSync,
  } as const;
  let built = 0;
  for (let i = 0; i < 1000; i++) {
    const home = join(root, `run-${i}`, "home");
    const dirs = ["config/work", "config/gh", "proj", ".ssh", "data"].map((d) => join(home, d));
    for (const dir of [...dirs, join(root, `scratch-${i}`)]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, ".ssh", "id"), "secret");
    const pool = [
      ".ssh",
      ".netrc",
      "config/gh/hosts.yml",
      "config/work/secret",
      "data/cache/token",
      "proj/.env",
    ];
    const denied = pool.filter(() => random() < 0.5).map((p) => join(home, p));
    const moved = [...dirs, join(home, "config"), join(home, "data", "cache")];
    const mutate = () => {
      const dir = pick(moved);
      const file = pick(denied.length ? denied : [join(home, ".netrc")]);
      const action = pick(["away", "back", "mkdir", "create", "remove"]);
      try {
        if (action === "away") renameSync(dir, `${dir}.away`);
        else if (action === "back") renameSync(`${dir}.away`, dir);
        else if (action === "mkdir") mkdirSync(dir, { recursive: true });
        else if (action === "create") {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, "secret");
        } else rmSync(file, { force: true });
      } catch {
        // The path the step needed is not there right now: the host did something else.
      }
    };
    const spies = Object.entries(spied).map(([name, original]) =>
      spyOn(fs, name as keyof typeof spied).mockImplementation(((...args: never[]) => {
        if (random() < 0.25) mutate();
        return (original as (...values: never[]) => unknown)(...args);
      }) as never),
    );
    const roots: WriteRoots = {
      write: [pick([join(home, "config", "work"), join(home, "proj")]), join(root, `scratch-${i}`)],
      protect: [],
      denyRead: denied,
    };
    let args: string[] | null = null;
    try {
      args = bwrapArgs(roots, sources, []);
    } catch (error) {
      // A step that saw a path vanish mid-lookup fails the launch too.
      if (!(error instanceof ConfinementError) && !(error as NodeJS.ErrnoException).code) throw error;
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    if (!args) continue;
    built++;
    // Then the host creates every denied path it can.
    for (const file of denied) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        if (!existsSync(file)) writeFileSync(file, "secret");
      } catch {
        // An ancestor is now a file: the host cannot create this one.
      }
    }
    expect(readableDenies(args, [sources.dir, sources.file], denied), `seed ${seed}, run ${i}`).toEqual([]);
  }
  // The refusals must leave plans to check.
  expect(built, `seed ${seed}`).toBeGreaterThan(100);
});

test("bwrapOptions refuses an option it does not know rather than misreading the plan", () => {
  expect(bwrapOptions(["--tmpfs", "/x", "--ro-bind", "/a", "/b", "--", "--bind", "z"])).toEqual({
    options: [
      ["--tmpfs", "/x"],
      ["--ro-bind", "/a", "/b"],
    ],
    command: ["--", "--bind", "z"],
  });
  expect(() => bwrapOptions(["--bind-fd", "3", "/x", "--"])).toThrow("unexpected bwrap argument");
  expect(() => bwrapOptions(["--tmpfs"])).toThrow("unexpected bwrap argument");
});

test("ordinary layouts: canonical denies with a symlinked TMPDIR checkout, scratch and trusted sidecar", () => {
  const real = join(root, "real");
  mkdirSync(join(real, "home", ".ssh"), { recursive: true });
  writeFileSync(join(real, "home", ".ssh", "id"), "secret");
  const link = join(root, "tmp-link");
  symlinkSync(real, link);
  const home = join(link, "home");
  const [repo, work, scratch] = [join(home, "repo"), join(home, "work"), join(link, "scratch")];
  mkdirSync(scratch);
  const git = (...args: string[]) =>
    expect(Bun.spawnSync(["git", "-c", "user.name=n", "-c", "user.email=a@b", ...args]).exitCode).toBe(0);
  git("init", "-q", repo);
  git("-C", repo, "commit", "-q", "--allow-empty", "-m", "x");
  git("-C", repo, "worktree", "add", "-q", work);
  const gitDir = join(realpathSync(repo), ".git", "worktrees", "work");
  writeFileSync(`${work}.git-paths`, JSON.stringify([work, gitDir, join(realpathSync(repo), ".git")]));
  const policy = {
    ...configureReadPolicy(undefined, join(real, "config")),
    home: realpathSync(home),
    environment: {},
  };
  const roots = readPolicyScope.run(policy, () => writeRoots(work, scratch, true));
  const args = expectNothingReadable(
    () => bwrapArgs(roots, { dir: join(root, "mask-dir"), file: join(root, "mask-file") }, []),
    [...(roots.denyRead ?? []), join(home, ".ssh", "id")],
  );
  expect(args).toContain(realpathSync(work));
});

test.skipIf(bwrapSkip !== null)(
  `a denied file created during construction stays hidden in a real launch (${bwrapSkip})`,
  async () => {
    const home = join(root, "home");
    mkdirSync(home);
    const secret = join(home, "secret");
    const readdir = fs.readdirSync;
    let created = false;
    const spy = spyOn(fs, "readdirSync").mockImplementation(((path: string, options: never) => {
      const entries = readdir(path, options);
      if (path === home) {
        writeFileSync(secret, "secret");
        created = true;
      }
      return entries;
    }) as typeof fs.readdirSync);
    let args: string[];
    try {
      args = bwrapArgs({ write: [], protect: [], denyRead: [secret] }, undefined, ["/run"]);
    } finally {
      spy.mockRestore();
    }
    expect(created).toBe(true);
    const run = await runProcess({
      cmd: [
        ...landlockCommand(0),
        "--bwrap",
        BWRAP,
        ...args,
        "--",
        "/bin/sh",
        "-c",
        `if head -c 1 '${secret}' >/dev/null 2>&1; then echo leaked; else echo hidden; fi; echo ran`,
      ],
      cwd: "/",
      env: agentEnv(),
      timeoutMs: 30_000,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe("hidden\nran");
  },
);

test.skipIf(bwrapSkip !== null).each([false, true])(
  `review: destination parent swaps cannot redirect a hiding mount (tmpfs=%s, ${bwrapSkip})`,
  async (tmpfs) => {
    const work = join(root, "work");
    const [sub, other] = [join(work, "sub"), join(work, "other")];
    for (const dir of [sub, other]) {
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "nested", "secret"), "secret");
    }
    const secret = join(sub, "nested", "secret");
    const direct = join(work, "direct-secret");
    writeFileSync(direct, "secret");
    const safe = bwrapArgs({ write: [work], protect: [], denyRead: [direct] }, undefined, ["/run"]);
    const ordinary = await runProcess({
      cmd: [
        ...landlockCommand(0),
        "--bwrap",
        BWRAP,
        ...safe,
        "--",
        "/bin/sh",
        "-c",
        `if head -c 1 '${direct}' >/dev/null 2>&1; then echo leaked; else echo hidden; fi`,
      ],
      cwd: "/",
      env: agentEnv(),
      timeoutMs: 30_000,
    });
    expect(ordinary.exitCode, ordinary.stderr).toBe(0);
    expect(ordinary.stdout.trim()).toBe("hidden");
    let args: string[];
    try {
      args = bwrapArgs(
        {
          write: [work],
          protect: [],
          denyRead: [secret],
          ...(tmpfs ? { commands: { root: [join(sub, "nested")], own: [] } } : {}),
        },
        undefined,
        ["/run"],
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConfinementError);
      expect((error as Error).message).toContain(secret);
      expect((error as Error).message).toContain("destination parent");
      return;
    }
    // Restore the host's original directory after real bwrap finishes its mounts, before the
    // payload runs. The writable bind makes this restore shared. A refused plan above passes;
    // if the destination guard is removed, this real launch must still never read the secret.
    const wrapper = join(root, "bwrap-wrapper");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash
args=()
while [[ "$1" != -- ]]; do args+=("$1"); shift; done
shift
exec ${BWRAP} "\${args[@]}" -- /bin/sh -c 'rm "$1"; mv "$2" "$1"; shift 2; exec "$@"' sh "$RESTORE_SUB" "$RESTORE_AWAY" "$@"
`,
      { mode: 0o755 },
    );
    renameSync(sub, `${sub}.away`);
    symlinkSync("other", sub);
    const run = await runProcess({
      cmd: [
        ...landlockCommand(0),
        "--bwrap",
        wrapper,
        ...args,
        "--",
        "/bin/sh",
        "-c",
        `cat '${secret}'; echo leaked`,
      ],
      cwd: "/",
      env: { ...agentEnv(), RESTORE_SUB: sub, RESTORE_AWAY: `${sub}.away` },
      timeoutMs: 30_000,
    });
    expect(fs.lstatSync(sub).isDirectory(), run.stderr).toBe(true);
    expect(run.stdout).not.toContain("leaked");
    expect(run.exitCode).toBe(125);
  },
);

test.skipIf(bwrapSkip !== null)(
  `the launcher never follows a bind source the host swaps for a symlink after the plan is built (${bwrapSkip})`,
  async () => {
    const home = join(root, "home");
    const [tool, other, keys] = [join(home, "tool"), join(home, "other"), join(root, "keys")];
    for (const dir of [tool, other, keys]) mkdirSync(dir, { recursive: true });
    const secret = `secret-${crypto.randomUUID()}`;
    writeFileSync(join(keys, "key"), secret);
    const launch = (bind: string[]) =>
      runProcess({
        cmd: [
          ...landlockCommand(0),
          ...["--bwrap", BWRAP, "--unshare-user", "--ro-bind", "/", "/", "--tmpfs", home, ...bind],
          ...["--", "/bin/sh", "-c", `cat '${tool}/key' '${other}/key' 2>/dev/null; echo ran`],
        ],
        cwd: "/",
        env: agentEnv(),
        timeoutMs: 60_000,
      });
    const swap = (path: string) => {
      renameSync(path, `${path}.old`);
      symlinkSync(keys, path);
    };
    swap(tool);
    // A shadow's -try entry the host swapped is left out; a required source refuses the launch.
    const skipped = await launch(["--ro-bind-try", tool, tool, "--ro-bind", other, other]);
    expect(skipped.stdout.trim(), skipped.stderr).toBe("ran");
    swap(other);
    const refused = await launch(["--ro-bind-try", tool, tool, "--ro-bind", other, other]);
    expect(refused.stdout).not.toContain(secret);
    expect(refused.exitCode).toBe(125);
  },
);
