import { afterEach, expect, spyOn } from "bun:test";
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
import { readPolicyScope } from "../src/harness/read-policy.ts";
import type { AgentEvent } from "../src/harness/types.ts";
import { protectPrivateFile } from "../src/util/private-reads.ts";
import { registerCredential } from "../src/util/proc.ts";
import { browserInstaller, browserSpec, fakeBrowserCache } from "./browser-mcp-support.ts";
import { test } from "./read-policy-support.ts";

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
  const server = browserMcp(spec, "codex", [], "darwin");
  expect(server?.command).toBe("/usr/bin/sandbox-exec");
  expect(server?.args[0]).toBe("-p");
  expect(server?.args[2]).toBe(realpathSync(Bun.which("node") ?? ""));
  expect(server?.args).toContain("--no-sandbox");
  expect(server?.args).not.toContain("--sandbox");
  expect(server?.args.slice(3, 5)).toEqual([
    join(cache, "node_modules/@playwright/mcp/cli.js"),
    "--headless",
  ]);
  expect(server?.args).toContain(join(cache, "browsers/chromium"));
  expect(events).toEqual([]);
  expect(fake.calls).toHaveLength(5);
});

test("provisioning refuses a CLI lacking browser-origin restriction support", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-incompatible-")));
  roots.push(root);
  const { runner, calls } = browserInstaller(root, "--headless --allowed-hosts");
  await expect(provisionBrowserMcp(root, runner)).rejects.toThrow("restriction options");
  expect(existsSync(join(root, "ready.json"))).toBe(false);
  expect(calls).toHaveLength(2);
});

test("operator provisioning records runtime libraries for an existing cache without reinstalling", async () => {
  const { root, cache, fake, spec } = await fixture();
  const manifest = join(cache, "ready.json");
  const record = JSON.parse(readFileSync(manifest, "utf8"));
  delete record.libraries;
  writeFileSync(manifest, JSON.stringify(record));
  const library = join(root, "runtime-library");
  writeFileSync(library, "library");
  const alias = join(root, "runtime-alias");
  symlinkSync(library, alias);
  const before = fake.calls.length;
  await provisionBrowserMcp(cache, async (opts) => ({
    ...(await fake.runner(opts)),
    stdout: JSON.stringify([alias, "/usr/lib/system-dyld-cache-image"]),
  }));
  expect(fake.calls.slice(before)).toHaveLength(1);
  expect(fake.calls[before]?.cmd).toContain("-e");
  const server = browserMcp(spec, "codex", [], "darwin");
  expect(server?.args[1]).toContain(`(subpath "${library}")`);
  expect(server?.args[1]).not.toContain(`(subpath "${root}")`);
  rmSync(library);
  expect(browserMcp(spec, "codex", [], "darwin")).toBeUndefined();
});

test("provisioning requires no-sandbox even when sandbox is advertised", async () => {
  const { root } = await fixture();
  const cache = join(root, "old-flags");
  const fake = browserInstaller(
    cache,
    "--headless --sandbox --user-data-dir --output-dir --allowed-origins --executable-path --block-service-workers --no-webmcp",
  );
  await expect(provisionBrowserMcp(cache, fake.runner)).rejects.toThrow("restriction options");
  expect(fake.calls).toHaveLength(2);
  expect(existsSync(join(cache, "ready.json"))).toBe(false);
});

test.each([
  ["claude", "readonly", "darwin", true],
  ["claude", "edit", "darwin", false],
  ["codex", "readonly", "darwin", true],
  ["codex", "edit", "darwin", true],
  ["codex", "readonly", "linux", false],
  ["claude", "readonly", "win32", false],
] as const)("browser path %s %s %s", async (harness, mode, platform, enabled) => {
  const { spec } = await fixture();
  const events: AgentEvent[] = [];
  spec.mode = mode;
  spec.onEvent = (event) => events.push(event);
  expect(!!browserMcp(spec, harness, [], platform)).toBe(enabled);
  expect(events).toHaveLength(enabled ? 0 : 1);
  for (const variant of [{ noTools: true }, { browser: undefined }]) {
    expect(browserMcp({ ...spec, ...variant }, harness, [], platform)).toBeUndefined();
  }
  expect(events).toHaveLength(enabled ? 0 : 1);
});

