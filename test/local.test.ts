import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { manageLocal, twilightUnit } from "../src/cli/local.ts";
import type { sh } from "../src/util/proc.ts";

const dir = mkdtempSync(join(tmpdir(), "limitless-local-"));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("up generates units and starts services; repeated up avoids launchd bootstrap", async () => {
  const calls: string[][] = [];
  const input: string[] = [];
  let loaded = false;
  let unitInstalled = false;
  const command: typeof sh = async (args, opts) => {
    calls.push(args);
    if (opts.stdin) {
      input.push(opts.stdin);
      unitInstalled = true;
    }
    if (args.includes("test")) return { stdout: "", stderr: "", exitCode: unitInstalled ? 0 : 1 };
    const action = args.includes("print") ? "print" : args.includes("bootstrap") ? "bootstrap" : "other";
    if (action === "bootstrap") loaded = true;
    return { stdout: "", stderr: "", exitCode: action === "print" && !loaded ? 1 : 0 };
  };
  const path = join(dir, "agent.plist");
  const opts = { modelPath: "/models/Qwen 27B.gguf", mtplxPlistPath: path, command, probe: async () => true };
  expect((await manageLocal("up", opts)).twilight.service).toBe("active");
  expect(readFileSync(path, "utf8")).toContain("mtplx");
  const appDir = process.env.LIMITLESS_APP_DIR ?? join(homedir(), ".limitless", "app");
  expect(readFileSync(path, "utf8")).toContain(
    `<key>WorkingDirectory</key><string>${appDir.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`,
  );
  expect(input[0]).toContain('-m "/models/Qwen 27B.gguf"');
  expect(calls.some((c) => c.includes("bootstrap"))).toBe(true);
  calls.length = 0;
  await manageLocal("up", opts);
  expect(calls.some((c) => c.includes("bootstrap"))).toBe(false);
  expect(calls.some((c) => c.includes("enable"))).toBe(true);
  expect(input).toHaveLength(1);
  const unit = twilightUnit("/models/a.gguf");
  for (const flag of [
    "--port 8080",
    "--alias qwen3.8-27b",
    "-ngl 99",
    "-c 131072",
    "--jinja",
    "--api-key-file",
  ])
    expect(unit).toContain(flag);
  expect(unit).not.toContain("--api-key ");
});

test("up never overwrites an installed twilight unit and needs no model path to start it", async () => {
  const calls: string[][] = [];
  const input: string[] = [];
  const command: typeof sh = async (args, opts) => {
    calls.push(args);
    if (opts.stdin) input.push(opts.stdin);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const opts = { modelPath: "", mtplxPlistPath: join(dir, "agent.plist"), command, probe: async () => true };
  expect((await manageLocal("up", opts)).twilight.service).toBe("active");
  expect(input).toEqual([]);
  expect(calls.some((c) => c.includes("daemon-reload"))).toBe(false);
  expect(calls.some((c) => c.includes("enable"))).toBe(true);
});

test("health probes authenticate with the provider's key", async () => {
  const probed: [string, string | undefined][] = [];
  const command: typeof sh = async () => ({ stdout: "", stderr: "", exitCode: 0 });
  const probe = async (url: string, token?: string) => {
    probed.push([url, token]);
    return true;
  };
  await manageLocal("status", {
    modelPath: "",
    mtplxPlistPath: join(dir, "agent.plist"),
    command,
    probe,
    secrets: { TWILIGHT_API_KEY: "tw-key" },
  });
  expect(probed).toEqual([
    ["http://127.0.0.1:8000/v1/models", "mtplx-local"],
    ["http://twilight:8080/v1/models", "tw-key"],
  ]);
});

test("up reports a missing unit when no model path is configured", async () => {
  const command: typeof sh = async (args) => ({
    stdout: "",
    stderr: "",
    exitCode: args.includes("test") || args.includes("is-active") ? 1 : 0,
  });
  const opts = { modelPath: "", mtplxPlistPath: join(dir, "agent.plist"), command, probe: async () => false };
  expect((await manageLocal("up", opts)).twilight.service).toBe(
    "unit missing: set [local].twilight_model_path",
  );
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
