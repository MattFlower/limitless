import { expect, test } from "bun:test";
import { join } from "node:path";
import { manageLocal, remoteUnit } from "../src/cli/local.ts";
import { PROVIDERS, type ProviderDef } from "../src/router/catalog.ts";
import type { sh } from "../src/util/proc.ts";

const remoteHost = "example.com";
const providers: ProviderDef[] = [
  ...PROVIDERS,
  {
    id: "lan",
    harness: "claude",
    billing: "free",
    label: "LAN llama.cpp",
    maxConcurrent: 1,
    openaiBaseUrl: "http://example.com:8080/v1",
    healthUrl: "http://example.com:8080/v1/models",
    apiKeySecret: "REMOTE_API_KEY",
  },
];

test("local CLI help describes the explicit remote settings", () => {
  const child = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "../src/cli/main.ts"),
    "local",
    "--help",
  ]);
  expect(child.exitCode).toBe(0);
  const help = child.stdout.toString();
  for (const key of ["remote_host", "remote_model_path", "remote_llama_binary"]) expect(help).toContain(key);
});

test("up generates the remote unit once and never manages a Mac service", async () => {
  const calls: string[][] = [];
  const input: string[] = [];
  let unitInstalled = false;
  const command: typeof sh = async (args, opts) => {
    calls.push(args);
    if (opts.stdin) {
      input.push(opts.stdin);
      unitInstalled = true;
    }
    if (args.includes("test")) return { stdout: "", stderr: "", exitCode: unitInstalled ? 0 : 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const opts = {
    remoteHost,
    providers,
    remoteModelPath: "/models/Qwen 27B.gguf",
    command,
    probe: async () => true,
  };
  expect((await manageLocal("up", opts)).remote?.service).toBe("active");
  expect(calls.every((c) => c[0] === "ssh" && c.includes(remoteHost))).toBe(true);
  expect(input[0]).toContain('-m "/models/Qwen 27B.gguf"');
  expect(calls.some((c) => c.includes("daemon-reload"))).toBe(true);
  calls.length = 0;
  await manageLocal("up", opts);
  expect(calls.some((c) => c.includes("bootstrap"))).toBe(false);
  expect(calls.some((c) => c.includes("enable"))).toBe(true);
  expect(input).toHaveLength(1);
  const unit = remoteUnit("/models/a.gguf");
  for (const flag of ["--port 8080", "--alias local", "-ngl 99", "-c 131072", "--jinja", "--api-key-file"])
    expect(unit).toContain(flag);
  expect(unit).not.toContain("--api-key ");
});

test("up never overwrites an installed remote unit and needs no model path to start it", async () => {
  const calls: string[][] = [];
  const input: string[] = [];
  const command: typeof sh = async (args, opts) => {
    calls.push(args);
    if (opts.stdin) input.push(opts.stdin);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const opts = { remoteHost, providers, remoteModelPath: "", command, probe: async () => true };
  expect((await manageLocal("up", opts)).remote?.service).toBe("active");
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
    remoteHost,
    providers,
    remoteModelPath: "",
    command,
    probe,
    secrets: { REMOTE_API_KEY: "tw-key", OMLX_API_KEY: "om-key" },
  });
  expect(probed).toEqual([
    ["http://127.0.0.1:8989/v1/models", "om-key"],
    ["http://example.com:8080/v1/models", "tw-key"],
  ]);
});

test("up reports a missing unit when no model path is configured", async () => {
  const command: typeof sh = async (args) => ({
    stdout: "",
    stderr: "",
    exitCode: args.includes("test") || args.includes("is-active") ? 1 : 0,
  });
  const opts = { remoteHost, providers, remoteModelPath: "", command, probe: async () => false };
  expect((await manageLocal("up", opts)).remote?.service).toBe("unit missing: set [local].remote_model_path");
});

test("down is idempotent and unreachable remote is reported", async () => {
  const calls: string[][] = [];
  const command: typeof sh = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "", exitCode: args[0] === "ssh" ? 255 : 1 };
  };
  const opts = {
    remoteHost,
    providers,
    remoteModelPath: "/models/a.gguf",
    command,
    probe: async () => false,
  };
  const report = await manageLocal("down", opts);
  expect(report.omlx.endpoint).toBe("unavailable: missing OMLX_API_KEY");
  expect(report.remote?.service).toBe("unreachable");
  expect(calls.some((c) => c.includes("bootout"))).toBe(false);
  expect((await manageLocal("status", opts)).remote?.service).toBe("unreachable");
});