test("browser read allowlist and private denials enclose only its own writable directory", async () => {
  const { spec, cache, cwd, scratch, root } = await fixture();
  const privateFile = join(cache, "private-state");
  writeFileSync(privateFile, "private");
  const release = protectPrivateFile(privateFile);
  try {
    const server = readPolicyScope.run(
      { home: root, environment: {}, denyRead: [join(root, "configured-private")] },
      () => browserMcp(spec, "codex", [], "darwin"),
    );
    if (!server) throw new Error("missing server");
    const policy = server.args[1] ?? "";
    const directory = server.env.HOME ?? "";
    expect(policy).toContain("(deny file-read*)");
    expect(policy).toContain("(deny file-write*)");
    expect(policy).toContain(`(allow file-read* (subpath "${directory}") (subpath "${cache}")`);
    expect(policy).toContain(`(allow file-write* (subpath "${directory}")`);
    expect(policy).not.toContain(`(subpath "${cwd}")`);
    expect(policy).not.toContain(`(subpath "${scratch}")`);
    expect(policy).not.toContain(`(literal "${root}/package.json")`);
    for (const path of [privateFile, join(root, ".ssh"), join(root, "configured-private")]) {
      expect(policy.lastIndexOf(`(subpath "${path}")`)).toBeGreaterThan(policy.indexOf("(allow file-read*"));
    }
    for (const name of ["TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"])
      expect(server.env[name]).toBe(directory);
    const second = browserMcp(spec, "codex", [], "darwin");
    expect(second?.env.HOME).not.toBe(directory);
    expect(second?.args[1]).not.toContain(`(subpath "${directory}")`);
  } finally {
    release();
  }
});

test.each([
  ["http://127.0.0.1:43210/x?q=1", "http://127.0.0.1:43210"],
  ["http://127.0.0.1", "http://127.0.0.1"],
  ["https://[::1]", "https://[::1]"],
  ["https://LOCALHOST:443/x", "https://localhost"],
  ["http://[::1]:43210/x", "http://[::1]:43210"],
])("a loopback preview allows exactly its own origin: %s", async (url, origin) => {
  const { spec, scratch } = await fixture();
  if (!spec.browser) throw new Error("missing browser request");
  spec.browser.previewUrl = url;
  const args = browserMcp(spec, "codex", [], "darwin")?.args ?? [];
  expect(args[args.indexOf("--allowed-origins") + 1]).toBe(origin);
  const parsed = new URL(url);
  expect(args[1]).toContain("(deny network-outbound)");
  expect(args[1]).toContain(
    `(remote ip "${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? 443 : 80)}")`,
  );
  expect(args.filter((arg) => arg === "--allowed-origins")).toHaveLength(1);
  for (const flag of ["--user-data-dir", "--output-dir"])
    expect(args[args.indexOf(flag) + 1]?.startsWith(`${scratch}/browser-`)).toBe(true);
});

test.each(["claude", "codex"] as const)(
  "%s gets no browser from the unconfined pin, even with a valid cache, preview and scratch",
  async (harness) => {
    const { spec, scratch } = await fixture();
    const events: AgentEvent[] = [];
    spec.onEvent = (event) => events.push(event);
    expect(browserMcp(spec, harness, undefined, "darwin")).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({ code: "browser_unavailable", text: expect.stringContaining("not confined") }),
    ]);
    const text = events[0]?.type === "warning" ? events[0].text : "";
    expect(text).toContain("redirects");
    expect(text).toContain("filenames on output tools");
    expect(readdirSync(scratch).filter((name) => name.startsWith("browser-"))).toEqual([]);
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
  "zero port",
  "unavailable read policy",
  "rejected profile path",
  "private cache",
  "runtime in checkout",
  "runtime metadata missing",
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
  if (failure === "zero port") spec.browser.previewUrl = "http://localhost:0";
  if (failure === "rejected profile path") {
    const path = join(root, 'scratch-"');
    mkdirSync(path);
    spec.scratchDir = path;
  }
  if (failure === "private cache") spec.denyRead = [cache];
  if (failure === "runtime in checkout" || failure === "runtime metadata missing") {
    const path = join(cache, "ready.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (failure === "runtime metadata missing") delete record.libraries;
    else {
      writeFileSync(join(cwd, "runtime-library"), "library");
      record.libraries = [join(cwd, "runtime-library")];
    }
    writeFileSync(path, JSON.stringify(record));
  }
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
    // No confinement gaps, so each case fails only for its injected reason.
    const setup = () => browserMcp(spec, failure === "Claude editor" ? "claude" : "codex", [], "darwin");
    expect(
      failure === "unavailable read policy" ? readPolicyScope.run(undefined, setup) : setup(),
    ).toBeUndefined();
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
