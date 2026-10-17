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
import { join, resolve } from "node:path";
import { emptyTreeId, stageAll, worktreeGit } from "../src/git/command.ts";
import { ConfinementError, gitConfinement, gitProfile, gitSh, seatbeltGit } from "../src/git/confinement.ts";
import {
  blobPrivateEntries,
  checkPrivateRange,
  commitAll,
  pushBranch,
  rebaseOnto,
} from "../src/git/repos.ts";
import { CommandError, invocationScratch, sh } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";
import { fakeGitConfinement } from "./git-preload.ts";
import { seeded } from "./seeded.ts";

setDefaultTimeout(30_000);
let root: string;
let cwd: string;
const git = (dir: string, ...args: string[]) => sh(["git", ...args], { cwd: dir });
const real = <T>(run: () => T) => gitConfinement.run(seatbeltGit(), run);
const wrap = (backend: ReturnType<typeof seatbeltGit>, cmd: string[], opts: Parameters<typeof sh>[1]) =>
  invocationScratch.run(root, () => backend.wrap(cmd, opts));
const fixture = seeded(async (dir) => {
  const source = join(dir, "source");
  mkdirSync(source);
  await git(source, "init", "-qb", "main");
  writeFileSync(join(source, "file"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "base");
});
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "git-confinement-"));
  await fixture(root);
  cwd = join(root, "source");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each(["linux", "missing", "apply"])(
  "confinement refuses %s before launching repository code",
  async (failure) => {
    const calls: string[][] = [];
    const run: typeof sh = async (cmd) => {
      calls.push(cmd);
      return { stdout: "", stderr: "unavailable", exitCode: 71 };
    };
    const backend = seatbeltGit(
      failure === "linux" ? "linux" : "darwin",
      failure === "missing" ? join(root, "absent") : process.execPath,
      run,
    );
    await expect(
      gitConfinement.run(backend, () => worktreeGit([process.execPath, "status"], { cwd })),
    ).rejects.toBeInstanceOf(ConfinementError);
    expect(calls.every((cmd) => !cmd.includes("status"))).toBe(true);
    if (failure !== "apply") expect(calls).toHaveLength(0);
  },
);

test("all auxiliary commands, inspection and clean retry use the injected backend", async () => {
  const calls: string[][] = [];
  let cleans = 0;
  await gitConfinement.run(
    {
      wrap: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes("clean") && cleans++ === 0) return ["git", "unknown-confinement-test-command"];
        return cmd;
      },
    },
    async () => {
      await worktreeGit(["git", "diff"], { cwd });
      await worktreeGit(["git", "merge", "HEAD"], { cwd });
      await worktreeGit(["git", "clean", "-ffdxq"], { cwd }, true);
    },
  );
  for (const command of ["config", "rev-parse", "diff", "ls-files", "ls-tree", "merge"])
    expect(calls.some((cmd) => cmd.includes(command))).toBe(true);
  expect(cleans).toBe(2);
});

test("profile restricts execution, writes and network with safely quoted paths", () => {
  const profile = gitProfile(["/tools/git"], "/tools/git-core", [realpathSync(cwd)]);
  expect(profile).toContain('(literal "/tools/git")');
  expect(profile).toContain('(subpath "/tools/git-core")');
  expect(profile).toContain("(deny network*)");
  expect(profile).toContain("(deny process-exec)");
  expect(profile).toContain("(deny file-write*)");
  expect(profile).not.toContain("/bin/sh");
  expect(() => gitProfile(['bad"path'], undefined, [])).toThrow(ConfinementError);
});

test("a subprocess without the test preload cannot select the fake backend", async () => {
  const module = resolve("src/git/confinement.ts");
  const result = await sh(
    [
      process.execPath,
      "--config=/dev/null",
      "--no-env-file",
      "-e",
      `
    import { gitSh, ConfinementError } from ${JSON.stringify(module)};
    try { const r = await gitSh(["git", "-c", "alias.attack=!touch marker", "attack"], {cwd: process.cwd(), allowFail:true});
      if(r.exitCode === 0) process.exit(2);
    } catch(e) { if (!(e instanceof ConfinementError)) throw e; }
  `,
    ],
    { cwd },
  );
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(cwd, "marker"))).toBe(false);
});

