import { describe, expect, test } from "bun:test";
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

const script = resolve("scripts/land-pr.sh");
const entry = "secret-host.example";
// Fake git scripts dispatch on the subcommand, after the global options land prepends.
const gitSubcommand =
  'sub=""; skip=""; for a in "$@"; do if [ -n "$skip" ]; then skip=""; continue; fi; case "$a" in -c|-C) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac; done';
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
  ])("checks %s before committing or pushing", async (scenario) => {
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
      if (scenario.startsWith("utf16-")) await git("config", "i18n.logOutputEncoding", "UTF-16");
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
      // Stop permitted deliveries at commit so the script never reaches external delivery commands.
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\n${gitSubcommand}\ncase "$sub" in\ncommit) echo commit >> '${join(root, "mutations")}'; ${["post-commit", "destination"].includes(scenario) ? `exec '${gitBin}' -c user.name=t -c user.email=t@t commit -qm '${scenario === "post-commit" ? entry : "safe"}'` : "exit 17"} ;;\npush) echo push >> '${join(root, "mutations")}'; exit 17 ;;\nesac\nexec '${gitBin}' "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "bun"),
        `#!/bin/sh\ncase "$*" in\n*check-private-strings.ts*) exec '${bunBin}' "$@" ;;\nesac\nexit 0\n`,
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
          TMPDIR: root,
        },
        allowFail: true,
      });
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`.toLowerCase()).not.toContain(entry);
      if (scenario.endsWith("author-email")) expect(result.stderr).toContain("author email");
      if (!["post-commit", "destination"].includes(scenario))
        expect((await git("-C", work, "rev-parse", "HEAD")).stdout.trim()).toBe(expectedHead);
      if (["absent", "clean", "excluded"].includes(scenario)) {
        expect(readFileSync(join(root, "mutations"), "utf8")).toBe("commit\n");
      } else {
        if (["post-commit", "destination"].includes(scenario))
          expect(readFileSync(join(root, "mutations"), "utf8")).toBe("commit\n");
        else expect(existsSync(join(root, "mutations"))).toBe(false);
        expect(result.stderr).toContain(
          ["unreadable", "malformed", "dangling"].includes(scenario)
            ? "Cannot read private-strings.txt"
            : ["inside", "alias", "source-inside"].includes(scenario)
              ? "inside repository"
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

test.each(["redirect", "redirect-and-move-head"])(
  "land publishes only its trusted SHA: %s",
  async (scenario) => {
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
      await git("worktree", "add", "-qb", "pr", work);
      await git("remote", "add", "origin", remote);
      await git("-C", alternate, "remote", "set-url", "origin", remote);
      await git("config", "push.followTags", "true");
      await git("tag", "-am", "safe tag", "local-tag");
      // Make the alternate commit available to HEAD-movement attacks without publishing it.
      await git("fetch", "-q", alternate, "main");
      writeFileSync(join(work, "file"), "safe change\n");
      writeFileSync(join(config, "private-strings.txt"), entry);
      const paths = [
        realpathSync(work),
        realpathSync(join(source, ".git/worktrees/work")),
        realpathSync(join(source, ".git")),
      ];
      const recorded = await sh([process.execPath, resolve("scripts/check-private-strings.ts"), "--record"], {
        cwd: work,
      });
      expect(recorded.stdout.trim().split("\n")).toEqual(paths);
      expect(JSON.parse(readFileSync(`${work}.git-paths`, "utf8"))).toEqual(paths);
      const calls = join(root, "calls");
      const pinned = join(root, "pinned");
      writeFileSync(
        join(bin, "bun"),
        `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "bun", args, paths }) + "\\n");
