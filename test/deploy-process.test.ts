import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployProcess, mainSha, selfRepository } from "../src/land/deploy-process.ts";
import { registerCredential, sh } from "../src/util/proc.ts";

const sha = "b".repeat(40);
const result = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

test("production resolvers read release origin and exact remote main with timeouts", async () => {
  for (const origin of [
    "git@github.com:test/self.git",
    "https://github.com/test/self.git",
    "ssh://git@github.com/test/self.git",
  ]) {
    const command: typeof sh = async (args, opts) => {
      expect(args).toEqual(["git", "remote", "get-url", "origin"]);
      expect(opts).toMatchObject({ cwd: "release", timeoutMs: 10_000 });
      return result(`${origin}\n`);
    };
    expect(await selfRepository("release", command)).toBe("test/self");
  }
  const command: typeof sh = async (args, opts) => {
    expect(args).toEqual(["git", "ls-remote", "origin", "refs/heads/main"]);
    expect(opts).toMatchObject({ cwd: "release", timeoutMs: 30_000 });
    return result(`${sha}\trefs/heads/main\n`);
  };
  expect(await mainSha("release", command)).toBe(sha);
  await expect(mainSha("release", async () => result(""))).rejects.toThrow("main SHA");
  await expect(
    selfRepository("release", async () => result("https://example.com/test/self.git")),
  ).rejects.toThrow("not a GitHub repository");
});

for (const exitCode of [0, 1]) {
  test(`deploy job runs exact SHA with smoke independently of the daemon, exit ${exitCode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "limitless-deploy-process space-"));
    const secret = `deploy-output-${crypto.randomUUID()}`;
    registerCredential("DEPLOY_PROCESS_TEST", secret);
    const calls: string[][] = [];
    try {
      mkdirSync(join(root, "src/cli"), { recursive: true });
      writeFileSync(
        join(root, "src/cli/main.ts"),
        `console.log(${JSON.stringify(`lock held ${secret}`)}); process.exit(${exitCode});`,
      );
      const command: typeof sh = async (args) => {
        calls.push(args);
        if (args[1] === "submit") {
          const log = args[args.indexOf("-o") + 1];
          const status = args[args.indexOf("auto-deploy") + 1];
          if (!log || !status) throw new Error("missing deploy output paths");
          const completed = await sh(args.slice(args.indexOf("--") + 1), {
            cwd: root,
            allowFail: true,
            timeoutMs: 10_000,
          });
          writeFileSync(log, completed.stdout + completed.stderr);
        }
        return result();
      };
      const outcome = await deployProcess(root, sha, command, root);
      expect(calls[0]?.slice(0, 2)).toEqual(["launchctl", "submit"]);
      expect(calls[0]).toContain(`LIMITLESS_APP_DIR=${root}`);
      expect(calls[0]?.slice(-5)).toEqual([
        process.execPath,
        join(root, "src/cli/main.ts"),
        "deploy",
        sha,
        "--smoke",
      ]);
      expect(calls[1]?.slice(0, 2)).toEqual(["launchctl", "remove"]);
      expect(outcome.ok).toBe(exitCode === 0);
      if (!outcome.ok) {
        expect(outcome.reason).toContain("lock held");
        expect(outcome.reason).not.toContain(secret);
        expect(outcome.reason).toContain("[redacted]");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