const binaries = [
  ...new Set(
    [
      Bun.which("git"),
      existsSync("/opt/homebrew/bin/git") ? "/opt/homebrew/bin/git" : null,
      existsSync("/usr/bin/git") ? "/usr/bin/git" : null,
    ].filter((path): path is string => path !== null),
  ),
];
for (const binary of binaries) {
  test.skipIf(seatbeltSkip !== null)(
    `exec-path script interpreter is denied: ${binary} (${seatbeltSkip ?? "available"})`,
    async () => {
      const marker = join(root, "browser-marker");
      const args = [
        binary,
        "-c",
        "web.browser=attack",
        "-c",
        `browser.attack.cmd=printf pwn > '${marker}'; :`,
        "web--browse",
        "https://example.invalid",
      ];
      await sh(args, { cwd });
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      await real(async () => {
        expect((await gitSh([binary, "rev-parse", "HEAD"], { cwd })).exitCode).toBe(0);
        expect((await gitSh(args, { cwd, allowFail: true })).exitCode).not.toBe(0);
      });
      expect(existsSync(marker)).toBe(false);
    },
  );
  test.skipIf(seatbeltSkip !== null)(
    `derived profile allows git and denies shell execution: ${binary} (${seatbeltSkip ?? "available"})`,
    async () => {
      const backend = seatbeltGit();
      const wrapped = await wrap(backend, [binary, "rev-parse", "HEAD"], { cwd });
      const profile = wrapped[2] ?? "";
      expect(profile).toContain(`(literal "${realpathSync(binary)}")`);
      const execPath = realpathSync((await sh([binary, "--exec-path"], { cwd })).stdout.trim());
      expect(profile).toContain(`(subpath "${execPath}")`);
      await gitConfinement.run(backend, async () => {
        expect((await gitSh([binary, "rev-parse", "HEAD"], { cwd })).stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
        const marker = join(cwd, "marker");
        const result = await gitSh([binary, "-c", `alias.attack=!touch '${marker}'`, "attack"], {
          cwd,
          allowFail: true,
        });
        expect(result.exitCode).not.toBe(0);
        expect(existsSync(marker)).toBe(false);
        await expect(gitSh([binary, "rev-parse", "no-such-ref"], { cwd })).rejects.toBeInstanceOf(
          CommandError,
        );
        expect(
          (await gitSh([binary, "rev-parse", "no-such-ref"], { cwd, allowFail: true })).exitCode,
        ).not.toBe(0);
      });
    },
  );
}

// Internal dirty checks reach the nested repository's clean/process drivers. Checkout operations
// do not recurse into it (submodule.recurse=false), so its smudge and merge drivers are unreachable.
const shapes: [string, string[]][] = [
  ["status", ["status", "--porcelain"]],
  ["diff", ["diff"]],
  ["staging", []],
  ["commit", ["commit", "-am", "edit"]],
  ["empty commit", ["commit", "-m", "empty"]],
  ["merge", ["merge", "HEAD"]],
  ["rebase", ["rebase", "HEAD"]],
  ["checkout", ["checkout", "main"]],
  ["quiet checkout", ["checkout", "-q", "main"]],
  ["switch", ["switch", "main"]],
  ["quiet switch", ["switch", "-q", "main"]],
  ["reset", ["reset", "--hard", "HEAD"]],
  ["stash", ["stash"]],
  ["cherry-pick", ["cherry-pick", "HEAD"]],
  ["revert", ["revert", "--no-edit", "HEAD"]],
  ["empty cherry-pick", ["cherry-pick", "empty-commit"]],
  ["empty revert", ["revert", "--no-edit", "empty-commit"]],
  ["clean", ["clean", "-ffdxq"]],
];
async function nested(vector: string) {
  const dir = join(cwd, "nested");
  mkdirSync(dir);
  await git(dir, "init", "-qb", "main");
  writeFileSync(join(dir, "file"), "base\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "nested");
  writeFileSync(join(cwd, ".gitmodules"), '[submodule "nested"]\npath = nested\nignore = none\n');
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "gitlink");
  const empty = (await git(cwd, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "empty")).stdout.trim();
  await git(cwd, "tag", "empty-commit", empty);
  const marker = join(cwd, "marker");
  await git(dir, "config", `filter.attack.${vector}`, `touch '${marker}'; cat`);
  writeFileSync(join(dir, ".git/info/attributes"), "* filter=attack\n");
  utimesSync(join(dir, "file"), 1000, 1000);
  return marker;
}
for (const vector of ["clean", "process"]) {
  test.skipIf(seatbeltSkip !== null).each(shapes)(
    `${vector} nested driver blocked during %s (${seatbeltSkip ?? "available"})`,
    async (shape, args) => {
      const marker = await nested(vector);
      if (shape === "commit") writeFileSync(join(cwd, "file"), "edit\n");
      await real(async () => {
        if (shape === "staging") await stageAll({ cwd });
        else {
          try {
            await worktreeGit(["git", ...args], { cwd, allowFail: true });
          } catch (error) {
            if (
              !["merge", "rebase"].includes(shape) ||
              !(error instanceof Error) ||
              !error.message.includes("populated nested repository")
            )
              throw error;
          }
        }
      });
      expect(existsSync(marker)).toBe(false);
    },
  );
  test(`identity control: nested ${vector} executes on an empty commit`, async () => {
    const marker = await nested(vector);
    await gitConfinement.run(fakeGitConfinement, () =>
      worktreeGit(["git", "commit", "-m", "empty"], { cwd, allowFail: true }),
    );
    expect(existsSync(marker)).toBe(true);
  });
}

for (const confined of [false, true])
  test.skipIf(confined && seatbeltSkip !== null)(
    `local branch delivery uses bundle creation: ${confined ? "Seatbelt" : "fake"} (${seatbeltSkip ?? "available"})`,
    async () => {
      const work = join(root, "work");
      await git(cwd, "clone", "-q", cwd, work);
      writeFileSync(join(work, "file"), "delivered\n");
      await git(work, "commit", "-qam", "delivery");
      const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
      const marker = join(root, "hook");
      for (const repo of [cwd, work])
        for (const hook of ["pre-push", "pre-receive", "update", "reference-transaction"])
          writeFileSync(join(repo, ".git/hooks", hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      await git(work, "tag", "unwanted");
      await git(work, "notes", "add", "-m", "unwanted note");
      rmSync(marker, { force: true });

      await gitConfinement.run(confined ? seatbeltGit() : fakeGitConfinement, () =>
        pushBranch(
          {
            id: "local",
            slug: "owner/repo",
            kind: "local",
            localPath: cwd,
            url: null,
            defaultBranch: "main",
            mergePolicy: "pr",
            createdAt: 0,
          },
          work,
          "delivered",
        ),
      );
      expect((await git(cwd, "rev-parse", "refs/heads/delivered")).stdout.trim()).toBe(head);
      expect((await git(cwd, "tag", "--list")).stdout).toBe("");
      expect((await git(cwd, "for-each-ref", "refs/notes")).stdout).toBe("");
      expect(existsSync(marker)).toBe(false);
    },
  );

// These probes exercise the profile directly, independently of the older parent-config hardening.
for (const vector of ["clean", "smudge", "process", "fsmonitor", "signing", "merge"])
  for (const confined of [false, true]) {
    test.skipIf(confined && seatbeltSkip !== null)(
      `profile ${confined ? "blocks" : "control executes"} ${vector} (${seatbeltSkip ?? "available"})`,
      async () => {
        const marker = join(cwd, "marker");
        const helper = join(cwd, "helper");
        writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
        let args: string[];
        if (["clean", "smudge", "process"].includes(vector)) {
          await git(cwd, "config", `filter.attack.${vector}`, helper);
          writeFileSync(join(cwd, ".git/info/attributes"), "* filter=attack\n");
          args =
            vector === "smudge"
              ? ["checkout-index", "-f", "--all"]
              : ["hash-object", "--path=file", "--stdin"];
        } else if (vector === "fsmonitor") {
          await git(cwd, "config", "core.fsmonitor", helper);
          args = ["status", "--porcelain"];
        } else if (vector === "signing") {
          await git(cwd, "config", "gpg.program", helper);
          await git(cwd, "config", "commit.gpgSign", "true");
          args = ["commit", "--allow-empty", "-m", "signed"];
        } else {
          await git(cwd, "checkout", "-qb", "side");
          writeFileSync(join(cwd, "file"), "side\n");
          await git(cwd, "commit", "-qam", "side");
          await git(cwd, "checkout", "-q", "main");
          writeFileSync(join(cwd, "file"), "main\n");
          await git(cwd, "commit", "-qam", "main");
          writeFileSync(join(cwd, ".git/info/attributes"), "* merge=attack\n");
          await git(cwd, "config", "merge.attack.driver", helper);
          args = ["merge", "--no-edit", "side"];
        }
        await gitConfinement.run(confined ? seatbeltGit() : fakeGitConfinement, () =>
          gitSh(["git", ...args], { cwd, stdin: "base\n", allowFail: true }),
        );
        expect(existsSync(marker)).toBe(!confined);
      },
    );
  }

for (const confined of [false, true]) {
  test.skipIf(confined && seatbeltSkip !== null)(
    `a writer repopulating a gitlink after inspection: ${confined ? "Seatbelt" : "identity control"} (${seatbeltSkip ?? "available"})`,
    async () => {
      const marker = await nested("clean");
      const parked = join(root, "parked");
      const { renameSync } = await import("node:fs");
      renameSync(join(cwd, "nested"), parked);
      mkdirSync(join(cwd, "nested"));
      await git(cwd, "checkout", "-qb", "side");
      writeFileSync(join(cwd, "side"), "side\n");
      await git(cwd, "add", "side");
      await git(cwd, "commit", "-qm", "side");
      await git(cwd, "checkout", "-q", "main");
      await git(cwd, "commit", "--allow-empty", "-qm", "main");
      const start = join(root, "start");
      const ready = join(root, "ready");
      const stop = new AbortController();
      const writer = sh(
        [
          process.execPath,
          "--config=/dev/null",
          "--no-env-file",
          "-e",
          `
      import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
      while (!existsSync(${JSON.stringify(start)})) await Bun.sleep(5);
      rmSync(${JSON.stringify(join(cwd, "nested"))}, {recursive:true});
      renameSync(${JSON.stringify(parked)}, ${JSON.stringify(join(cwd, "nested"))});
      writeFileSync(${JSON.stringify(ready)}, "ready");
    `,
        ],
        { cwd: root, signal: stop.signal },
      );
      const backend = confined ? seatbeltGit() : fakeGitConfinement;
      try {
        await gitConfinement.run(
          {
            wrap: async (cmd, opts) => {
              if (cmd.includes("merge")) {
                writeFileSync(start, "start");
                const deadline = Date.now() + 5000;
                while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
                expect(existsSync(ready)).toBe(true);
                await writer;
              }
              return backend.wrap(cmd, opts);
            },
          },
          () => worktreeGit(["git", "merge", "--no-edit", "side"], { cwd, allowFail: true }),
        );
        expect(existsSync(marker)).toBe(!confined);
      } finally {
        stop.abort();
        await writer.catch(() => undefined);
      }
    },
  );
}

test("runtime allowances pin the resolved git, exec directory and canonical write roots", async () => {
  const binary = Bun.which("git");
  if (!binary) throw new Error("missing git");
  const execPath = realpathSync((await git(cwd, "--exec-path")).stdout.trim());
  const developer = join(root, "developer");
  mkdirSync(join(developer, "usr/bin"), { recursive: true });
  symlinkSync(realpathSync(binary), join(developer, "usr/bin/git"));
  const run: typeof sh = async (cmd, opts) => {
    expect(opts.env?.GIT_EXEC_PATH).toBeUndefined();
    return {
      stdout:
        cmd[0] === "/usr/bin/xcode-select"
          ? developer
          : cmd.includes("--exec-path")
            ? execPath
            : "git version",
      stderr: "",
      exitCode: 0,
    };
  };
  const wrapped = await wrap(seatbeltGit("darwin", process.execPath, run), ["git", "status"], {
    cwd,
    env: { ...process.env, GIT_EXEC_PATH: "/untrusted" },
  });
  const profile = wrapped[2] ?? "";
  expect(profile).toContain(`(literal "${realpathSync(binary)}")`);
  expect(profile).toContain(`(subpath "${execPath}")`);
  for (const path of [cwd, join(cwd, ".git"), root])
    expect(profile).toContain(`(subpath "${realpathSync(path)}")`);
  expect(profile).not.toContain("/untrusted");
  expect(wrapped).toContain(`--exec-path=${execPath}`);
});

test("write allowances follow Git's explicit directory options before inherited paths", async () => {
  const inherited = join(root, "inherited");
  const admin = join(root, "admin");
  const common = join(root, "common");
  const work = join(root, "work");
  const scratch = join(root, "scratch");
  for (const dir of [inherited, admin, common, work, scratch]) mkdirSync(dir);
  const execPath = realpathSync((await git(cwd, "--exec-path")).stdout.trim());
  const developer = join(root, "developer");
  mkdirSync(join(developer, "usr/bin"), { recursive: true });
  symlinkSync(realpathSync(Bun.which("git") ?? "git"), join(developer, "usr/bin/git"));
  const run: typeof sh = async (cmd) =>
    cmd[0] === "/usr/bin/xcode-select"
      ? { stdout: developer, stderr: "", exitCode: 0 }
      : { stdout: cmd.includes("--exec-path") ? execPath : "git version", stderr: "", exitCode: 0 };
  const wrapped = await invocationScratch.run(scratch, () =>
    seatbeltGit("darwin", process.execPath, run).wrap(
      [
        "git",
        `--git-dir=${inherited}`,
        `--git-dir=${admin}`,
        `--work-tree=${inherited}`,
        `--work-tree=${work}`,
        "status",
        "--",
        "--git-dir=filename",
        "--work-tree=filename",
      ],
      {
        cwd,
        env: {
          ...process.env,
          GIT_DIR: inherited,
          GIT_COMMON_DIR: common,
          GIT_WORK_TREE: inherited,
          TMPDIR: inherited,
        },
      },
    ),
  );
  const profile = wrapped[2] ?? "";
  for (const dir of [admin, common, work, scratch])
    expect(profile).toContain(`(subpath "${realpathSync(dir)}")`);
  expect(profile).not.toContain(`(subpath "${realpathSync(inherited)}")`);
  expect(profile.split("\n").find((line) => line.startsWith("(allow file-write*"))).toBe(
    `(allow file-write* ${[work, admin, common, scratch].map((dir) => `(subpath "${realpathSync(dir)}")`).join(" ")} (literal "/dev/null"))`,
  );
});

for (const confined of [false, true])
  test.skipIf(confined && seatbeltSkip !== null)(
    `factory commits and rebases succeed with global signing configured: ${confined ? "Seatbelt" : "fake"} (${seatbeltSkip ?? "available"})`,
    async () => {
      const marker = join(root, "signed");
      const signer = join(root, "signer");
      writeFileSync(signer, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
      const global = join(root, "global-config");
      writeFileSync(
        global,
        `[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${signer}\n[log]\n\tshowSignature = true\n`,
      );
      await git(cwd, "checkout", "-qb", "side");
      writeFileSync(join(cwd, "side"), "side\n");
      await git(cwd, "add", "side");
      await git(cwd, "commit", "-qm", "side");
      const base = (await git(cwd, "rev-parse", "main")).stdout.trim();
      const previous = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = global;
      try {
        await gitConfinement.run(confined ? seatbeltGit() : fakeGitConfinement, async () => {
          writeFileSync(join(cwd, "file"), "signed?\n");
          expect(await commitAll(cwd, "factory commit")).toMatch(/^[a-f0-9]{40}$/);
          await git(cwd, "checkout", "-q", "main");
          writeFileSync(join(cwd, "main"), "main\n");
          expect(await commitAll(cwd, "advance main")).toMatch(/^[a-f0-9]{40}$/);
          await git(cwd, "checkout", "-q", "side");
          expect(await rebaseOnto(cwd, "main")).toBe("clean");
          const log = await worktreeGit(["git", "log", "--format=%H", `${base}..HEAD`], { cwd });
          expect(log.stdout.trim().split("\n")).toHaveLength(3);
        });
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previous;
      }
      expect(existsSync(marker)).toBe(false);
    },
  );

test("every git process of a factory call, auxiliary ones included, runs through sandbox-exec", async () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "git.log");
  const failed = join(root, "clean-failed");
  const realGit = realpathSync(Bun.which("git") ?? "git");
  // Records which invocations reached git from inside the stand-in sandbox, failing the first clean.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\t%s\\n' "\${SANDBOXED:-0}" "$*" >> '${log}'\ncase "$*" in *" clean -ffdxq") [ -e '${failed}' ] || { : > '${failed}'; exit 1; } ;; esac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const sandbox = join(root, "sandbox-exec");
  writeFileSync(
    sandbox,
    `#!/bin/sh\n[ "$1" = -p ] || exit 71\ncase "$2" in *"(deny process-exec)"*) ;; *) exit 71 ;; esac\nshift 2\nSANDBOXED=1 exec "$@"\n`,
    { mode: 0o755 },
  );
  const env = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}` };
  const opts = { cwd, env };
  await gitConfinement.run(seatbeltGit("darwin", sandbox), async () => {
    writeFileSync(join(cwd, "added"), "added\n");
    await worktreeGit(["git", "status", "--porcelain"], opts);
    await worktreeGit(["git", "diff"], opts);
    await stageAll(opts);
    await worktreeGit(["git", "commit", "-qm", "added"], opts);
    await worktreeGit(["git", "commit", "-qm", "nothing staged"], { ...opts, allowFail: true });
    await worktreeGit(["git", "merge", "HEAD"], opts);
    await emptyTreeId(opts);
    await worktreeGit(["git", "clean", "-ffdxq"], opts, true);
  });
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls.filter((line) => !line.startsWith("1\t"))).toEqual([]);
  for (const command of ["config", "rev-parse", "ls-files", "ls-tree", "update-index", "commit", "merge"])
    expect(calls.some((line) => line.includes(` ${command} `))).toBe(true);
  expect(calls.filter((line) => line.endsWith(" clean -ffdxq"))).toHaveLength(2);
});

// Seatbelt can't nest, so running the child inside a sandbox makes confinement unavailable to it.
const unavailable =
  seatbeltSkip === null ? ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)"] : [];
const launch = (code: string, dir: string) =>
  sh([...unavailable, process.execPath, "--config=/dev/null", "--no-env-file", "-e", code], {
    cwd: dir,
    allowFail: true,
  });
const launchCode = (marker: string) => `
  import { worktreeGit } from ${JSON.stringify(resolve("src/git/command.ts"))};
  import { ConfinementError } from ${JSON.stringify(resolve("src/git/confinement.ts"))};
  try {
    await worktreeGit(["git", "commit", "-m", "empty"], { cwd: process.cwd(), allowFail: true });
    console.log("ran");
  } catch (error) {
    console.log(error instanceof ConfinementError ? "refused" : "other");
  }
  console.log(require("node:fs").existsSync(${JSON.stringify(marker)}) ? "marker" : "clean");
`;

test("a launch without the test preload refuses worktreeGit when confinement is unavailable", async () => {
  const marker = await nested("clean");
  const result = await launch(launchCode(marker), cwd);
  expect(result.stdout.trim().split("\n")).toEqual(["refused", "clean"]);
  expect(existsSync(marker)).toBe(false);
});

test.skipIf(seatbeltSkip !== null)(
  `a launch without the test preload confines worktreeGit (${seatbeltSkip ?? "available"})`,
  async () => {
    const marker = await nested("clean");
    const result = await sh(
      [process.execPath, "--config=/dev/null", "--no-env-file", "-e", launchCode(marker)],
      {
        cwd,
      },
    );
    expect(result.stdout.trim().split("\n")).toEqual(["ran", "clean"]);
  },
);

test("the private-strings script launched without the test preload refuses unconfined git", async () => {
  const script = resolve("scripts/check-private-strings.ts");
  const preloaded = await sh(
    [process.execPath, `--preload=${resolve("test/git-preload.ts")}`, script, "--record"],
    { cwd },
  );
  expect(preloaded.stdout.split("\n")[0]).toBe(realpathSync(cwd));
  const refused = await sh(
    [...unavailable, process.execPath, "--config=/dev/null", "--no-env-file", script, "--record"],
    {
      cwd,
      allowFail: true,
    },
  );
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stdout).toBe("");
});

test("private blob inspection and publication refuse configured promisor transports", async () => {
  const marker = join(root, "promisor-marker");
  const helper = join(root, "promisor-helper");
  writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  await git(cwd, "config", "remote.origin.promisor", "true");
  await git(cwd, "config", "remote.origin.url", `ext::${helper}`);
  await git(cwd, "config", "protocol.ext.allow", "always");
  const missing = "1234567890".repeat(4);
  await sh(["git", "cat-file", "--batch"], { cwd, stdin: `${missing}\n`, allowFail: true });
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  writeFileSync(join(cwd, "binary"), Buffer.from([0, 1, 2]));
  await git(cwd, "add", "binary");
  const calls: string[][] = [];
  await gitConfinement.run(
    {
      wrap: async (cmd, opts) => {
        if (cmd.includes("--batch")) {
          calls.push(cmd);
          expect(opts.stdin).toBeTruthy();
          throw new ConfinementError("test refusal");
        }
        return cmd;
      },
    },
    async () => {
      await expect(blobPrivateEntries(cwd, undefined, [missing], [])).rejects.toBeInstanceOf(
        ConfinementError,
      );
      await expect(checkPrivateRange(cwd, "HEAD", [], true)).rejects.toBeInstanceOf(ConfinementError);
    },
  );
  expect(calls).toHaveLength(2);
  expect(existsSync(marker)).toBe(false);
});

test("five identical wraps discover the exec directory once without an apply probe", async () => {
  const calls: string[][] = [];
  const run: typeof sh = async (cmd) => {
    calls.push(cmd);
    return { stdout: root, stderr: "", exitCode: 0 };
  };
  const backend = seatbeltGit("darwin", process.execPath, run);
  for (let i = 0; i < 5; i++) await wrap(backend, [process.execPath, "status"], { cwd });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--exec-path");
});

for (const allowFail of [false, true]) {
  for (const failure of ["apply", "apply-prefixed", "git", "same-code", "same-message"] as const) {
    test(`actual confined launch classifies ${failure}, allowFail=${allowFail}`, async () => {
      const executable = join(root, "sandbox-stand-in");
      const apply = "sandbox_" + "apply: Operation not permitted";
      const code = failure === "git" || failure === "same-message" ? 128 : 71;
      const message =
        failure === "apply-prefixed"
          ? `sandbox-exec: ${apply}`
          : failure === "apply" || failure === "same-message"
            ? apply
            : "git failure";
      writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${message}' >&2\nexit ${code}\n`, {
        mode: 0o755,
      });
      const run: typeof sh = async () => ({ stdout: root, stderr: "", exitCode: 0 });
      const call = () =>
        gitConfinement.run(seatbeltGit("darwin", executable, run), () =>
          gitSh([process.execPath, "status"], { cwd, allowFail }),
        );
      if (failure.startsWith("apply") || !allowFail) {
        const classification = await call().then(
          () => "returned",
          (error) =>
            error instanceof ConfinementError
              ? "confinement"
              : error instanceof CommandError
                ? "command"
                : "other",
        );
        expect(classification).toBe(failure.startsWith("apply") ? "confinement" : "command");
      } else expect((await call()).exitCode).toBe(code);
    });
  }
}