if (args[0] === "install" || args[0] === "run") {
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
}
if (args[0] === "run") writeFileSync(${JSON.stringify(join(work, ".git"))}, "gitdir: " + ${JSON.stringify(join(alternate, ".git"))} + "\\n");
if (args[0].endsWith(".ts")) {
  if (args.length === 6) {
    writeFileSync(${JSON.stringify(pinned)}, args[5]);
    if (${JSON.stringify(scenario)} === "redirect-and-move-head") {
      const moved = spawnSync(${JSON.stringify(gitBin)}, ["update-ref", "refs/heads/pr", ${JSON.stringify(value.denied)}], { stdio: "inherit" });
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
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "git", args, paths: [process.env.GIT_WORK_TREE, process.env.GIT_DIR, process.env.GIT_COMMON_DIR] }) + "\\n");
const result = spawnSync(${JSON.stringify(gitBin)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "gh"),
        `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "gh", args }) + "\\n");
if (args[0] === "run" && args[1] === "list") console.log("123");
else if (args[1] === "view") {
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
          TMPDIR: root,
        },
        allowFail: true,
      });
      expect(result.stderr).not.toContain(entry);
      expect((await git("--git-dir", remote, "rev-list", "--all")).stdout.trim().split("\n")).not.toContain(
        value.denied,
      );
      expect((await git("--git-dir", remote, "log", "--all", "--format=%B")).stdout).not.toContain(entry);
      expect(result.exitCode).toBe(0);
      const sha = readFileSync(pinned, "utf8");
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
      expect(sha).not.toBe(value.base);
      expect(sha).not.toBe(value.denied);
      for (const command of ["install", "run"]) {
        expect(JSON.parse(readFileSync(join(root, `fixture-${command}-state`), "utf8"))).toEqual([
          [value.base, ""],
          [value.base, ""],
        ]);
        expect(
          (await git("-C", join(root, `fixture-${command}`), "log", "-1", "--format=%s")).stdout.trim(),
        ).toBe(`test fixture ${command}`);
      }
      const logged: { tool: string; args: string[]; paths?: (string | null)[] }[] = readFileSync(
        calls,
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const installed = logged.findIndex((call) => call.tool === "bun" && call.args[0] === "install");
      const recordedAt = logged.findIndex((call) => call.tool === "recorded");
      expect(recordedAt).toBeGreaterThan(0);
      expect(installed).toBeGreaterThan(recordedAt);
      for (const call of logged.slice(recordedAt + 1).filter((call) => call.tool !== "gh")) {
        const check = call.tool === "bun" && ["install", "run"].includes(call.args[0] ?? "");
        expect(call.paths).toEqual(check ? [null, null, null] : paths);
      }
      const commands = (tool: string, command: string) =>
        logged.filter((call) => call.tool === tool && call.args.includes(command)).map((call) => call.args);
      expect(commands("bun", sha)).toEqual([
        [resolve("scripts/check-private-strings.ts"), "123", "MattFlower/limitless", "safe", "pr", sha],
        [resolve("scripts/check-private-strings.ts"), "123", "MattFlower/limitless", "--merge", sha],
      ]);
      expect(commands("git", "push")).toEqual([
        [...hardened, "push", "--no-verify", "-q", "--no-follow-tags", "origin", `${sha}:refs/heads/pr`],
      ]);
      expect(commands("git", "HEAD")).toEqual([[...hardened, "rev-parse", "HEAD"]]);
      expect(commands("git", "rev-list").some((args) => args.includes(`${value.base}..${sha}`))).toBe(true);
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
      expect(readFileSync(join(work, ".git"), "utf8")).toContain(join(alternate, ".git"));
      if (scenario === "redirect-and-move-head")
        expect((await git("rev-parse", "pr")).stdout.trim()).toBe(value.denied);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
      '#!/bin/sh\ncase "$*" in *--absolute-git-dir) echo "$PWD/admin" ;; *--git-common-dir) echo "$PWD/common" ;; esac\n',
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
      `#!/bin/sh\ncase "$*" in *--absolute-git-dir) echo "$PWD/admin" ;; *--git-common-dir) echo "$PWD/common" ;; *) touch '${marker}'; exit 1 ;; esac\n`,
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
        expect(readFileSync(pushed, "utf8").trim().split("\n")).toEqual([
          ...hardened,
          "push",
          "--no-verify",
          "-q",
          "--no-follow-tags",
          "origin",
          `${sha}:refs/heads/safe-branch`,
        ]);
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
