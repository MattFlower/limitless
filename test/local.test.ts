import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manageLocal, twilightUnit } from "../src/cli/local.ts";
import type { sh } from "../src/util/proc.ts";

const dir = mkdtempSync(join(tmpdir(), "limitless-local-"));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("up generates units and starts services; repeated up avoids launchd bootstrap", async () => {
  const calls: string[][] = [];
  const input: string[] = [];
  let loaded = false;
  const command: typeof sh = async (args, opts) => {
    calls.push(args);
    if (opts.stdin) input.push(opts.stdin);
    const action = args.includes("print") ? "print" : args.includes("bootstrap") ? "bootstrap" : "other";
    if (action === "bootstrap") loaded = true;
    return { stdout: "", stderr: "", exitCode: action === "print" && !loaded ? 1 : 0 };
  };
  const path = join(dir, "agent.plist");
  const opts = { modelPath: "/models/Qwen 27B.gguf", mtplxPlistPath: path, command, probe: async () => true };
  expect((await manageLocal("up", opts)).twilight.service).toBe("active");
  expect(readFileSync(path, "utf8")).toContain("mtplx");
  expect(input[0]).toContain('-m "/models/Qwen 27B.gguf"');
  expect(calls.some((c) => c.includes("bootstrap"))).toBe(true);
  calls.length = 0;
  await manageLocal("up", opts);
  expect(calls.some((c) => c.includes("bootstrap"))).toBe(false);
  expect(calls.some((c) => c.includes("enable"))).toBe(true);
  expect(twilightUnit("/models/a.gguf")).toContain("--port 8080");
});

test("down is idempotent and unreachable twilight is reported", async () => {
  const calls: string[][] = [];
  const command: typeof sh = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "", exitCode: args[0] === "ssh" ? 255 : 1 };
  };
  const opts = {
    modelPath: "/models/a.gguf",
    mtplxPlistPath: join(dir, "absent.plist"),
    command,
    probe: async () => false,
  };
  const report = await manageLocal("down", opts);
  expect(report.mtplx).toEqual({ service: "stopped", endpoint: "unreachable" });
  expect(report.twilight.service).toBe("unreachable");
  expect(calls.some((c) => c.includes("bootout"))).toBe(false);
  expect((await manageLocal("status", opts)).twilight.service).toBe("unreachable");
});
