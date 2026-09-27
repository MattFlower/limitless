import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClaudeArgs, runClaude } from "../src/harness/claude.ts";
import { buildCodexArgs, runCodex } from "../src/harness/codex.ts";
import { SCRATCH_NAME, scratchEnv, withScratch } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { ProcOptions, ProcResult } from "../src/util/proc.ts";

const specFor = (cwd: string, scratchDir: string): AgentSpec => ({
  cwd,
  scratchDir,
  prompt: "test",
  mode: "readonly",
  timeoutMs: 1000,
  idleTimeoutMs: 1000,
  maxToolCalls: 10,
  logPath: join(scratchDir, "log"),
  signal: new AbortController().signal,
  onEvent: () => {},
  target: {
    modelId: "test/model",
    provider: "test",
    harness: "fake",
    model: "test",
    vendor: "test",
    tier: 4,
    billing: "subscription",
  },
});
const procResult: ProcResult = {
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  idleTimedOut: false,
  stdout: "",
  stderr: "",
  truncated: false,
  durationMs: 1,
};

test("scratch is outside inherited TMPDIR in checkout, unique concurrently, removed after throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "scratch-test-"));
  const inherited = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const paths: string[] = [];
  try {
    process.env.TMPDIR = root;
    await Promise.all(
      [0, 1, 2].map((n) =>
        withScratch(root, async (path) => {
          paths.push(path);
          expect(path.startsWith(realpathSync(root))).toBe(false);
          writeFileSync(join(path, "fixture"), "data");
          await Bun.sleep(5);
          expect(existsSync(path)).toBe(true);
          expect(process.env.TMPDIR).toBe(root);
          if (n === 2) throw new Error("failure");
        }).catch((e: Error) => expect(e.message).toBe("failure")),
      ),
    );
    expect(new Set(paths).size).toBe(3);
    for (const path of paths) expect(existsSync(dirname(path))).toBe(false);
    expect(process.env.TMP).toBe(inherited.TMP);
    expect(process.env.TEMP).toBe(inherited.TEMP);
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("native arguments restrict reading writes and preserve no-tools isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "args with spaces-"));
  const cwd = join(root, "worktree");
  const scratch = join(root, "scratch space", SCRATCH_NAME);
  mkdirSync(cwd);
  mkdirSync(scratch, { recursive: true });
  try {
    const spec = specFor(cwd, scratch);
    const codex = buildCodexArgs(spec);
    expect(codex).toContain("--strict-config");
    expect(codex).toContain("--ignore-user-config");
    expect(codex).not.toContain("workspace-write");
    expect(codex).not.toContain("--add-dir");
    const policy = codex.find((arg) => arg.startsWith("permissions="));
    expect(policy).toBe(
      `permissions={limitless-reader={filesystem={"/"="read",${JSON.stringify(realpathSync(scratch))}="write"},network={enabled=false}}}`,
    );
    const claude = buildClaudeArgs(spec, "id");
    const settings = JSON.parse(claude[claude.indexOf("--settings") + 1] ?? "{}");
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [realpathSync(scratch)], denyWrite: [realpathSync(cwd)] },
    });
    expect(claude[claude.indexOf("--setting-sources") + 1]).toBe("");
    // Claude derives its sandbox TMPDIR from the parent; another name would silently diverge.
    const misnamed = join(root, "misnamed");
    mkdirSync(misnamed);
    expect(() => buildClaudeArgs({ ...spec, scratchDir: misnamed }, "id")).toThrow(SCRATCH_NAME);
    for (const build of [buildCodexArgs, (s: AgentSpec) => buildClaudeArgs(s, "id")]) {
      expect(() => build({ ...spec, addDirs: [root] })).toThrow("additional directories");
      expect(() => build({ ...spec, scratchDir: cwd })).toThrow("separate");
      expect(() => build({ ...spec, scratchDir: undefined })).toThrow("requires a scratch");
    }
    const noTools = buildCodexArgs({ ...spec, noTools: true });
    expect(noTools).toContain("read-only");
    expect(noTools).toContain("shell_tool");
    expect(noTools.some((arg) => arg.startsWith("permissions="))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const outcome of ["success", "error", "timeout", "cancelled"] as const) {
  test(`native injected process environment and cleanup: ${outcome}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "env-test-"));
    const parent = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    const paths: string[] = [];
    try {
      for (const run of [runClaude, runCodex]) {
        await withScratch(cwd, async (scratchDir) => {
          paths.push(scratchDir);
          const spec = specFor(cwd, scratchDir);
          spec.target.backend = { baseUrl: "http://backend.invalid", authToken: "backend-only-token" };
          const runner = async (opts: ProcOptions): Promise<ProcResult> => {
            expect(opts.env).toMatchObject(scratchEnv(spec));
            expect(opts.env.GH_TOKEN).toBe("limitless-agents-have-no-github-access");
            if (run === runClaude) {
              expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBe("backend-only-token");
              expect(opts.env.CLAUDE_CODE_TMPDIR).toBe(dirname(scratchDir));
              expect(join(opts.env.CLAUDE_CODE_TMPDIR ?? "", SCRATCH_NAME)).toBe(scratchDir);
            } else expect(opts.env.CLAUDE_CODE_TMPDIR).toBeUndefined();
            expect(existsSync(scratchDir)).toBe(true);
            writeFileSync(join(scratchDir, "fixture"), "ok");
            if (outcome === "error") throw new Error("injected process failure");
            opts.onStdoutLine?.(
              run === runClaude
                ? '{"type":"result","subtype":"success","result":"ok"}'
                : '{"type":"turn.completed","usage":{}}',
            );
            return { ...procResult, timedOut: outcome === "timeout", cancelled: outcome === "cancelled" };
          };
          if (outcome === "error")
            await expect(run(spec, runner)).rejects.toThrow("injected process failure");
          else expect((await run(spec, runner)).status).toBe(outcome === "success" ? "ok" : outcome);
        });
      }
      expect(paths[0]).not.toBe(paths[1]);
      for (const path of paths) expect(existsSync(dirname(path))).toBe(false);
      expect({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }).toEqual(parent);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
