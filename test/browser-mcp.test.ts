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
import { SANDBOX_EXEC } from "../src/harness/sandbox.ts";
import type { AgentEvent } from "../src/harness/types.ts";
import { protectPrivateFile } from "../src/util/private-reads.ts";
import { agentEnv, registerCredential, runProcess } from "../src/util/proc.ts";
import { browserInstaller, browserSpec, fakeBrowserCache, machO } from "./browser-mcp-support.ts";
import { test } from "./read-policy-support.ts";

const roots: string[] = [];
const policy = (server?: { args: string[] }) => server?.args[server.args.indexOf("-p") + 1] ?? "";
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
  // The server starts in its own browser directory, not the agent's unreadable checkout.
  expect(server?.command).toBe("/usr/bin/env");
  expect(server?.args.slice(0, 4)).toEqual(["-C", server?.env.HOME ?? "", SANDBOX_EXEC, "-p"]);
  expect(server?.args[5]).toBe(realpathSync(Bun.which("node") ?? ""));
  expect(server?.args).toContain("--no-sandbox");
  expect(server?.args).not.toContain("--sandbox");
  expect(server?.args.slice(6, 8)).toEqual([
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
  writeFileSync(library, machO());
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
  expect(policy(server)).toContain(`(subpath "${library}")`);
  expect(policy(server)).not.toContain(`(subpath "${root}")`);
  rmSync(library);
  expect(browserMcp(spec, "codex", [], "darwin")).toBeUndefined();
});

// Writes a recorded runtime whose first library reaches the second through a symlink at `alias`.
function linkedRuntime(cache: string, runtime: string, alias: string) {
  mkdirSync(runtime);
  const [first, second] = [join(runtime, "liba.dylib"), join(runtime, "libb.dylib")];
  writeFileSync(first, machO([join(alias, "libb.dylib")]));
  writeFileSync(second, machO());
  symlinkSync(runtime, alias);
  const path = join(cache, "ready.json");
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), libraries: [first, second] }),
  );
}

test("dyld's symlink lookups to the runtime are readable only as metadata, and must stay recorded", async () => {
  const { root, cache, spec } = await fixture();
  const events: AgentEvent[] = [];
  spec.onEvent = (event) => events.push(event);
  linkedRuntime(cache, join(root, "runtime"), join(root, "opt-link"));
  const profile = policy(browserMcp(spec, "codex", [], "darwin"));
  expect(profile).toContain(`(allow file-read-metadata (literal "${join(root, "opt-link")}"))`);
  expect(profile).not.toContain(`(subpath "${join(root, "opt-link")}")`);
  expect(profile).toContain('(allow file-read-data (literal "/"))');
  // A Homebrew upgrade keeps the old keg and moves the link to a new, unrecorded one.
  mkdirSync(join(root, "runtime-new"));
  writeFileSync(join(root, "runtime-new/libb.dylib"), machO());
  rmSync(join(root, "opt-link"));
  symlinkSync(join(root, "runtime-new"), join(root, "opt-link"));
  expect(browserMcp(spec, "codex", [], "darwin")).toBeUndefined();
  expect(events).toEqual([
    expect.objectContaining({
      text: `Browser disabled: browser runtime changed: ${join(root, "opt-link/libb.dylib")} resolves to an unrecorded path; reprovision the browser cache`,
    }),
  ]);
});

