import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/harness/claude.ts";
import type { AgentResult } from "../src/harness/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run runClaude against a stand-in `claude` executable that replays the given stream-json lines. */
async function replay(lines: unknown[], maxToolCalls: number): Promise<AgentResult> {
  const dir = mkdtempSync(join(tmpdir(), "limitless-hidden-claude-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' ${lines.map((l) => `'${JSON.stringify(l)}'`).join(" ")}\n`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    return await runClaude({
      cwd: dir,
      prompt: "x",
      mode: "readonly",
      noTools: true,
      jsonSchema: { type: "object" },
      target: {
        modelId: "c/m",
        provider: "claude",
        harness: "claude",
        model: "m",
        vendor: "anthropic",
        tier: 4,
        billing: "subscription",
      },
      timeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      maxToolCalls,
      signal: new AbortController().signal,
      logPath: join(dir, "log"),
      onEvent: () => {},
    });
  } finally {
    process.env.PATH = oldPath;
  }
}

const init = { type: "system", subtype: "init", session_id: "s1", model: "m" };
const toolUse = (name: string, input: unknown) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: `t-${name}`, name, input }] },
});
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "s1",
  num_turns: 1,
  total_cost_usd: 0,
  usage: {},
  result: "",
  structured_output: { ok: true },
};

test("a no-tools call that answers through StructuredOutput succeeds under a zero tool budget", async () => {
  const res = await replay([init, toolUse("StructuredOutput", { ok: true }), result], 0);
  expect(res.error).toBeNull();
  expect(res.status).toBe("ok");
  expect(res.structured).toEqual({ ok: true });
});

test("repeated StructuredOutput calls do not count as a tool loop", async () => {
  const calls = Array.from({ length: 8 }, () => toolUse("StructuredOutput", { ok: true }));
  const res = await replay([init, ...calls, result], 5);
  expect(res.status).toBe("ok");
  expect(res.structured).toEqual({ ok: true });
});

test("a real tool call still exceeds a zero tool budget", async () => {
  const res = await replay([init, toolUse("Read", { file_path: "x" }), result], 0);
  expect(res.status).toBe("stuck");
});
