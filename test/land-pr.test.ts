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
    "head-ref",
    "encoded",
    "malformed",
    "dangling",
    "inside",
    "alias",
    "relative",
    "excluded",
    "lfs",
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
      if (["history", "message"].includes(scenario)) {
        writeFileSync(join(work, "transient.txt"), scenario === "history" ? entry : "safe");
        await commit(scenario === "message" ? `Safe subject\n\n${entry}` : "safe");
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
          `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`,
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

test("land logs honor TMPDIR and overrides and are unique for concurrent failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "land-logs-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const marker = join(root, "published");
    writeFileSync(
      join(bin, "bun"),
      '#!/bin/sh\n[ "$1" = install ] && exit 0\necho "failed-check-$$"\nexit 1\n',
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
