import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { agentEnv, redactCredentials, runProcess } from "../util/proc.ts";
import { validateScratch } from "./scratch.ts";
import type { AgentSpec } from "./types.ts";

export const BROWSER_MCP_VERSION = "0.0.83";
const CORE_VERSION = "1.64.0-alpha-1790635538000";
const FLAGS = [
  "--headless",
  "--sandbox",
  "--user-data-dir",
  "--output-dir",
  "--allowed-origins",
  "--executable-path",
  "--block-service-workers",
  "--no-webmcp",
];
// The pinned server also exposes RCE, routing and configuration tools. Grant only UI operations.
export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_wait_for",
  "browser_tabs",
  "browser_close",
  "browser_resize",
  "browser_handle_dialog",
  "browser_console_messages",
  "browser_network_requests",
  "browser_take_screenshot",
];

// The server runs outside the agent sandbox, and upstream documents its guards as convenience
// guardrails, not a security boundary. No browser starts while any of these remains.
export const CONFINEMENT_GAPS = [
  "--allowed-origins does not stop redirects or other browser connections leaving the preview origin",
  "explicit filenames on output tools bypass --output-dir and can write into the checkout",
];

export const browserCache = (home: string) => join(home, "tools", `playwright-mcp-${BROWSER_MCP_VERSION}`);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const packagePath = (root: string, name: string) => join(root, "node_modules", name);

function installation(root: string) {
  root = realpathSync(root);
  const record = JSON.parse(readFileSync(join(root, "ready.json"), "utf8")) as {
    node: string;
    browser: string;
    hashes: string[];
  };
  const cli = realpathSync(join(packagePath(root, "@playwright/mcp"), "cli.js"));
  const core = realpathSync(join(packagePath(root, "playwright-core"), "lib/coreBundle.js"));
  for (const [name, version] of [
    ["@playwright/mcp", BROWSER_MCP_VERSION],
    ["playwright-core", CORE_VERSION],
    ["playwright", CORE_VERSION],
  ] as const) {
    if (JSON.parse(readFileSync(join(packagePath(root, name), "package.json"), "utf8")).version !== version)
      throw new Error("incompatible pinned browser installation");
  }
  const browser = realpathSync(record.browser);
  if (
    ![cli, core, browser].every((path) => inside(root, path)) ||
    [cli, core].some((path, i) => digest(path) !== record.hashes[i])
  )
    throw new Error("browser installation changed or escaped its cache");
  const node = realpathSync(record.node);
  for (const path of [node, browser]) {
    if (!statSync(path).isFile()) throw new Error("browser installation needs executable files");
    accessSync(path, constants.X_OK);
  }
  return { node, cli, browser };
}

/** Explicit operator action only; never called by invocation setup or an MCP server. */
export async function provisionBrowserMcp(root: string, runner = runProcess): Promise<void> {
  try {
    installation(root);
    return;
  } catch {}
  mkdirSync(root, { recursive: true, mode: 0o700 });
  root = realpathSync(root);
  const node = Bun.which("node");
  const npm = Bun.which("npm");
  if (!node || !npm) throw new Error("Browser provisioning requires node and npm");
  const env = {
    ...agentEnv(),
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers"),
  };
  const run = async (cmd: string[]) => {
    const result = await runner({ cmd, cwd: root, env, timeoutMs: 300_000 });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled)
      throw new Error("Browser provisioning command failed");
    return result.stdout.trim();
  };
  await run([
    realpathSync(npm),
    "install",
    "--prefix",
    root,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    `@playwright/mcp@${BROWSER_MCP_VERSION}`,
  ]);
  const cli = join(packagePath(root, "@playwright/mcp"), "cli.js");
  const help = await run([realpathSync(node), cli, "--help"]);
  if (!FLAGS.every((flag) => help.split(/[\s,]+/).includes(flag)))
    throw new Error("Pinned browser server lacks required restriction options");
  await run([realpathSync(node), join(packagePath(root, "playwright"), "cli.js"), "install", "chromium"]);
  const browser = await run([
    realpathSync(node),
    "-e",
    "console.log(require('playwright-core').chromium.executablePath())",
  ]);
  writeFileSync(
    join(root, "ready.json"),
    JSON.stringify({
      node: realpathSync(node),
      browser,
      hashes: [digest(cli), digest(join(packagePath(root, "playwright-core"), "lib/coreBundle.js"))],
    }),
    { mode: 0o600 },
  );
  installation(root);
}

export interface BrowserMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function browserMcp(
  spec: AgentSpec,
  harness: "claude" | "codex",
  gaps: readonly string[] = CONFINEMENT_GAPS,
): BrowserMcpServer | undefined {
  if (!spec.browser || spec.noTools) return;
  try {
    if (harness === "claude" && spec.mode === "edit")
      throw new Error("Claude editor outer confinement cannot launch the browser safely");
    const url = new URL(spec.browser.previewUrl);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error("preview URL must be HTTP(S) loopback without credentials");
    const scratch = validateScratch(spec);
    const cache = realpathSync(spec.browser.cacheDir);
    const cwd = realpathSync(spec.cwd);
    if ([scratch, cwd].some((path) => inside(path, cache) || inside(cache, path)))
      throw new Error("browser cache overlaps agent write roots");
    const { node, cli, browser } = installation(cache);
    if ([scratch, cwd].some((path) => inside(path, node)))
      throw new Error("browser runtime is agent-writable");
    if (gaps.length)
      throw new Error(`@playwright/mcp@${BROWSER_MCP_VERSION} is not confined: ${gaps.join("; ")}`);
    const directory = mkdtempSync(join(scratch, "browser-"));
    const profile = join(directory, "profile"),
      output = join(directory, "output");
    for (const path of [profile, output]) mkdirSync(path, { mode: 0o700 });
    // --allowed-origins restricts browser requests; --allowed-hosts would only govern the MCP HTTP
    // transport, which stdio does not use.
    return {
      command: node,
      args: [
        cli,
        "--headless",
        "--sandbox",
        "--user-data-dir",
        profile,
        "--output-dir",
        output,
        "--allowed-origins",
        url.origin,
        "--executable-path",
        browser,
        "--block-service-workers",
        "--no-webmcp",
      ],
      env: { PLAYWRIGHT_BROWSERS_PATH: join(cache, "browsers"), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    };
  } catch (error) {
    spec.onEvent({
      type: "warning",
      id: "browser-unavailable",
      code: "browser_unavailable",
      text: redactCredentials(
        `Browser disabled: ${error instanceof Error ? error.message : "configuration unavailable"}`,
      ),
    });
    return;
  }
}