test("a runtime library or dyld link in the agent's write roots refuses setup", async () => {
  const { root, cwd, cache, spec } = await fixture();
  const events: AgentEvent[] = [];
  spec.onEvent = (event) => events.push(event);
  const manifest = join(cache, "ready.json");
  const record = (libraries: string[]) =>
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), libraries }));
  for (const directory of [cwd, root]) {
    writeFileSync(join(directory, "runtime-library"), machO());
    record([join(directory, "runtime-library")]);
    // Only the copy outside the checkout is accepted.
    expect(!!browserMcp(spec, "codex", [], "darwin")).toBe(directory === root);
  }
  for (const [runtime, alias] of [
    [join(root, "runtime"), join(cwd, "link")],
    [join(root, "runtime-outside"), join(root, "link")],
  ] as const) {
    linkedRuntime(cache, runtime, alias);
    expect(!!browserMcp(spec, "codex", [], "darwin")).toBe(!alias.startsWith(cwd));
  }
  const agentWritable = expect.objectContaining({
    text: "Browser disabled: browser runtime is agent-writable",
  });
  expect(events).toEqual([agentWritable, agentWritable]);
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
  // With the gaps cleared, exactly the paths that apply the profile get a browser.
  expect(!!browserMcp(spec, harness, [], platform)).toBe(enabled);
  expect(events).toHaveLength(enabled ? 0 : 1);
  expect(browserMcp({ ...spec, browser: undefined }, harness, [], platform)).toBeUndefined();
  expect(events).toHaveLength(enabled ? 0 : 1);
  // A requested browser that a tool-less invocation cannot use is reported, not dropped silently.
  expect(browserMcp({ ...spec, noTools: true }, harness, [], platform)).toBeUndefined();
  expect(events.at(-1)).toMatchObject({
    code: "browser_unavailable",
    text: expect.stringContaining("tool-less"),
  });
  events.length = 0;
  // The unconfined probe cleared the production gap list: the same paths get a browser by default.
  expect(!!browserMcp(spec, harness, undefined, platform)).toBe(enabled);
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
    const profile = policy(server);
    const directory = server.env.HOME ?? "";
    expect(profile).toContain("(deny file-read*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(`(allow file-read* (subpath "${directory}") (subpath "${cache}")`);
    expect(profile).toContain(`(allow file-write* (subpath "${directory}")`);
    expect(profile).not.toContain(`(subpath "${cwd}")`);
    expect(profile).not.toContain(`(subpath "${scratch}")`);
    expect(profile).not.toContain(`(literal "${root}/package.json")`);
    for (const path of [privateFile, join(root, ".ssh"), join(root, "configured-private")]) {
      expect(profile.lastIndexOf(`(subpath "${path}")`)).toBeGreaterThan(
        profile.indexOf("(allow file-read*"),
      );
    }
    // Chromium on macOS takes its temporary directory from MAC_CHROMIUM_TMPDIR, not TMPDIR.
    for (const name of ["TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "MAC_CHROMIUM_TMPDIR"])
      expect(server.env[name]).toBe(directory);
    // Node aborts on an OpenSSL configuration the profile cannot read.
    expect(server.env.OPENSSL_CONF).toBe("/dev/null");
    const second = browserMcp(spec, "codex", [], "darwin");
    expect(second?.env.HOME).not.toBe(directory);
    expect(policy(second)).not.toContain(`(subpath "${directory}")`);
  } finally {
    release();
  }
});

