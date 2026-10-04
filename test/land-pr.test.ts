import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sh } from "../src/util/proc.ts";

const script = resolve("scripts/land-pr.sh");
const entry = "secret-host.example";

describe("land-pr private strings", () => {
  test.each(["diff", "filename", "body", "subject", "unreadable", "absent", "clean"])(
    "checks %s before committing or pushing",
    async (scenario) => {
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
        const sha = (await git("rev-parse", "HEAD")).stdout.trim();
        await git("worktree", "add", "-qb", "pr", work);
        const subject = scenario === "subject" ? entry.toUpperCase() : "Land safe change";
        const body = scenario === "body" ? entry.toUpperCase() : "Safe body";
        writeFileSync(join(root, "pr.json"), JSON.stringify({ baseRefOid: sha, body }));
        if (scenario === "unreadable") mkdirSync(join(config, "private-strings.txt"));
        else if (scenario !== "absent")
          writeFileSync(join(config, "private-strings.txt"), ` # comment\n\n ${entry} \n`);
        writeFileSync(
          join(work, "file.txt"),
          scenario === "diff" || scenario === "absent" ? `${entry.toUpperCase()}\n` : "safe\n",
        );
        if (scenario === "filename") writeFileSync(join(work, `${entry}.txt`), "safe\n");
        // Stop permitted deliveries at commit so the script never reaches external delivery commands.
        writeFileSync(
          join(bin, "git"),
          `#!/bin/sh\ncase "$1" in\ncommit|push) echo "$1" >> '${join(root, "mutations")}'; exit 17 ;;\nesac\nexec '${gitBin}' "$@"\n`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(bin, "bun"),
          `#!/bin/sh\ncase "$1" in\n*.ts) exec '${bunBin}' "$@" ;;\nesac\nexit 0\n`,
          { mode: 0o755 },
        );
        writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat '${join(root, "pr.json")}'\n`, { mode: 0o755 });
        const result = await sh(["bash", script, "123", subject, work], {
          cwd: root,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIMITLESS_CONFIG_DIR: config },
          allowFail: true,
        });
        expect(result.exitCode).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`.toLowerCase()).not.toContain(entry);
        expect((await git("-C", work, "rev-parse", "HEAD")).stdout.trim()).toBe(sha);
        if (scenario === "absent" || scenario === "clean") {
          expect(readFileSync(join(root, "mutations"), "utf8")).toBe("commit\n");
        } else {
          expect(existsSync(join(root, "mutations"))).toBe(false);
          expect(result.stderr).toContain(
            scenario === "unreadable" ? "Cannot read private-strings.txt" : "entry 3 in private-strings.txt",
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
