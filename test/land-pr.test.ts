import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sh } from "../src/util/proc.ts";

const script = resolve("scripts/land-pr.sh");
const entry = "secret-host.example";

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
        ["diff", "absent", "relative"].includes(scenario) ? `${entry.toUpperCase()}\n` : "safe\n",
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
      // Stop permitted deliveries at commit so the script never reaches external delivery commands.
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\ncase "$1" in\ncommit) echo commit >> '${join(root, "mutations")}'; ${["post-commit", "destination"].includes(scenario) ? `exec '${gitBin}' -c user.name=t -c user.email=t@t commit -qm '${scenario === "post-commit" ? entry : "safe"}'` : "exit 17"} ;;\npush) echo push >> '${join(root, "mutations")}'; exit 17 ;;\nesac\nexec '${gitBin}' "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "bun"),
        `#!/bin/sh\ncase "$1" in\n*.ts) exec '${bunBin}' "$@" ;;\nesac\nexit 0\n`,
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

test("land records the worktree's Git paths before any PR code runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "land-record-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const calls = join(root, "calls");
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$1" = run ] && exit 1\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
    await sh(["bash", script, "123", "safe", root], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
      allowFail: true,
    });
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines[0]).toEndWith("check-private-strings.ts --record");
    expect(lines.indexOf("run check")).toBeGreaterThan(0);
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
      '#!/bin/sh\n[ "$1" = install ] || [ "$2" = --record ] && exit 0\necho "failed-check-$$"\nexit 1\n',
      { mode: 0o755 },
    );
    for (const name of ["git", "gh"])
      writeFileSync(join(bin, name), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
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
        `#!/bin/sh\ncase "$1" in *.ts) exec '${process.execPath}' "$@" ;; esac\nexit 0\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh
if [ "$1" = push ]; then printf '%s\\n' "$@" > '${pushed}'; exit 0; fi
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
          "push",
          "-q",
          "--no-follow-tags",
          "origin",
          "HEAD:refs/heads/safe-branch",
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