// The Data-volume aliases exist only on macOS. On Linux, browserMcp stops before the profile,
// and mocking node:fs reaches only some of the modules that read these paths.
test.skipIf(process.platform !== "darwin")(
  "browser system reads exclude checkout and sibling scratch through Data-volume paths (macOS)",
  async () => {
    const { spec, cwd, scratch } = await fixture();
    const server = browserMcp(spec, "codex", [], "darwin");
    if (!server) throw new Error("missing server");
    const reads = policy(server)
      .split("\n")
      .filter((line) => line.startsWith("(allow file-read* "));
    const subpaths = reads.flatMap((line) => [...line.matchAll(/\(subpath "([^"]+)"\)/g)].map((m) => m[1]));
    const allowed = (path: string) =>
      subpaths.some((root) => root && (path === root || path.startsWith(`${root}/`)));
    expect(allowed("/System/Library/Frameworks/resource")).toBe(true);
    for (const file of [join(cwd, "private.txt"), join(scratch, "browser-sibling/private.txt")]) {
      expect(allowed(file)).toBe(false);
      expect(allowed(`/System/Volumes/Data${file}`)).toBe(false);
    }
  },
);

test("a preview allows exactly its own IPv4 loopback port", async () => {
  const { spec, scratch } = await fixture();
  if (!spec.browser) throw new Error("missing browser request");
  spec.browser.previewUrl = "http://127.0.0.1:43210/x?q=1";
  const server = browserMcp(spec, "codex", [], "darwin");
  const args = server?.args ?? [];
  expect(args.filter((arg) => arg === "--allowed-origins")).toEqual(["--allowed-origins"]);
  expect(args[args.indexOf("--allowed-origins") + 1]).toBe("http://127.0.0.1:43210");
  expect(policy(server)).toContain("(deny network-outbound)");
  // A 127.0.0.1 preview cannot reach ::1, where another process may hold the same port.
  expect(
    policy(server)
      .split("\n")
      .filter((line) => line.startsWith("(allow network-outbound")),
  ).toEqual(['(allow network-outbound (remote ip4 "localhost:43210"))']);
  // Seatbelt compiles the profile before applying it; exit 65 means it rejected a rule. The control
  // sits in the readable browser directory, and exit 0 also shows dyld starts under the profile
  // (without the root-directory read it aborts with 134).
  if (process.platform === "darwin") {
    const control = join(server?.env.HOME ?? "", "true");
    fs.copyFileSync("/usr/bin/true", control);
    const compiled = await runProcess({
      cmd: [SANDBOX_EXEC, "-p", policy(server), control],
      cwd: scratch,
      env: agentEnv(),
      timeoutMs: 10_000,
    });
    expect(compiled.stderr).not.toContain("Backtrace");
    expect(compiled.exitCode === 0 || compiled.exitCode === 71, compiled.stderr).toBe(true);
  }
  for (const flag of ["--user-data-dir", "--output-dir"])
    expect(args[args.indexOf(flag) + 1]?.startsWith(`${scratch}/browser-`)).toBe(true);
});

test.each([
  "http://127.0.0.1",
  "https://127.0.0.1:43210",
  "https://[::1]",
  "https://LOCALHOST:443/x",
  "http://[::1]:43210/x",
  "http://localhost:43210",
])("a preview other than http://127.0.0.1:<port> gets no browser: %s", async (url) => {
  const { spec } = await fixture();
  const events: AgentEvent[] = [];
  spec.onEvent = (event) => events.push(event);
  if (!spec.browser) throw new Error("missing browser request");
  spec.browser.previewUrl = url;
  expect(browserMcp(spec, "codex", [], "darwin")).toBeUndefined();
  expect(events).toEqual([
    expect.objectContaining({ text: "Browser disabled: browser previews must be http://127.0.0.1:<port>" }),
  ]);
});

test.each(["claude", "codex"] as const)(
  "%s gets no browser while a confinement gap is unresolved, even with a valid cache, preview and scratch",
  async (harness) => {
    const { spec, scratch } = await fixture();
    const events: AgentEvent[] = [];
    spec.onEvent = (event) => events.push(event);
    const gaps = ["redirects leave the preview origin", "filenames on output tools escape --output-dir"];
    expect(browserMcp(spec, harness, gaps, "darwin")).toBeUndefined();
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
  if (failure === "credential URL") spec.browser.previewUrl = "http://user:password@127.0.0.1:43210";
  if (failure === "file URL") spec.browser.previewUrl = "file:///etc/hosts";
  if (failure === "zero port") spec.browser.previewUrl = "http://127.0.0.1:0";
  if (failure === "rejected profile path") {
    const path = join(root, 'scratch-"');
    mkdirSync(path);
    spec.scratchDir = path;
  }
  if (failure === "private cache") spec.denyRead = [cache];
  if (failure === "runtime metadata missing") {
    const path = join(cache, "ready.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    delete record.libraries;
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
