import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { join, resolve } from "node:path";
import { sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

// Each scenario drives the real script, git and fake tools (about 4 s on an idle machine); under CPU
// load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

const script = resolve("scripts/land-pr.sh");
const entry = "secret-host.example";
const origin = "https://github.com/MattFlower/limitless.git";
// Fake git scripts dispatch on the subcommand, after the global options land prepends.
const gitSubcommand =
  'sub=""; skip=""; for a in "$@"; do if [ -n "$skip" ]; then skip=""; continue; fi; case "$a" in -c|-C) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac; done';
const subcommand = (args: string[]) => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (["-c", "-C"].includes(arg)) i++;
    else if (!arg.startsWith("-")) return arg;
  }
};
// The global options land's factory git calls carry once PR code has run.
const hardened = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.commitGraph=false",
  "pack.useBitmaps=false",
].flatMap((flag) => ["-c", flag]);
const repositories = seeded(async (root) => {
  const source = join(root, "source");
  const alternate = join(root, "alternate");
  mkdirSync(source);
  const git = (...args: string[]) => sh(["git", ...args], { cwd: source });
  await git("init", "-qb", "main");
  writeFileSync(join(source, "file"), "base\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("clone", "-q", source, alternate);
  await git("-C", alternate, "commit", "--allow-empty", "-qm", entry);
  const denied = (await git("-C", alternate, "rev-parse", "HEAD")).stdout.trim();
  await git("init", "--bare", "-q", join(root, "remote"));
  return { base, denied };
});

describe("land-pr private strings", () => {
  test.each([
    "diff",
    "filename",
    "body",
    "subject",
    "unreadable",
    "absent",
    "clean",
    "history",
    "message",
    "author-email",
    "utf16-author-email",
    "utf16-message",
    "head-ref",
    "encoded",
    "malformed",
    "dangling",
    "inside",
    "alias",
    "relative",
    "excluded",
    "lfs",
    "lfs-crlf-legacy",
    "lfs-missing",
    "lfs-removed",
    "post-commit",
    "destination",
    "source-inside",
    "bunfig-preload",
  ])("checks %s before pushing", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "land-private-"));
    const source = join(root, "source");
    const work = join(root, "work");
    const config = join(root, "config");
    const bin = join(root, "bin");
    const gitBin = Bun.which("git");
    const bunBin = Bun.which("bun");
    if (!gitBin || !bunBin) throw new Error("missing tools");
    try {
      for (const dir of [source, config, bin]) mkdirSync(dir);
      const git = (...args: string[]) => sh([gitBin, ...args], { cwd: source });
      await git("init", "-q", "-b", "main");
      await git("remote", "add", "origin", origin);
      writeFileSync(join(source, "file.txt"), "base\n");
      await git("add", ".");
      await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
      if (scenario === "excluded") {
        writeFileSync(join(source, "old.txt"), entry);
        await git("add", ".");
        await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", entry);
        rmSync(join(source, "old.txt"));
        await git("add", ".");
        await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "remove old");
      }
      const sha = (await git("rev-parse", "HEAD")).stdout.trim();
      await git("worktree", "add", "-qb", "pr", work);
      const subject = scenario === "subject" ? entry.toUpperCase() : "Land safe change";
      const body = scenario === "body" ? entry.toUpperCase() : "Safe body";
      writeFileSync(
        join(root, "pr.json"),
        JSON.stringify({ baseRefOid: sha, body, headRefName: scenario === "head-ref" ? entry : "pr" }),
      );
      if (scenario === "unreadable") mkdirSync(join(config, "private-strings.txt"));
      else if (scenario !== "absent")
        writeFileSync(join(config, "private-strings.txt"), ` # comment\n\n ${entry} \n`);
      writeFileSync(
        join(work, "file.txt"),
        ["diff", "absent", "relative", "bunfig-preload"].includes(scenario)
          ? `${entry.toUpperCase()}\n`
          : "safe\n",
      );
      let expectedHead = sha;
      const commit = async (message: string) => {
        await git("-C", work, "add", ".");
        await git("-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
        expectedHead = (await git("-C", work, "rev-parse", "HEAD")).stdout.trim();
      };
      const globalConfig = join(root, "global.config");
      writeFileSync(
        globalConfig,
        `${readFileSync(process.env.GIT_CONFIG_GLOBAL ?? "/dev/null", "utf8")}${scenario.startsWith("utf16-") ? "\n[i18n]\nlogOutputEncoding = UTF-16\n" : ""}`,
      );
      if (scenario.endsWith("author-email")) {
        await git("-C", work, "add", ".");
        await git(
          "-C",
          work,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "--author=Fake <fake@secret-host.example>",
          "-qm",
          "safe",
        );
        expectedHead = (await git("-C", work, "rev-parse", "HEAD")).stdout.trim();
      }
      if (["history", "message", "utf16-message"].includes(scenario)) {
        writeFileSync(join(work, "transient.txt"), scenario === "history" ? entry : "safe");
        await commit(scenario.endsWith("message") ? `Safe subject\n\n${entry}` : "safe");
        rmSync(join(work, "transient.txt"));
        await commit("remove transient");
        writeFileSync(join(work, "file.txt"), "final safe\n");
      }
      if (scenario.startsWith("lfs")) {
        const payload = Buffer.from(entry);
        const oid = createHash("sha256").update(payload).digest("hex");
        const object = join(source, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
        mkdirSync(join(object, ".."), { recursive: true });
        if (scenario !== "lfs-missing") writeFileSync(object, payload);
        writeFileSync(
          join(work, "asset.dat"),
          scenario === "lfs-crlf-legacy"
            ? `version https://hawser.github.com/spec/v1\r\noid sha256:${oid}\r\nsize ${payload.length}\r\n`
            : `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`,
        );
        if (scenario === "lfs-removed") {
          await commit("asset");
          rmSync(join(work, "asset.dat"));
          await commit("remove asset");
        }
      }
      if (scenario === "encoded") writeFileSync(join(work, "file.txt"), "%73ecret-host%2Eexample");
      if (scenario === "malformed") writeFileSync(join(config, "private-strings.txt"), Buffer.from([0xff]));
      if (scenario === "dangling") {
        rmSync(join(config, "private-strings.txt"));
        symlinkSync(join(root, "missing"), join(config, "private-strings.txt"));
      }
      let configDir = scenario === "relative" ? "config" : config;
      if (["inside", "alias"].includes(scenario)) {
        mkdirSync(join(work, "repo-config"));
        configDir = "repo-config";
        if (scenario === "alias") symlinkSync(join(work, "repo-config"), join(root, "repo-config"));
      }
      if (scenario === "source-inside") {
        configDir = join(source, "repo-config");
        mkdirSync(configDir);
      }
      if (scenario === "filename") writeFileSync(join(work, `${entry}.txt`), "safe\n");
      if (scenario === "bunfig-preload") {
        // PR files Bun would load from the worktree: a preload that turns every exit into success.
        writeFileSync(join(work, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
        writeFileSync(
          join(work, "pre.ts"),
          'const exit = process.exit.bind(process);\nprocess.exit = ((_code?: number) => exit(0)) as typeof process.exit;\nprocess.on("exit", () => {\n  process.exitCode = 0;\n});\n',
        );
      }
      // Scan committed PR content; only the post-check mutation starts uncommitted.
      await git("-C", work, "add", ".");
      if (scenario !== "post-commit" && (await git("-C", work, "diff", "--cached", "--name-only")).stdout)
        await commit("safe");
      // Stop permitted deliveries at push so the script never reaches the network.
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\n${gitSubcommand}\ncase "$sub" in\ncommit) echo commit >> '${join(root, "mutations")}'; exit 17 ;;\npush) echo push >> '${join(root, "mutations")}'; exit 17 ;;\nesac\nexec '${gitBin}' "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "bun"),
        `#!/bin/sh\ncase "$*" in\n*check-private-strings.ts*) exec '${bunBin}' "$@" ;;\n${scenario === "post-commit" ? `*gate-slot*) exec '${gitBin}' -c user.name=t -c user.email=t@t commit -qm '${entry}' ;;` : ""}\nesac\nexit 0\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\ncase "$*" in *--jq*) echo '${scenario === "destination" ? entry : "pr"}'; exit 0 ;; esac\ncat '${join(root, "pr.json")}'\n`,
        { mode: 0o755 },
      );
      const result = await sh(["bash", script, "123", subject, work], {
        cwd: scenario === "inside" ? work : root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LIMITLESS_CONFIG_DIR: configDir,
          GIT_CONFIG_GLOBAL: globalConfig,
          TMPDIR: root,
        },
        allowFail: true,
      });
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`.toLowerCase()).not.toContain(entry);
      if (scenario.endsWith("author-email")) expect(result.stderr).toContain("author email");
      if (scenario !== "post-commit")
        expect((await git("-C", work, "rev-parse", "HEAD")).stdout.trim()).toBe(expectedHead);
      if (["absent", "clean", "excluded"].includes(scenario)) {
        expect(readFileSync(join(root, "mutations"), "utf8")).toBe("push\n");
      } else {
        expect(existsSync(join(root, "mutations"))).toBe(false);
        expect(result.stderr).toContain(
          ["unreadable", "malformed", "dangling"].includes(scenario)
            ? "Cannot read private-strings.txt"
            : ["inside", "alias", "source-inside"].includes(scenario)
              ? "inside repository"
              : scenario === "post-commit"
                ? "Worktree differs from landing commit"
                : scenario === "lfs-missing"
                  ? "Cannot inspect local LFS payload"
                  : "entry 3 in private-strings.txt",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const plantedKeys = [
  "remote.origin.receivepack",
  "remote.origin.pushurl",
  "core.sshCommand",
  "credential.helper",
  "credential.https://github.com.helper",
  "url.attack.insteadOf",
  "include.path",
];
const originForms = [
  origin,
  "https://github.com/MattFlower/limitless",
  "git@github.com:MattFlower/limitless.git",
  "ssh://git@github.com/MattFlower/limitless.git",
  "https://github.com/fork-owner/limitless.git",
];

test.each([
  "redirect",
  "redirect-and-move-head",
  "working-tree",
  "untracked",
  "ignored",
  "local-exclude",
  "changed-local-exclude",
  "no-private-strings",
  "state:MERGE_HEAD",
  "state:CHERRY_PICK_HEAD",
  "state:REVERT_HEAD",
  "checks:clean-filter",
  "pre-push:clean-filter",
  "checks:external-diff",
  "checks:signing",
  "checks:pager",
  "checks:private-repository",
  "status:malformed-include",
  "read-tree-failed",
  "status-failed",
  "fresh-clone",
  "config-failed-before",
  "config-failed-url",
  "missing-origin",
  "multiple-origins",
  "multiple-origins-blank",
  "malformed-config",
  "push-failed",
  "commit-unavailable",
  "file-path",
  "file-url",
  "ext-url",
  "git-config-env",
  ...originForms.map((url) => `origin:${url}`),
  ...plantedKeys.flatMap((key) => ["before", "install", "checks", "pre-push"].map((at) => `${at}:${key}`)),
])("land publishes its pinned SHA from an isolated push repository: %s", async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "land-trusted-"));
  try {
    const { value } = await repositories(root);
    const source = join(root, "source");
    const alternate = join(root, "alternate");
    const remote = join(root, "remote");
    const work = join(root, "work");
    const bin = join(root, "bin");
    const config = join(root, "config");
    for (const path of [bin, config]) mkdirSync(path);
    const gitBin = Bun.which("git");
    if (!gitBin) throw new Error("missing git");
    const git = (...args: string[]) => sh([gitBin, ...args], { cwd: source });
    if (scenario === "fresh-clone") {
      await git("clone", "-q", "--reference", source, source, work);
      await git("-C", work, "checkout", "-qb", "pr");
      // Ordinary clone metadata may use mixed-case branch names.
      await git("-C", work, "config", "branch.PR.remote", "origin");
      await git("-C", work, "config", "branch.PR.merge", "refs/heads/main");
      // A global branch.autoSetupRebase adds this at clone time on real machines.
      await git("-C", work, "config", "branch.PR.rebase", "true");
      await git("-C", work, "remote", "set-url", "origin", "git@github.com:MattFlower/limitless.git");
    } else await git("worktree", "add", "-qb", "pr", work);
    await git("remote", "add", "origin", origin);
    await git("-C", alternate, "remote", "set-url", "origin", remote);
    const globalConfig = join(root, "global.config");
    writeFileSync(
      globalConfig,
      `${readFileSync(process.env.GIT_CONFIG_GLOBAL ?? "/dev/null", "utf8")}\n[push]\nfollowTags = true\n`,
    );
    await git("tag", "-am", "safe tag", "local-tag");
    // Make the alternate commit available to HEAD-movement attacks without publishing it.
    await git("fetch", "-q", alternate, "main");
    writeFileSync(join(work, "file"), "safe change\n");
    if (scenario === "ignored") writeFileSync(join(work, ".gitignore"), "local-build/\n");
    if (["local-exclude", "changed-local-exclude"].includes(scenario))
      writeFileSync(join(source, ".git/info/exclude"), "local-build/\n");
    if (scenario.endsWith(":clean-filter"))
      writeFileSync(join(work, ".gitattributes"), "file filter=attack\n");
    await git("-C", work, "add", ".");
    await git("-C", work, "commit", "-qm", "safe change");
    const landingSha = (await git("-C", work, "rev-parse", "HEAD")).stdout.trim();
    if (scenario !== "no-private-strings") writeFileSync(join(config, "private-strings.txt"), entry);
    const paths = [
      realpathSync(work),
      realpathSync(scenario === "fresh-clone" ? join(work, ".git") : join(source, ".git/worktrees/work")),
      realpathSync(scenario === "fresh-clone" ? join(work, ".git") : join(source, ".git")),
    ];
    const recorded = await sh([process.execPath, resolve("scripts/check-private-strings.ts"), "--record"], {
      cwd: work,
    });
    expect(recorded.stdout.trim().split("\n")).toEqual(paths);
    if (scenario !== "fresh-clone")
      expect(JSON.parse(readFileSync(`${work}.git-paths`, "utf8"))).toEqual(paths);
    const calls = join(root, "calls");
    const pinned = join(root, "pinned");
    const checked = join(root, "checked");
    const marker = join(root, "config-command-ran");
    const injected = join(
      root,
      scenario.endsWith(":malformed-include") ? `${entry}-secret-config-value.config` : "injected.config",
    );
    const command = `touch '${marker}'`;
    const [plantAt, plantKey] = scenario.split(":");
    const postCheckConfig: Record<string, string[][]> = {
      "clean-filter": [["filter.attack.clean", `${command}; cat`]],
      "external-diff": [
        ["diff.external", command],
        ["diff.trustExitCode", "true"],
      ],
      signing: [
        ["commit.gpgSign", "true"],
        ["gpg.program", command],
      ],
      pager: [
        ["core.pager", command],
        ["pager.status", "true"],
      ],
      "malformed-include": [["include.path", injected]],
    };
    const planted = plantedKeys.includes(plantKey ?? "") || (plantKey ?? "") in postCheckConfig;
    writeFileSync(injected, `[remote "origin"]\nreceivepack = ${JSON.stringify(command)}\n`);
    const plantValue =
      plantKey === "include.path"
        ? injected
        : plantKey?.includes("helper")
          ? `!${command}`
          : plantKey === "remote.origin.pushurl"
            ? `ext::${command}`
            : plantKey === "url.attack.insteadOf"
              ? origin
              : command;
    const plantArgs = ["--git-dir", paths[2] ?? "", "config", plantKey ?? "", plantValue];
    const plantCommands = (postCheckConfig[plantKey ?? ""] ?? []).map((settings) => [
      "--git-dir",
      paths[2] ?? "",
      "config",
      ...settings,
    ]);
    if (plantCommands.length === 0) plantCommands.push(plantArgs);
    if (plantKey === "malformed-include") writeFileSync(injected, `[${entry}-secret-config-value\n`);
    if (planted && plantAt === "before") await git(...plantArgs);
    const extHelper = join(root, "ext-helper");
    writeFileSync(extHelper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const expectedUrl = scenario.startsWith("origin:")
      ? scenario.slice(7)
      : scenario === "fresh-clone"
        ? "git@github.com:MattFlower/limitless.git"
        : scenario === "file-path"
          ? remote
          : scenario === "file-url"
            ? `file://${remote}`
            : scenario === "ext-url"
              ? `ext::${extHelper}`
              : origin;
    if (scenario !== "fresh-clone") await git("config", "remote.origin.url", expectedUrl);
    if (scenario === "missing-origin") await git("config", "--unset-all", "remote.origin.url");
    if (scenario.startsWith("multiple-origins"))
      await git("config", "--add", "remote.origin.url", scenario.endsWith("blank") ? "" : origin);
    if (scenario === "malformed-config") {
      const malformed = join(root, `${entry}.config`);
      writeFileSync(malformed, "[malformed\n");
      await git("config", "include.path", malformed);
    }
    const targetHook = join(remote, "hooks", "pre-receive");
    writeFileSync(targetHook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const externalConfig = join(root, "external.config");
    writeFileSync(externalConfig, `[remote "origin"]\nurl = ${origin}\n`);
    // Override permissive global protocol defaults; keep hasconfig includes and runner LFS filters.
    const globalInclude = join(root, "global-include.config");
    writeFileSync(globalInclude, "[land]\ntrustedInclude = yes\n");
    writeFileSync(join(root, "system.config"), '[filter "lfs"]\nprocess = false\nrequired = true\n');
    writeFileSync(
      globalConfig,
      `${readFileSync(globalConfig, "utf8")}\n[protocol]\nallow = always\n[includeIf "hasconfig:remote.*.url:https://github.com/**"]\npath = ${globalInclude}\n`,
    );
    if (scenario === "checks:private-repository") {
      const ssh = join(root, "trusted-ssh");
      writeFileSync(
        ssh,
        `#!/bin/sh\nunset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE GIT_INDEX_FILE\nexec '${gitBin}' receive-pack '${remote}'\n`,
        { mode: 0o755 },
      );
      await git("config", "--file", globalConfig, "core.sshCommand", ssh);
      await git("config", "--file", globalConfig, "ssh.variant", "ssh");
    }
    writeFileSync(
      join(bin, "bun"),
      `#!${process.execPath}
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
let args = process.argv.slice(2);
const bunFlags = [];
while (args[0]?.startsWith("--")) bunFlags.push(args.shift());
// The gate-slot wrapper is unwrapped here, so the test never reaches a daemon.
if (args[1] === "gate-slot") {
  const command = args.slice(args.indexOf("--") + 1);
  args = command[0] === "bun" ? command.slice(1) : command;
}
const paths = [process.env.GIT_WORK_TREE, process.env.GIT_DIR, process.env.GIT_COMMON_DIR];
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "bun", args, paths, landLog: process.env.LAND_PR_LOG ?? null }) + "\\n");
if (args[0] === "install" || args[0] === "run") {
  if (${JSON.stringify(scenario)} === "checks:private-repository") {
    const repos = readdirSync(process.env.TMPDIR).filter(name => name.startsWith("land-pr-push."));
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "check-visible-repos", args: repos }) + "\\n");
    for (const name of repos) writeFileSync(process.env.TMPDIR + "/" + name + "/config", ${JSON.stringify(`[core]\nsshCommand = ${JSON.stringify(`${command}; exit 1`)}\n`)});
  }
  const trustedEnv = { ...process.env, GIT_WORK_TREE: ${JSON.stringify(paths[0])}, GIT_DIR: ${JSON.stringify(paths[1])}, GIT_COMMON_DIR: ${JSON.stringify(paths[2])} };
  const snapshot = () => ["rev-parse HEAD", "diff --cached --raw"].map(command => {
    const result = spawnSync(${JSON.stringify(gitBin)}, command.split(" "), { env: trustedEnv, encoding: "utf8" });
    if (result.status !== 0) process.exit(1);
    return result.stdout.trim();
  });
  const before = snapshot();
  const cwd = ${JSON.stringify(root)} + "/fixture-" + args[0];
  mkdirSync(cwd);
  writeFileSync(cwd + "/file", "test fixture\\n");
  for (const command of [["init", "-qb", "main"], ["add", "."], ["commit", "-qm", "test fixture " + args[0]]]) {
    const result = spawnSync(${JSON.stringify(gitBin)}, command, { cwd, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  writeFileSync(cwd + "-state", JSON.stringify([before, snapshot()]));
  if (${JSON.stringify(scenario)} === "git-config-env" && args[0] === "run") {
    const changed = spawnSync(${JSON.stringify(gitBin)}, ["--git-dir", ${JSON.stringify(paths[2])}, "config", "remote.origin.receivepack", ${JSON.stringify(command)}], { env: { ...process.env, GIT_CONFIG: undefined }, stdio: "inherit" });
    if (changed.status !== 0) process.exit(1);
  }
  if (${planted} && args[0] === ${JSON.stringify(plantAt === "install" ? "install" : plantAt === "checks" ? "run" : "never")}) {
    for (const command of ${JSON.stringify(plantCommands)}) {
      const changed = spawnSync(${JSON.stringify(gitBin)}, command, { stdio: "inherit" });
      if (changed.status !== 0) process.exit(1);
    }
  }
}
if (args[0] === "run") {
  if (${JSON.stringify(scenario)}.startsWith("redirect")) writeFileSync(${JSON.stringify(join(work, ".git"))}, "gitdir: " + ${JSON.stringify(join(alternate, ".git"))} + "\\n");
  if (${JSON.stringify(scenario)} === "working-tree") writeFileSync(${JSON.stringify(join(work, "file"))}, "check-generated change\\n");
  if (${JSON.stringify(scenario)} === "untracked") writeFileSync(${JSON.stringify(join(work, "untracked"))}, "generated\\n");
  if (${JSON.stringify(["ignored", "local-exclude", "changed-local-exclude"].includes(scenario))}) {
    mkdirSync(${JSON.stringify(join(work, "local-build"))});
    writeFileSync(${JSON.stringify(join(work, "local-build/output"))}, "generated\\n");
    if (${JSON.stringify(scenario)} === "changed-local-exclude") writeFileSync(${JSON.stringify(join(source, ".git/info/exclude"))}, "");
  }
  if (${JSON.stringify(scenario)}.startsWith("state:")) writeFileSync(${JSON.stringify(paths[1])} + "/" + ${JSON.stringify(plantKey)}, ${JSON.stringify(landingSha)} + "\\n");
  if (${JSON.stringify(plantKey)} === "clean-filter") writeFileSync(${JSON.stringify(join(work, "file"))}, "safe change\\n");
  writeFileSync(${JSON.stringify(checked)}, "ready");
}
if (args[0].endsWith(".ts")) {
  if (args.length === 6) {
    writeFileSync(${JSON.stringify(pinned)}, args[5]);
    if (${JSON.stringify(scenario)} === "redirect-and-move-head") {
      const moved = spawnSync(${JSON.stringify(gitBin)}, ["update-ref", "refs/heads/pr", ${JSON.stringify(value.denied)}], { env: { ...process.env, GIT_DIR: ${JSON.stringify(paths[1])}, GIT_COMMON_DIR: ${JSON.stringify(paths[2])} }, stdio: "inherit" });
      if (moved.status !== 0) process.exit(1);
    }
  }
  const result = spawnSync(${JSON.stringify(process.execPath)}, [...bunFlags, ...args], { stdio: "inherit" });
  if (args[1] === "--record") appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "recorded", args: [] }) + "\\n");
  process.exit(result.status ?? 1);
}
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const paths = [process.env.GIT_WORK_TREE, process.env.GIT_DIR, process.env.GIT_COMMON_DIR];
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "git", args, paths, checked: existsSync(${JSON.stringify(checked)}), config: process.env.GIT_CONFIG ?? null, index: process.env.GIT_INDEX_FILE ?? null }) + "\\n");
if ((${JSON.stringify(scenario)} === "config-failed-before" && args.includes("--absolute-git-dir")) ||
    (${JSON.stringify(scenario)} === "config-failed-url" && args.includes("--get-all"))) {
  console.error("secret-config-value"); process.exit(1);
}
if (${JSON.stringify(scenario)} === "commit-unavailable" && args.includes("-C") && args.includes("cat-file") && args.includes("-e")) process.exit(1);
if ((${JSON.stringify(scenario)} === "read-tree-failed" && args.includes("read-tree")) ||
    (${JSON.stringify(scenario)} === "status-failed" && args.includes("status"))) {
  console.error("secret-config-value"); process.exit(1);
}
let deliveryArgs = args;
if (args.includes("push")) {
  const repoAt = args.indexOf("-C");
  const pushRepo = repoAt < 0 ? process.env.GIT_COMMON_DIR : args[repoAt + 1];
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "push-repo", args: [pushRepo], mode: statSync(pushRepo).mode & 0o777, alternates: readFileSync(pushRepo + "/objects/info/alternates", "utf8") }) + "\\n");
  if (${JSON.stringify(scenario)} === "push-failed") process.exit(1);
  if (!${JSON.stringify(["file-path", "file-url", "ext-url"].includes(scenario))}) {
    // Only delivery is redirected to a real local bare remote. Policy remains intact for denied URLs.
    deliveryArgs = ["-c", "protocol.file.allow=always", ...args.map(arg => arg === ${JSON.stringify(expectedUrl)} || arg === "origin" ? ${JSON.stringify(remote)} : arg)];
    if (${JSON.stringify(scenario)} === "checks:private-repository") deliveryArgs = args.map(arg => arg === ${JSON.stringify(expectedUrl)} ? "ssh://example.com/remote" : arg);
    // Permitted test delivery must not trigger the target hook used by the denied-transport cases.
    rmSync(${JSON.stringify(targetHook)});
  }
  if (${JSON.stringify(expectedUrl.startsWith("https://github.com/"))}) {
    const included = spawnSync(${JSON.stringify(gitBin)}, ["-C", pushRepo, "config", "--get", "land.trustedInclude"], { encoding: "utf8" });
    if (included.stdout.trim() !== "yes") process.exit(1);
  }
}
// Leave the malformed clone include in place through push and the final merge check.
const configFile = ${JSON.stringify(join(paths[2] ?? "", "config"))};
const malformed = ${JSON.stringify(scenario)} === "status:malformed-include" && args.includes("status");
if (malformed) appendFileSync(configFile, ${JSON.stringify(`\n[include]\npath = ${JSON.stringify(injected)}\n`)});
const env = { ...process.env };
if (${JSON.stringify(scenario)} === "checks:private-repository" && args.includes("push"))
  for (const key of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"]) delete env[key];
const result = spawnSync(${JSON.stringify(gitBin)}, deliveryArgs, { env, stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "gh", args }) + "\\n");
if (args[0] === "run" && args[1] === "list") console.log("123");
else if (args[1] === "view") {
  if (args.includes("baseRefOid,body,headRefName") && existsSync(${JSON.stringify(pinned)}) && ${planted && plantAt === "pre-push"}) {
    for (const command of ${JSON.stringify(plantCommands)}) {
      const changed = spawnSync(${JSON.stringify(gitBin)}, command, { stdio: "inherit" });
      if (changed.status !== 0) process.exit(1);
    }
  }
  if (args.includes("--jq")) console.log("pr");
  else if (args.includes("title,body,headRefOid")) console.log(JSON.stringify({ title: "safe", body: "safe", headRefOid: readFileSync(${JSON.stringify(pinned)}, "utf8") }));
  else console.log(${JSON.stringify(JSON.stringify({ baseRefOid: value.base, body: "safe", headRefName: "pr" }))});
}
`,
      { mode: 0o755 },
    );
    const result = await sh(["bash", script, "123", "safe", work], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LIMITLESS_CONFIG_DIR: config,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: join(root, "system.config"),
        ...(scenario === "git-config-env" ? { GIT_CONFIG: externalConfig } : {}),
        LAND_PR_LOG: join(root, "land-check.log"),
        TMPDIR: root,
      },
      allowFail: true,
    });
    expect(result.stderr).not.toContain(entry);
    expect(result.stdout).not.toContain(entry);
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-config-value");
    const logged: {
      tool: string;
      args: string[];
      paths?: (string | null)[];
      landLog?: string | null;
      config?: string | null;
      index?: string | null;
      checked?: boolean;
      mode?: number;
      alternates?: string;
    }[] = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      logged.some((call) => call.tool === "git" && ["add", "commit"].includes(subcommand(call.args) ?? "")),
    ).toBe(false);
    if (scenario !== "redirect-and-move-head")
      expect(readFileSync(join(paths[2] ?? "", "refs/heads/pr"), "utf8").trim()).toBe(landingSha);
    for (const call of logged.filter(
      (call) => call.tool === "git" && call.args.includes("init") && call.args.includes("-C"),
    )) {
      expect(existsSync(call.args[call.args.indexOf("-C") + 1] ?? "")).toBe(false);
    }
    const pushRepos = logged.filter((call) => call.tool === "push-repo");
    for (const call of logged.filter((call) => call.tool === "git" && call.checked)) {
      const privateDir = call.paths?.[1];
      expect(privateDir).toStartWith(`${root}/land-pr-push.`);
      expect(call.paths?.[2]).toBe(privateDir);
      expect(call.index).toBe(`${privateDir}/index`);
      expect(call.paths).not.toContain(paths[1]);
      expect(call.paths).not.toContain(paths[2]);
    }
    for (const call of pushRepos) {
      expect(call.mode).toBe(0o700);
      expect(call.alternates).toBe(`${paths[2]}/objects\n`);
      expect(existsSync(call.args[0] ?? "")).toBe(false);
    }
    expect(existsSync(marker)).toBe(false);
    if (scenario === "checks:private-repository")
      expect(logged.filter((call) => call.tool === "check-visible-repos").map((call) => call.args)).toEqual([
        [],
        [],
      ]);
    const failure =
      scenario.startsWith("config-failed-") ||
      scenario.startsWith("state:") ||
      [
        "working-tree",
        "untracked",
        "read-tree-failed",
        "status-failed",
        "missing-origin",
        "multiple-origins",
        "multiple-origins-blank",
        "malformed-config",
        "push-failed",
        "commit-unavailable",
        "file-path",
        "file-url",
        "ext-url",
      ].includes(scenario);
    if (failure) {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain("secret-config-value");
      if (scenario === "malformed-config" || scenario === "config-failed-before")
        expect(result.stderr).toContain("Cannot read repository git paths");
      if (scenario === "config-failed-url" || scenario === "missing-origin")
        expect(result.stderr).toContain("Cannot read origin URL");
      if (scenario === "commit-unavailable")
        expect(result.stderr).toContain("Cannot prepare pinned commit in push repository");
      if (["working-tree", "untracked"].includes(scenario))
        expect(result.stderr).toContain("Worktree differs from landing commit");
      if (scenario.startsWith("state:")) expect(result.stderr).toContain("in progress");
      if (["read-tree-failed", "status-failed"].includes(scenario))
        expect(result.stderr).toContain("Cannot inspect worktree");
      if (scenario.startsWith("multiple-origins")) expect(result.stderr).toContain("multi-valued");
      expect(logged.some((call) => call.tool === "gh" && call.args[1] === "merge")).toBe(false);
      expect((await git("--git-dir", remote, "for-each-ref")).stdout).toBe("");
      if (["push-failed", "file-path", "file-url", "ext-url"].includes(scenario))
        expect(pushRepos).toHaveLength(1);
      if (["file-path", "file-url", "ext-url"].includes(scenario))
        expect(result.stderr).toContain("not allowed");
      if (
        ["working-tree", "untracked", "read-tree-failed", "status-failed"].includes(scenario) ||
        scenario.startsWith("state:")
      )
        expect(pushRepos).toHaveLength(0);
      return;
    }
    expect(pushRepos).toHaveLength(1);
    expect((await git("--git-dir", remote, "rev-list", "--all")).stdout.trim().split("\n")).not.toContain(
      value.denied,
    );
    expect((await git("--git-dir", remote, "log", "--all", "--format=%B")).stdout).not.toContain(entry);
    expect(result.exitCode).toBe(0);
    const sha = readFileSync(pinned, "utf8");
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(sha).not.toBe(value.base);
    expect(sha).not.toBe(value.denied);
    expect(sha).toBe(landingSha);
    for (const command of ["install", "run"]) {
      expect(JSON.parse(readFileSync(join(root, `fixture-${command}-state`), "utf8"))).toEqual([
        [landingSha, ""],
        [landingSha, ""],
      ]);
      expect(
        (await git("-C", join(root, `fixture-${command}`), "log", "-1", "--format=%s")).stdout.trim(),
      ).toBe(`test fixture ${command}`);
    }
    const installed = logged.findIndex((call) => call.tool === "bun" && call.args[0] === "install");
    const recordedAt = logged.findIndex((call) => call.tool === "recorded");
    expect(recordedAt).toBeGreaterThan(0);
    expect(installed).toBeGreaterThan(recordedAt);
    const checkedAt = logged.findIndex((call) => call.tool === "bun" && call.args[0] === "run");
    // The suite under check runs this script in its own tests, which would write over the outer log.
    expect(logged[installed]?.landLog).toBeNull();
    expect(logged[checkedAt]?.landLog).toBeNull();
    for (const call of logged
      .slice(recordedAt + 1, checkedAt + 1)
      .filter((call) => call.tool === "git" || call.tool === "bun")) {
      const isolated =
        (call.tool === "bun" && ["install", "run"].includes(call.args[0] ?? "")) ||
        call.args.includes("-C") ||
        (call.tool === "git" && call.paths?.every((path) => path === null));
      expect(call.paths).toEqual(isolated ? [null, null, null] : paths);
      if (call.args.includes("push")) expect(call.config).toBeNull();
    }
    const commands = (tool: string, command: string) =>
      logged.filter((call) => call.tool === tool && call.args.includes(command)).map((call) => call.args);
    expect(commands("bun", sha)).toEqual([
      [resolve("scripts/check-private-strings.ts"), "123", "MattFlower/limitless", "safe", "pr", sha],
      [resolve("scripts/check-private-strings.ts"), "123", "MattFlower/limitless", "--merge", sha],
    ]);
    const push = commands("git", "push")[0] ?? [];
    const status = commands("git", "status")[0] ?? [];
    for (const flag of ["--no-pager", "--porcelain", "--untracked-files=normal", "--ignored=no"])
      expect(status).toContain(flag);
    expect(status).toContain(`--git-dir=${pushRepos[0]?.args[0]}`);
    expect(status).toContain(`--work-tree=${paths[0]}`);
    expect(commands("git", "read-tree")[0]?.at(-1)).toBe(sha);
    for (const call of logged.filter(
      (call) => call.tool === "git" && ["read-tree", "status"].some((cmd) => call.args.includes(cmd)),
    ))
      expect(call.index).toBe(`${pushRepos[0]?.args[0]}/index`);
    for (const flag of [
      "--no-verify",
      "--no-follow-tags",
      "protocol.allow=never",
      "protocol.https.allow=always",
      "protocol.ssh.allow=always",
      ...hardened.filter((arg) => arg !== "-c"),
    ])
      expect(push).toContain(flag);
    expect(push.at(-2)).toBe(expectedUrl);
    expect(push.at(-1)).toBe(`${sha}:refs/heads/pr`);
    expect(commands("git", "remote.origin.url").filter((args) => args.includes("--get-all"))).toHaveLength(1);
    expect(commands("git", "rev-list").some((args) => args.includes(`${value.base}..${sha}`))).toBe(
      scenario !== "no-private-strings",
    );
    expect(commands("gh", "list")).toEqual([
      [
        "run",
        "list",
        "-R",
        "MattFlower/limitless",
        "--commit",
        sha,
        "--limit",
        "1",
        "--json",
        "databaseId",
        "--jq",
        ".[0].databaseId // empty",
      ],
    ]);
    expect(commands("gh", "merge")[0]).toContain("--match-head-commit");
    expect(commands("gh", "merge")[0]?.at(-1)).toBe(sha);
    expect((await git("--git-dir", remote, "rev-parse", "refs/heads/pr")).stdout.trim()).toBe(sha);
    expect((await git("--git-dir", remote, "tag", "--list")).stdout).toBe("");
    if (scenario.startsWith("redirect"))
      expect(readFileSync(join(work, ".git"), "utf8")).toContain(join(alternate, ".git"));
    if (scenario === "redirect-and-move-head")
      expect((await git("rev-parse", "pr")).stdout.trim()).toBe(value.denied);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  "missing",
  "short",
  "extra",
  "relative",
  "work-mismatch",
  "git-mismatch",
  "common-mismatch",
  "not-directory",
])("land refuses invalid recorded paths: %s", async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "land-bad-paths-"));
  try {
    await repositories(root);
    const work = join(root, "work");
    const source = join(root, "source");
    await sh(["git", "worktree", "add", "-qb", "pr", work], { cwd: source });
    await sh(["git", "remote", "add", "origin", origin], { cwd: source });
    const paths = [
      realpathSync(work),
      realpathSync(join(source, ".git/worktrees/work")),
      realpathSync(join(source, ".git")),
    ];
    if (scenario === "missing") paths.length = 0;
    if (scenario === "short") paths.pop();
    if (scenario === "extra") paths.push(root);
    if (scenario === "relative") paths[1] = "../source/.git/worktrees/work";
    if (scenario === "work-mismatch") paths[0] = realpathSync(source);
    if (scenario === "git-mismatch") paths[1] = realpathSync(join(root, "alternate/.git"));
    if (scenario === "common-mismatch") paths[2] = realpathSync(join(root, "alternate/.git"));
    if (scenario === "not-directory") paths[1] = join(source, "file");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const marker = join(root, "untrusted-code-or-publication");
    writeFileSync(
      join(bin, "bun"),
      `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nif (process.argv[5] === "--record") console.log(${JSON.stringify(paths.join("\n"))});\nelse writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const result = await sh(["bash", script, "123", "safe", work], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      allowFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect((await sh(["git", "--git-dir", join(root, "remote"), "for-each-ref"], { cwd: root })).stdout).toBe(
      "",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["HEAD", "f".repeat(40)])(
  "private check rejects an invalid or unavailable pinned SHA: %s",
  async (head) => {
    const root = mkdtempSync(join(tmpdir(), "land-bad-sha-"));
    try {
      await repositories(root);
      const result = await sh(
        [process.execPath, resolve("scripts/check-private-strings.ts"), "123", "local", "safe", "pr", head],
        {
          cwd: join(root, "source"),
          env: { ...process.env, LIMITLESS_CONFIG_DIR: join(root, "absent") },
          allowFail: true,
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.trim()).toBe("Private check blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("land records the worktree's Git paths before any PR code runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "land-record-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const calls = join(root, "calls");
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$4" = --record ] && printf '%s\\n' "$(pwd -P)" "$(pwd -P)/admin" "$(pwd -P)/common"\n[ "$2" = gate-slot ] && exit 1\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *--absolute-git-dir) echo "$PWD/admin" ;; *--git-common-dir) echo "$PWD/common" ;; *rev-parse*HEAD) echo '${"a".repeat(40)}' ;; *config*--get-all*) echo '${origin}' ;; esac\n`,
      { mode: 0o755 },
    );
    mkdirSync(join(root, "admin"));
    mkdirSync(join(root, "common"));
    await sh(["bash", script, "123", "safe", root], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
      allowFail: true,
    });
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines[0]).toStartWith("--config=/dev/null --no-env-file ");
    expect(lines[0]).toEndWith("check-private-strings.ts --record");
    // The check runs through the checkout's own CLI in a named gate slot; `limitless` need not be on PATH.
    const check = lines.findIndex((line) =>
      line.endsWith("/src/cli/main.ts gate-slot --name land-pr #123 -- bun run check"),
    );
    expect(check).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("land logs honor TMPDIR and overrides and are unique for concurrent failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "land-logs-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const marker = join(root, "published");
    writeFileSync(
      join(bin, "bun"),
      '#!/bin/sh\n[ "$4" = --record ] && { printf "%s\\n" "$(pwd -P)" "$(pwd -P)/admin" "$(pwd -P)/common"; exit 0; }\n[ "$1" = install ] && exit 0\necho "failed-check-$$"\nexit 1\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *--absolute-git-dir) echo "$PWD/admin" ;; *--git-common-dir) echo "$PWD/common" ;; *rev-parse*HEAD) echo '${"a".repeat(40)}' ;; *config*--name-only*--get-regexp*) exit 1 ;; *config*--list*--show-scope*) exit 0 ;; *config*--get-all*) echo '${origin}' ;; *) touch '${marker}'; exit 1 ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    mkdirSync(join(root, "admin"));
    mkdirSync(join(root, "common"));
    const run = (log = "") =>
      sh(["bash", script, "123", "safe", root], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, LAND_PR_LOG: log },
        allowFail: true,
      });
    const results = await Promise.all([run(), run(), run(join(root, "custom log"))]);
    const paths = results.map((result) => {
      expect(result.exitCode).not.toBe(0);
      const path = result.stderr.trim().split("see ")[1];
      if (!path) throw new Error("missing log path");
      expect(readFileSync(path, "utf8")).toMatch(/^failed-check-\d+\n$/);
      return path;
    });
    expect(paths[0]).toMatch(new RegExp(`^${root}/land-pr-check\\.\\d+\\.log$`));
    expect(new Set(paths).size).toBe(3);
    expect(paths[2]).toBe(join(root, "custom log"));
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["title", "subject", "body", "moved", "lookup-failed", "malformed", "missing", "clean", "cancel"])(
  "land validates the final PR after CI: %s",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "land-final-"));
    const work = join(root, "work");
    const config = join(root, "config");
    const bin = join(root, "bin");
    const gitBin = Bun.which("git");
    if (!gitBin) throw new Error("missing git");
    let scanGroup: number | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      for (const path of [work, config, bin]) mkdirSync(path);
      const git = (...args: string[]) => sh([gitBin, ...args], { cwd: work });
      await git("init", "-qb", "main");
      await git("remote", "add", "origin", origin);
      writeFileSync(join(work, "file"), "base");
      await git("add", ".");
      await git("commit", "-qm", "base");
      const base = (await git("rev-parse", "HEAD")).stdout.trim();
      writeFileSync(join(work, "file"), "safe change");
      await git("commit", "-qam", "safe");
      const sha = (await git("rev-parse", "HEAD")).stdout.trim();
      const denied = scenario === "subject" ? "Fresh safe title" : entry;
      writeFileSync(join(config, "private-strings.txt"), denied);
      const final = { title: "Fresh safe title", body: "Fresh body\n\nSecond line\n", headRefOid: sha };
      if (scenario === "title") final.title = entry;
      if (scenario === "body") final.body = entry;
      if (scenario === "moved") final.headRefOid = "a".repeat(40);
      const calls = join(root, "gh-calls");
      const watched = join(root, "watched");
      const started = join(root, "scan-started");
      const pushed = join(root, "push-args");
      writeFileSync(
        join(bin, "gh"),
        `#!${process.execPath}\n
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args[1] === "list") console.log("123");
else if (args[0] === "run" && args[1] === "watch") writeFileSync(${JSON.stringify(watched)}, "ready");
else if (args[1] === "view") {
  if (args.includes("--jq")) console.log("safe-branch");
  else if (existsSync(${JSON.stringify(watched)})) {
    if (${JSON.stringify(scenario)} === "lookup-failed") process.exit(1);
    console.log(${JSON.stringify(scenario === "malformed" ? "not-json" : scenario === "missing" ? "{}" : JSON.stringify(final))});
  } else console.log(${JSON.stringify(JSON.stringify({ baseRefOid: base, body: "Initial safe body", headRefName: "safe-branch" }))});
}
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "bun"),
        `#!/bin/sh\ncase "$*" in *check-private-strings.ts*) exec '${process.execPath}' "$@" ;; esac\nexit 0\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh
${gitSubcommand}
if [ "$sub" = push ]; then printf '%s\\n' "$@" > '${pushed}'; exit 0; fi
${scenario === "cancel" ? `case "$*" in *cat-file*--batch*) sleep 60 & scan=$!; printf '%s %s' "$$" "$scan" > '${started}'; wait; exit 1 ;; esac` : ""}
exec '${gitBin}' "$@"
`,
        { mode: 0o755 },
      );
      child = Bun.spawn(["bash", script, "123", "Earlier subject", work], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LIMITLESS_CONFIG_DIR: config,
          TMPDIR: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (scenario === "cancel") {
        const deadline = Date.now() + 5000;
        while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(10);
        expect(existsSync(started)).toBe(true);
        const pids = readFileSync(started, "utf8").split(" ").map(Number);
        scanGroup = pids[0];
        const at = Date.now();
        child.kill("SIGTERM");
        await Promise.race([
          child.exited,
          Bun.sleep(4900).then(() => {
            throw new Error("land cancellation timed out");
          }),
        ]);
        expect(Date.now() - at).toBeLessThan(5000);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        expect(existsSync(pushed)).toBe(false);
      }
      const code = await child.exited;
      if (typeof child.stderr === "number") throw new Error("expected piped stderr");
      const stderr = await new Response(child.stderr).text();
      expect(stderr).not.toContain(denied);
      const recorded: string[][] = readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const merges = recorded.filter((args) => args[1] === "merge");
      if (scenario === "clean") {
        expect(code).toBe(0);
        expect(merges).toEqual([
          [
            "pr",
            "merge",
            "123",
            "-R",
            "MattFlower/limitless",
            "--squash",
            "--delete-branch",
            "--subject",
            final.title,
            "--body",
            final.body,
            "--match-head-commit",
            sha,
          ],
        ]);
      } else {
        expect(code).not.toBe(0);
        expect(merges).toEqual([]);
      }
      if (scenario !== "cancel") {
        expect(existsSync(watched)).toBe(true);
        const push = readFileSync(pushed, "utf8").trim().split("\n");
        expect(push).toContain("--no-verify");
        expect(push).toContain("--no-follow-tags");
        expect(push.at(-2)).toBe(origin);
        expect(push.at(-1)).toBe(`${sha}:refs/heads/safe-branch`);
      }
    } finally {
      if (scanGroup) {
        try {
          process.kill(-scanGroup, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
