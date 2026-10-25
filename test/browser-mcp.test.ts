import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserMcp, provisionBrowserMcp } from "../src/harness/browser-mcp.ts";
import type { AgentEvent } from "../src/harness/types.ts";
import { registerCredential } from "../src/util/proc.ts";
import { browserInstaller, browserSpec, fakeBrowserCache } from "./browser-mcp-support.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-mcp-")));
  roots.push(root);
  const cwd = join(root, "checkout"),
    scratch = join(root, "scratch"),
    cache = join(root, "cache");
  mkdirSync(cwd);
  mkdirSync(scratch);
  const fake = await fakeBrowserCache(cache);
  return { root, cwd, scratch, cache, fake, spec: browserSpec(cwd, scratch, cache) };
}

test("provisioning pins the package and installs chromium once, then resolves only the cached installation", async () => {
  const { cache, fake, spec } = await fixture();
  expect(fake.calls[0]?.cmd.slice(1)).toEqual([
    "install",
    "--prefix",
    cache,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    "@playwright/mcp@0.0.83",
  ]);
  expect(fake.calls[2]?.cmd.slice(1)).toEqual([
    join(cache, "node_modules/playwright/cli.js"),
    "install",
    "chromium",
  ]);
  expect(fake.calls[2]?.env.PLAYWRIGHT_BROWSERS_PATH).toBe(join(cache, "browsers"));
  await provisionBrowserMcp(cache, async () => {
    throw new Error("must reuse matching cache");
  });
  const events: AgentEvent[] = [];
  spec.onEvent = (event) => events.push(event);
  const server = browserMcp(spec, "codex");
  expect(server?.command).toBe(realpathSync(Bun.which("node") ?? ""));
  expect(server?.args.slice(0, 2)).toEqual([
    join(cache, "node_modules/@playwright/mcp/cli.js"),
    "--headless",
  ]);
  expect(server?.args).toContain(join(cache, "browsers/chromium"));
  expect(events).toEqual([]);
  expect(fake.calls).toHaveLength(4);
});

test("provisioning refuses a CLI lacking browser-origin restriction support", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-incompatible-")));
  roots.push(root);
  const { runner, calls } = browserInstaller(root, "--headless --allowed-hosts");
  await expect(provisionBrowserMcp(root, runner)).rejects.toThrow("restriction options");
  expect(existsSync(join(root, "ready.json"))).toBe(false);
  expect(calls).toHaveLength(2);
});

test.each([
  ["http://127.0.0.1:43210/x?q=1", "http://127.0.0.1:43210"],
  ["https://LOCALHOST:443/x", "https://localhost"],
  ["http://[::1]:43210/x", "http://[::1]:43210"],
])("a loopback preview allows exactly its own origin: %s", async (url, origin) => {
  const { spec, scratch } = await fixture();
  if (!spec.browser) throw new Error("missing browser request");
  spec.browser.previewUrl = url;
  const args = browserMcp(spec, "codex")?.args ?? [];
  expect(args[args.indexOf("--allowed-origins") + 1]).toBe(origin);
  expect(args.filter((arg) => arg === "--allowed-origins")).toHaveLength(1);
  for (const flag of ["--user-data-dir", "--output-dir"])
    expect(args[args.indexOf(flag) + 1]?.startsWith(`${scratch}/browser-`)).toBe(true);
});

test.each(["claude", "codex"] as const)(
  "%s gets the pinned browser with a valid cache, preview and scratch",
  async (harness) => {
    const { spec, scratch } = await fixture();
    const events: AgentEvent[] = [];
    spec.onEvent = (event) => events.push(event);
    const server = browserMcp(spec, harness);
    expect(server?.args).toContain("--headless");
    expect(events).toEqual([]);
    expect(readdirSync(scratch).filter((name) => name.startsWith("browser-"))).toHaveLength(1);
  },
);

test.each([
  "missing",
  "version",
  "changed implementation",
  "browser missing",
  "browser directory",
  "corrupt manifest",
  "escaped executable",
  "cache in checkout",
  "cache symlink",
  "scratch missing",
  "scratch failure",
  "invalid URL",
  "remote URL",
  "credential URL",
  "file URL",
  "Claude editor",
])("browser fails closed: %s", async (failure) => {
  const { root, spec, cache, scratch, cwd } = await fixture();
  const events: AgentEvent[] = [];
  spec.onEvent = (event) => events.push(event);
  if (!spec.browser) throw new Error("missing browser request");
  if (failure === "missing") rmSync(join(cache, "ready.json"));
  if (failure === "version")
    writeFileSync(join(cache, "node_modules/@playwright/mcp/package.json"), '{"version":"0.0.1"}');
  if (failure === "changed implementation")
    writeFileSync(join(cache, "node_modules/playwright-core/lib/coreBundle.js"), "changed");
  if (failure === "browser missing") rmSync(join(cache, "browsers/chromium"));
  if (failure === "browser directory") {
    rmSync(join(cache, "browsers/chromium"));
    mkdirSync(join(cache, "browsers/chromium"));
  }
  if (failure === "corrupt manifest") writeFileSync(join(cache, "ready.json"), "{");
  if (failure === "escaped executable") {
    const manifestPath = join(cache, "ready.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.browser = realpathSync(Bun.which("node") ?? "");
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  if (failure === "cache in checkout") spec.browser.cacheDir = cwd;
  if (failure === "cache symlink") {
    symlinkSync(cwd, join(root, "alias"));
    spec.browser.cacheDir = join(root, "alias");
  }
  if (failure === "scratch missing") spec.scratchDir = undefined;
  if (failure === "invalid URL") spec.browser.previewUrl = "not a URL";
  if (failure === "remote URL") spec.browser.previewUrl = "http://example.com:43210";
  if (failure === "credential URL") spec.browser.previewUrl = "http://user:password@localhost:43210";
  if (failure === "file URL") spec.browser.previewUrl = "file:///etc/hosts";
  if (failure === "Claude editor") spec.mode = "edit";
  const secret = "browser-secret-" + "fixture";
  registerCredential("browser-test", secret);
  const mkdir =
    failure === "scratch failure"
      ? spyOn(fs, "mkdtempSync").mockImplementation(() => {
          throw new Error(secret);
        })
      : undefined;
  try {
    expect(browserMcp(spec, failure === "Claude editor" ? "claude" : "codex")).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "warning",
      id: "browser-unavailable",
      text: expect.stringContaining("Browser disabled:"),
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(readFileSync(join(cache, "node_modules/@playwright/mcp/cli.js"), "utf8")).toContain(
      "fake cached CLI",
    );
    expect(existsSync(scratch)).toBe(true);
  } finally {
    mkdir?.mockRestore();
  }
});