for (const failure of [false, true]) {
  test(`private per-call scratch is removed after ${failure ? "failure" : "success"}`, async () => {
    const inherited = join(root, "inherited-temp");
    mkdirSync(inherited);
    const executable = join(root, "sandbox-stand-in");
    const captured = join(root, "scratch-path");
    const profile = join(root, "profile");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s' "$TMPDIR" > '${captured}'\nprintf '%s' "$2" > '${profile}'\nexit ${failure ? 128 : 0}\n`,
      { mode: 0o755 },
    );
    let canonicalScratch = "";
    const run: typeof sh = async (_cmd, opts) => {
      canonicalScratch = realpathSync(opts.env?.TMPDIR ?? "");
      return { stdout: cwd, stderr: "", exitCode: 0 };
    };
    const call = () =>
      gitConfinement.run(seatbeltGit("darwin", executable, run), () =>
        gitSh([process.execPath, "status"], { cwd, env: { ...process.env, TMPDIR: inherited } }),
      );
    if (failure) await expect(call()).rejects.toBeInstanceOf(CommandError);
    else await call();
    const scratch = readFileSync(captured, "utf8");
    expect(scratch).not.toBe(inherited);
    expect(existsSync(scratch)).toBe(false);
    const writes = readFileSync(profile, "utf8")
      .split("\n")
      .find((line) => line.startsWith("(allow file-write*"));
    expect(writes).toContain(`(subpath "${canonicalScratch}")`);
    expect(writes).not.toContain(`(subpath "${realpathSync(inherited)}")`);
    expect(writes).not.toContain(`(subpath "${realpathSync(tmpdir())}")`);
  });
}