test("remote down updates only stopped providers; up requires service and authenticated health", async () => {
  const updates: [string, boolean][] = [];
  const probed: string[] = [];
  let remoteReachable = true;
  let remoteHealthy = true;
  const command: typeof sh = async (args) => {
    if (args[0] === "ssh" && !remoteReachable) return { stdout: "", stderr: "", exitCode: 255 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const opts = {
    remoteHost,
    providers,
    remoteModelPath: "",
    command,
    secrets: { REMOTE_API_KEY: "key" },
    probe: async (url: string, token?: string) => {
      probed.push(`${url}:${token}`);
      return url.includes("example.com") ? remoteHealthy : true;
    },
    setEnabled: async (id: string, enabled: boolean) => {
      updates.push([id, enabled]);
    },
  };
  remoteReachable = false;
  await manageLocal("down", opts);
  expect(updates).toEqual([]);
  expect(probed).toEqual([]);
  remoteReachable = true;
  await manageLocal("down", opts);
  await manageLocal("down", opts);
  expect(updates).toEqual([
    ["lan", false],
    ["lan", false],
  ]);
  expect(probed).toEqual([]);
  updates.length = 0;
  remoteHealthy = false;
  await manageLocal("up", opts);
  expect(updates).toEqual([]);
  remoteHealthy = true;
  updates.length = 0;
  await manageLocal("up", opts);
  expect(updates).toEqual([["lan", true]]);
  updates.length = 0;
  await manageLocal("status", opts);
  expect(updates).toEqual([]);
});

test("all local actions only report authenticated oMLX reachability", async () => {
  for (const action of ["up", "down", "status"] as const)
    for (const healthy of [true, false, undefined]) {
      const calls: string[][] = [],
        updates: string[] = [],
        probes: string[] = [];
      const report = await manageLocal(action, {
        remoteModelPath: "",
        secrets: healthy === undefined ? {} : { OMLX_API_KEY: "key" },
        command: async (args) => {
          calls.push(args);
          return { stdout: "", stderr: "", exitCode: 255 };
        },
        probe: async (url, token) => {
          probes.push(url);
          if (url.includes("8989")) expect(token).toBe("key");
          return healthy ?? false;
        },
        setEnabled: async (id) => {
          updates.push(id);
        },
      });
      expect(report.omlx).toEqual({
        service: "externally managed (oMLX.app / omlx start)",
        endpoint:
          healthy === undefined ? "unavailable: missing OMLX_API_KEY" : healthy ? "healthy" : "unreachable",
      });
      expect(probes.includes("http://127.0.0.1:8989/v1/models")).toBe(healthy !== undefined);
      expect(calls).toEqual([]);
      expect(report.remote).toBeUndefined();
      expect(updates).toEqual([]);
    }
});

test("remote management enables an anonymous configured provider without changing other endpoints", async () => {
  const updates: [string, boolean][] = [];
  const anonymous: ProviderDef = {
    id: "lan",
    label: "LAN",
    harness: "claude",
    billing: "free",
    maxConcurrent: 1,
    openaiBaseUrl: "http://example.com:8080/v1",
  };
  const opts = {
    remoteHost,
    providers: [{ ...anonymous, id: "other", openaiBaseUrl: "http://example.com:8989/v1" }, anonymous],
    command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    probe: async () => true,
    setEnabled: async (id: string, enabled: boolean) => {
      updates.push([id, enabled]);
    },
  };
  await manageLocal("up", opts);
  await manageLocal("down", opts);
  expect(updates).toEqual([
    ["lan", true],
    ["lan", false],
  ]);
});
