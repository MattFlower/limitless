import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionBrowserMcp } from "../src/harness/browser-mcp.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { ProcOptions, ProcResult } from "../src/util/proc.ts";

export function browserInstaller(
  root: string,
  help = "--headless --sandbox --no-sandbox --user-data-dir --output-dir --allowed-origins --executable-path --block-service-workers --no-webmcp",
) {
  const calls: ProcOptions[] = [];
  const runner = async (opts: ProcOptions): Promise<ProcResult> => {
    calls.push(opts);
    const cmd = opts.cmd;
    let stdout = "";
    if (cmd.includes("--prefix")) {
      for (const [name, version] of [
        ["@playwright/mcp", "0.0.83"],
        ["playwright", "1.64.0-alpha-1790635538000"],
        ["playwright-core", "1.64.0-alpha-1790635538000"],
      ]) {
        const directory = join(root, "node_modules", name ?? "");
        mkdirSync(join(directory, "lib"), { recursive: true });
        writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
        writeFileSync(join(directory, "cli.js"), "// fake cached CLI\n");
        writeFileSync(join(directory, "lib/coreBundle.js"), "// fake restriction implementation\n");
      }
    } else if (cmd.includes("--help")) stdout = help;
    else if (cmd.includes("install") && cmd.includes("chromium")) {
      mkdirSync(join(root, "browsers"));
      const executable = join(root, "browsers", "chromium");
      writeFileSync(executable, "fake browser, never executed\n");
      chmodSync(executable, 0o700);
    } else if (cmd.some((arg) => arg.includes("sharedObjects"))) stdout = "[]";
    else if (cmd.includes("-e")) stdout = join(root, "browsers", "chromium");
    else throw new Error("Unexpected process: no real installers or downloads allowed");
    return {
      exitCode: 0,
      signal: null,
      cancelled: false,
      timedOut: false,
      idleTimedOut: false,
      stdout,
      stderr: "",
      truncated: false,
      durationMs: 0,
    };
  };
  return { calls, runner };
}

export async function fakeBrowserCache(root: string) {
  const fake = browserInstaller(root);
  await provisionBrowserMcp(root, fake.runner);
  return fake;
}

export const browserSpec = (cwd: string, scratchDir: string, cacheDir: string): AgentSpec => ({
  cwd,
  scratchDir,
  browser: { previewUrl: "http://127.0.0.1:43210/path", cacheDir },
  mode: "readonly",
  prompt: "UI verification",
  timeoutMs: 1000,
  idleTimeoutMs: 1000,
  maxToolCalls: 10,
  logPath: join(scratchDir, "log"),
  signal: new AbortController().signal,
  onEvent: () => {},
  target: {
    modelId: "test/model",
    model: "test",
    provider: "test",
    vendor: "test",
    harness: "fake",
    tier: 4,
    billing: "subscription",
  },
});