for (const confined of [false, true]) {
  for (const hasHistory of [false, true]) {
    test.skipIf(confined && seatbeltSkip !== null)(
      `shallow delivery ${hasHistory ? "excludes destination history" : "names missing history"}: ${confined ? "Seatbelt" : "fake"} (${seatbeltSkip ?? "available"})`,
      async () => {
        writeFileSync(join(cwd, "file"), "second\n");
        await git(cwd, "commit", "-qam", "second");
        const work = join(root, "shallow");
        await git(root, "clone", "-q", "--depth=1", `file://${cwd}`, work);
        writeFileSync(join(work, "file"), "new commit\n");
        await git(work, "commit", "-qam", "new");
        const head = (await git(work, "rev-parse", "HEAD")).stdout.trim();
        const destination = hasHistory ? cwd : join(root, "empty");
        if (!hasHistory) await git(root, "init", "-q", destination);
        const backend = confined ? seatbeltGit() : fakeGitConfinement;
        const calls: string[][] = [];
        const deliver = () =>
          gitConfinement.run(
            {
              wrap: async (cmd, opts) => {
                if (opts.cwd === work) calls.push(cmd);
                return backend.wrap(cmd, opts);
              },
            },
            () =>
              pushBranch(
                {
                  id: "local",
                  slug: "owner/repo",
                  kind: "local",
                  localPath: destination,
                  url: null,
                  defaultBranch: "main",
                  mergePolicy: "pr",
                  createdAt: 0,
                },
                work,
                "delivered",
              ),
          );
        if (hasHistory) {
          await deliver();
          expect((await git(destination, "rev-parse", "refs/heads/delivered")).stdout.trim()).toBe(head);
          expect(calls.some((cmd) => cmd.includes("bundle"))).toBe(true);
        } else await expect(deliver()).rejects.toThrow(`Cannot transfer shallow repository ${work}`);
        expect(calls.some((cmd) => cmd.includes("rev-parse"))).toBe(true);
        expect(calls.some((cmd) => cmd.includes("push") || cmd.includes("fetch"))).toBe(false);
      },
    );
  }
}
