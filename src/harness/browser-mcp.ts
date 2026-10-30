import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { agentEnv, redactCredentials, runProcess } from "../util/proc.ts";
import { dyldLinks } from "./dyld-links.ts";
import { homeReadPolicy, policySpellings } from "./read-policy.ts";
import { SANDBOX_EXEC, seatbeltProfile } from "./sandbox.ts";
import { validateScratch } from "./scratch.ts";
import type { AgentSpec } from "./types.ts";

export const BROWSER_MCP_VERSION = "0.0.83";
const CORE_VERSION = "1.64.0-alpha-1790635538000";
const FLAGS = [
  "--headless",
  "--no-sandbox",
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

// Gaps not yet proven closed on the paths that apply the factory profile; any entry disables the
// browser. Upstream flags are convenience guards: --allowed-origins does not stop redirects or other
// connections leaving the preview origin, and output filenames are not held to --output-dir. The
// profile closes both, shown by the unconfined probe in test/browser-mcp-seatbelt.test.ts against the
// pinned build (docs/browser-mcp-probes.md); factory gates skip that probe, and a skip is not evidence.
// Paths that cannot apply the profile (Claude editors, non-macOS) stay disabled before this check.
export const CONFINEMENT_GAPS: readonly string[] = [];

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
    libraries?: string[];
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
  const libraries = record.libraries?.map((path) => realpathSync(path));
  return { node, cli, browser, libraries };
}

/** Explicit operator action only; never called by invocation setup or an MCP server. */
export async function provisionBrowserMcp(root: string, runner = runProcess): Promise<void> {
  const recordRuntime = async (node: string) => {
    const result = await runner({
      cmd: [node, "-e", "console.log(JSON.stringify(process.report.getReport().sharedObjects))"],
      cwd: root,
      env: agentEnv(),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled)
      throw new Error("Cannot inspect browser Node runtime");
    const libraries: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(libraries) || !libraries.every((path) => typeof path === "string" && isAbsolute(path)))
      throw new Error("Invalid browser Node runtime libraries");
    const path = join(root, "ready.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // System dyld-cache images need not exist as regular files; the system allowances cover them.
    record.libraries = libraries
      .filter((path: string) => !path.startsWith("/usr/lib/") && !path.startsWith("/System/"))
      .map((path: string) => realpathSync(path));
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  };
  let existing: ReturnType<typeof installation> | undefined;
  try {
    existing = installation(root);
  } catch {}
  if (existing) {
    if (!existing.libraries) await recordRuntime(existing.node);
    return;
  }
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
  await recordRuntime(realpathSync(node));
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
  platform: string = process.platform,
): BrowserMcpServer | undefined {
  if (!spec.browser) return;
  try {
    if (spec.noTools) throw new Error("tool-less invocations get no MCP servers");
    if (harness === "claude" && spec.mode === "edit")
      throw new Error("Claude editor outer confinement cannot launch the browser safely");
    if (platform !== "darwin") throw new Error(`Browser confinement unavailable on ${platform}`);
    // The profile confines the preview's socket, IPv4 loopback and its port, not its web origin.
    const url = new URL(spec.browser.previewUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password)
      throw new Error("browser previews must be http://127.0.0.1:<port>");
    const scratch = validateScratch(spec);
    const cache = realpathSync(spec.browser.cacheDir);
    const cwd = realpathSync(spec.cwd);
    if ([scratch, cwd].some((path) => inside(path, cache) || inside(cache, path)))
      throw new Error("browser cache overlaps agent write roots");
    const { node, cli, browser, libraries } = installation(cache);
    const links = libraries ? dyldLinks(node, libraries) : [];
    if (
      [node, ...(libraries ?? []), ...links].some((runtime) =>
        [scratch, cwd].some((path) => inside(path, runtime)),
      )
    )
      throw new Error("browser runtime is agent-writable");
    if (gaps.length)
      throw new Error(`@playwright/mcp@${BROWSER_MCP_VERSION} is not confined: ${gaps.join("; ")}`);
    if (!libraries) throw new Error("Browser Node runtime needs operator provisioning");
    const directory = mkdtempSync(join(scratch, "browser-"));
    const profile = join(directory, "profile"),
      output = join(directory, "output");
    for (const path of [profile, output]) mkdirSync(path, { mode: 0o700 });
    const readable = [
      directory,
      cache,
      node,
      ...libraries,
      // What the pinned build needs to start and render, measured by removal (docs/browser-mcp-probes.md).
      // /System/Volumes/Data, which aliases user files including other invocations' scratch, stays denied.
      ...[
        "/System/Library", // frameworks and system fonts
        "/usr/lib", // system libraries
        "/usr/share/icu", // CoreFoundation's ICU data
        "/usr/share/langid", // language identification data; Chromium aborts without it
        "/dev/null", // OPENSSL_CONF below
      ].filter(existsSync),
    ];
    const policy = seatbeltProfile(
      {
        write: [directory],
        protect: [],
        ...homeReadPolicy(readable, false, spec.denyRead),
        allowRead: policySpellings(readable),
      },
      { host: url.hostname, port: Number(url.port), links },
    );
    // --allowed-origins restricts browser requests; --allowed-hosts would only govern the MCP HTTP
    // transport, which stdio does not use.
    return {
      // Agents start MCP servers in their checkout, which the profile denies; Node needs a readable cwd.
      command: "/usr/bin/env",
      args: [
        "-C",
        directory,
        SANDBOX_EXEC,
        "-p",
        policy,
        node,
        cli,
        "--headless",
        "--no-sandbox",
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
      env: {
        HOME: directory,
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        XDG_CACHE_HOME: directory,
        XDG_CONFIG_HOME: directory,
        // Chromium on macOS ignores TMPDIR; without this its profile lock cannot create its socket.
        MAC_CHROMIUM_TMPDIR: directory,
        // Node aborts when it cannot read an OpenSSL configuration, and Homebrew's is outside the profile.
        OPENSSL_CONF: "/dev/null",
        PLAYWRIGHT_BROWSERS_PATH: join(cache, "browsers"),
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
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
