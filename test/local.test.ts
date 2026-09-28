import { expect, test } from "bun:test";
import { manageLocal, twilightUnit } from "../src/cli/local.ts";
import type { sh } from "../src/util/proc.ts";

test("up generates the twilight unit once and never manages a Mac service", async () => {
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
  const opts = { modelPath: "/models/Qwen 27B.gguf", command, probe: async () => true };
  expect((await manageLocal("up", opts)).twilight.service).toBe("active");
  expect(calls.every((c) => c[0] === "ssh")).toBe(true);
  expect(input[0]).toContain('-m "/models/Qwen 27B.gguf"');
  expect(calls.some((c) => c.includes("daemon-reload"))).toBe(true);
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
  const opts = { modelPath: "", command, probe: async () => true };
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
    command,
    probe,
    secrets: { TWILIGHT_API_KEY: "tw-key", OMLX_API_KEY: "om-key" },
  });
  expect(probed).toEqual([
    ["http://127.0.0.1:8989/v1/models", "om-key"],
    ["http://twilight:8080/v1/models", "tw-key"],
  ]);
});

test("up reports a missing unit when no model path is configured", async () => {
  const command: typeof sh = async (args) => ({
    stdout: "",
    stderr: "",
    exitCode: args.includes("test") || args.includes("is-active") ? 1 : 0,
  });
  const opts = { modelPath: "", command, probe: async () => false };
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
    command,
    probe: async () => false,
  };
  const report = await manageLocal("down", opts);
  expect(report.omlx.endpoint).toBe("unavailable: missing OMLX_API_KEY");
  expect(report.twilight.service).toBe("unreachable");
  expect(calls.some((c) => c.includes("bootout"))).toBe(false);
  expect((await manageLocal("status", opts)).twilight.service).toBe("unreachable");
});

test("twilight down updates only stopped providers; up requires service and authenticated health", async () => {
  const updates: [string, boolean][] = [];
  const probed: string[] = [];
  let remoteReachable = true;
  let remoteHealthy = true;
  const command: typeof sh = async (args) => {
    if (args[0] === "ssh" && !remoteReachable) return { stdout: "", stderr: "", exitCode: 255 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const opts = {
    modelPath: "",
    command,
    secrets: { TWILIGHT_API_KEY: "key" },
    probe: async (url: string, token?: string) => {
      probed.push(`${url}:${token}`);
      return url.includes("twilight") ? remoteHealthy : true;
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
    ["twilight", false],
    ["twilight", false],
  ]);
  expect(probed).toEqual([]);
  updates.length = 0;
  remoteHealthy = false;
  await manageLocal("up", opts);
  expect(updates).toEqual([]);
  remoteHealthy = true;
  updates.length = 0;
  await manageLocal("up", opts);
  expect(updates).toEqual([["twilight", true]]);
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
        modelPath: "",
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
      expect(calls.every((args) => args[0] === "ssh")).toBe(true);
      expect(updates).toEqual([]);
    }
});
