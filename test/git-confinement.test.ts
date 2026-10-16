import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageAll, worktreeGit } from "../src/git/command.ts";
import { ConfinementError, gitConfinement, gitProfile, gitSh, seatbeltGit } from "../src/git/confinement.ts";
import { pushBranch } from "../src/git/repos.ts";
import { CommandError, sh } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";
import { fakeGitConfinement } from "./git-preload.ts";
import { seeded } from "./seeded.ts";

setDefaultTimeout(30_000);
let root: string;
let cwd: string;
const git = (dir: string, ...args: string[]) => sh(["git", ...args], { cwd: dir });
const real = <T>(run: () => T) => gitConfinement.run(seatbeltGit(), run);
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
    `derived profile allows git and denies shell execution: ${binary} (${seatbeltSkip ?? "available"})`,
    async () => {
      const backend = seatbeltGit();
      const wrapped = await backend.wrap([binary, "rev-parse", "HEAD"], { cwd });
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
        writeFileSync(join(repo, ".git/hooks/pre-push"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      await git(work, "tag", "unwanted");

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
  const { symlinkSync } = await import("node:fs");
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
  const wrapped = await seatbeltGit("darwin", process.execPath, run).wrap(["git", "status"], {
    cwd,
    env: { ...process.env, GIT_EXEC_PATH: "/untrusted" },
  });
  const profile = wrapped[2] ?? "";
  expect(profile).toContain(`(literal "${realpathSync(binary)}")`);
  expect(profile).toContain(`(subpath "${execPath}")`);
  for (const path of [cwd, join(cwd, ".git"), tmpdir()])
    expect(profile).toContain(`(subpath "${realpathSync(path)}")`);
  expect(profile).not.toContain("/untrusted");
  expect(wrapped).toContain(`--exec-path=${execPath}`);
});
