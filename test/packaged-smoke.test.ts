import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import overlay from "../routing/policy.json";
import {
  checkAssets,
  checkAutoload,
  checkOverlay,
  compareMigrations,
  findOverlayCell,
  formatRow,
  referencedAssets,
  writeHostileDir,
} from "../scripts/packaged-smoke.ts";
import { DEFAULT_POLICY } from "../src/router/catalog.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "packaged-smoke-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const first = { name: "first.sql", sha256: "abc" };
const second = { name: "second.sql", sha256: "def" };
const files = [first, second];
test("migration comparison accepts exact rows regardless of order", () => {
  expect(compareMigrations([2, 1], [...files].reverse(), files, [1, 2])).toEqual({ pass: true });
});
test.each([
  ["changed hash", [{ name: "first.sql", sha256: "changed" }, second], "first.sql"],
  ["missing row", [first], "second.sql"],
  ["extra row", [...files, { name: "extra.sql", sha256: "xyz" }], "extra.sql"],
  ["duplicate row", [...files, first], "first.sql"],
] as const)("migration comparison names the file with a %s", (_label, rows, culprit) => {
  const check = compareMigrations([1, 2], [...rows], files, [1, 2]);
  expect(check.pass).toBe(false);
  expect(check.reason).toContain(culprit);
});
test.each([{ versions: [1] }, { versions: [1, 2, 3] }, { versions: [1, 2, 2] }])(
  "schema migration version drift %j fails",
  ({ versions }) => {
    const check = compareMigrations([...versions], files, files, [1, 2]);
    expect(check.pass).toBe(false);
    expect(check.reason).toContain(String([...versions].some((v: number) => v === 3) ? 3 : 2));
  },
);

test("HTML references include only deduplicated root-relative src and href in order", () => {
  expect(
    referencedAssets(`<script src="/a.js"></script><link href='/a.css'>
    <script src="/a.js"></script><script src="https://example.com/y.js"></script>
    <script src="//cdn.example.com/z.js"></script><a href="#top">top</a><script src="rel.js"></script>
    <!-- <script src="/comment.js"></script> --><div data-src="/data.js"></div>`),
  ).toEqual(["/a.js", "/a.css"]);
  expect(checkAssets(["/a.js"])).toEqual({ pass: true });
  const empty = checkAssets(referencedAssets("<html><body>No assets</body></html>"));
  expect(empty.pass).toBe(false);
  expect(empty.reason).toContain("no root-relative assets");
});

test("autoload checks accept absent paths and a refused port", () => {
  expect(
    checkAutoload([{ path: join(root, "absent"), exists: false }], { port: 12345, listening: false }),
  ).toEqual({ pass: true });
});
test.each(["home", "config", "marker"])("autoload checks name an existing %s path", (name) => {
  const path = join(root, name);
  if (name === "marker") writeFileSync(path, "preloaded");
  else {
    mkdirSync(path);
    writeFileSync(join(path, "created"), "dotenv loaded");
  }
  const check = checkAutoload([{ path, exists: existsSync(path) }]);
  expect(check.pass).toBe(false);
  expect(check.reason).toContain(path);
});
test("autoload checks reject a file at a decoy path and a listening port", () => {
  const path = join(root, "home");
  writeFileSync(path, "file");
  expect(checkAutoload([{ path, exists: existsSync(path) }]).pass).toBe(false);
  const check = checkAutoload([], { port: 12345, listening: true });
  expect(check.pass).toBe(false);
  expect(check.reason).toContain("12345");
});

test("hostile directory contains effective dotenv, preload and valid JSON without creating traps", () => {
  const dir = join(root, "hostile");
  const traps = writeHostileDir(dir, {
    port: 12345,
    home: join(root, "decoy-home"),
    config: join(root, "decoy-config"),
    marker: join(root, "marker"),
  });
  const dotenv = Object.fromEntries(
    readFileSync(join(dir, ".env"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  expect(dotenv).toEqual({
    LIMITLESS_PORT: String(traps.port),
    LIMITLESS_HOME: traps.home,
    LIMITLESS_CONFIG_DIR: traps.config,
    LIMITLESS_URL: `http://127.0.0.1:${traps.port}`,
  });
  const bunfig = Bun.TOML.parse(readFileSync(join(dir, "bunfig.toml"), "utf8")) as { preload: string[] };
  expect(bunfig.preload).toHaveLength(1);
  const preload = readFileSync(join(dir, bunfig.preload[0] ?? "missing"), "utf8");
  expect(preload).toContain("Bun.write");
  expect(preload).toContain(JSON.stringify(traps.marker));
  for (const name of ["package.json", "tsconfig.json"])
    expect(JSON.parse(readFileSync(join(dir, name), "utf8"))).toEqual({});
  for (const path of [traps.home, traps.config, traps.marker]) expect(existsSync(path)).toBe(false);
});

test.each([false, true])("smoke detects dotenv loading with launchd values set: %s", async (autoload) => {
  const checkout = join(import.meta.dir, "..");
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: checkout }).stdout.toString().trim();
  const daemon = join(root, "daemon.ts");
  writeFileSync(
    daemon,
    `if (Bun.argv[2] === "serve") {
      Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.LIMITLESS_PORT),
        fetch: () => Response.json({ sha: ${JSON.stringify(sha)}, effective: {}, prefer: [] }) });
      process.on("SIGTERM", () => process.exit(0));
    } else console.log('{"kind":"source"}');`,
  );
  const config = join(root, "bunfig.toml");
  writeFileSync(config, "");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const binary = join(root, "limitless");
  // Only serve/version are synthetic. The routing probe uses the real source CLI,
  // with dotenv explicitly enabled or disabled; no binary is compiled by the test.
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = routing ]; then
  exec ${quote(process.execPath)} --config=${quote(config)} ${autoload ? '--env-file="$PWD/.env"' : "--no-env-file"} ${quote(join(checkout, "src/cli/main.ts"))} "$@"
fi
exec ${quote(process.execPath)} --config=${quote(config)} --no-env-file ${quote(daemon)} "$@"
`,
    { mode: 0o755 },
  );
  const child = Bun.spawn(
    [process.execPath, join(checkout, "scripts/packaged-smoke.ts"), "--binary", binary],
    {
      cwd: checkout,
      env: { ...process.env, TMPDIR: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [output] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(output).toContain("serve/health\tPASS");
    expect(output).toContain(`no autoload while serving\t${autoload ? "FAIL" : "PASS"}`);
    if (autoload) expect(output).toContain("dotenv isolation probe (hostile port");
    expect(readdirSync(root).filter((name) => name.startsWith("limitless-packaged-smoke-"))).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

async function diagnosticSmoke(mode: "exit" | "parsed" | "setup") {
  const checkout = join(import.meta.dir, "..");
  const home = realpathSync(root);
  const secret = `smoke-${crypto.randomUUID()}`;
  const boundary = `boundary-${crypto.randomUUID()}`;
  const preload = join(root, "register.ts");
  writeFileSync(
    preload,
    `import { registerCredential } from ${JSON.stringify(join(checkout, "src/util/proc.ts"))};
     registerCredential("SMOKE_TEST", ${JSON.stringify(secret)});
     registerCredential("SMOKE_BOUNDARY_TEST", ${JSON.stringify(boundary)});
     if (${JSON.stringify(mode)} === "setup") registerCredential("SMOKE_FILE_TEST", "0.stdout");`,
  );
  const executable = join(root, "fake.ts");
  writeFileSync(
    executable,
    `import { rmSync, writeFileSync } from "node:fs";
     import { dirname, join } from "node:path";
     const secret = ${JSON.stringify(secret)}, boundary = ${JSON.stringify(boundary)};
     const scratch = dirname(process.env.LIMITLESS_HOME);
     const detail = secret + " " + scratch + "/private-file " + ${JSON.stringify(`${home}/runner-file`)};
     const footer = " stdout: " + detail + " stderr: " + detail;
     if (${JSON.stringify(mode)} === "setup") {
       // Make the parent's stdout read fail outside the per-check reporting path.
       rmSync(join(scratch, "0.stdout"));
       process.exit(0);
     }
     if (${JSON.stringify(mode)} === "parsed" && Bun.argv[2] === "version") {
       writeFileSync(1, JSON.stringify({ kind: detail }));
       process.exit(0);
     }
     // Raw tail truncation would start in the middle of this registered credential.
     writeFileSync(1, boundary + "x".repeat(4000 - 20 - footer.length) + " stdout: " + detail);
     writeFileSync(2, " stderr: " + detail);
     process.exit(1);`,
  );
  const config = join(root, "bunfig.toml");
  writeFileSync(config, "");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const binary = join(root, mode === "setup" ? "git" : "limitless");
  writeFileSync(
    binary,
    `#!/bin/sh\nexec ${quote(process.execPath)} --config=${quote(config)} --no-env-file ${quote(executable)} "$@"\n`,
    { mode: 0o755 },
  );
  const child = Bun.spawn(
    [process.execPath, "--preload", preload, join(checkout, "scripts/packaged-smoke.ts"), "--binary", binary],
    {
      cwd: checkout,
      // The smoke root is beneath the runner's HOME, exercising overlapping prefixes.
      env: { ...process.env, HOME: home, TMPDIR: home, PATH: `${root}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(readdirSync(root).filter((name) => name.startsWith("limitless-packaged-smoke-"))).toEqual([]);
    const output = stdout + stderr;
    expect(output).not.toContain(home);
    expect(output).not.toContain("limitless-packaged-smoke-");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(boundary.slice(-20));
    expect(output).toContain("[redacted]");
    if (mode === "setup") {
      expect(output).not.toContain("0.stdout");
      expect(output).toContain("<tmp>/[redacted]");
    } else {
      expect(output).toContain("<tmp>/private-file");
      expect(output).toContain("<home>/runner-file");
    }
    return { stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

test.each(["exit", "parsed"] as const)(
  "smoke sanitizes version and serve failure diagnostics before truncating: %s",
  async (mode) => {
    const { stdout, stderr } = await diagnosticSmoke(mode);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(9);
    for (const name of ["version", "slotted commands", "serve/health"]) {
      const row = stdout.split("\n").find((line) => line.startsWith(`${name}\tFAIL\t`));
      expect(row).toContain("[redacted]");
      expect(row).toContain("<tmp>/private-file");
      expect(row).toContain("<home>/runner-file");
      if (mode === "exit" || name !== "version") {
        expect(row).toContain("stdout:");
        expect(row).toContain("stderr:");
      }
    }
  },
);

test("smoke sanitizes setup errors and removes its temporary directory", async () => {
  const { stdout, stderr } = await diagnosticSmoke("setup");
  expect(stdout).toBe("");
  expect(stderr).toContain("ENOENT");
  expect(stderr).toContain("open");
});

test("routing finder selects differing groups including cells missing from defaults", () => {
  expect(findOverlayCell({ spec: { large: ["new"] } }, { spec: { default: ["old"] } })).toEqual({
    role: "spec",
    cell: "large",
    groups: ["new"],
  });
  const entry = findOverlayCell(overlay, DEFAULT_POLICY);
  expect(entry).toBeDefined();
  if (!entry) throw new Error("No differing routing cell");
  const defaults: Record<string, Partial<Record<string, string[]>>> = DEFAULT_POLICY;
  expect(isDeepStrictEqual(entry.groups, defaults[entry.role]?.[entry.cell])).toBe(false);
  expect(
    checkOverlay(
      { spec: { default: ["new"] } },
      { spec: { default: ["old"] } },
      { spec: { default: { groups: ["new"] } } },
    ).pass,
  ).toBe(true);
  const mismatch = checkOverlay(
    { spec: { default: ["new"] } },
    {},
    { spec: { default: { groups: ["old"] } } },
  );
  expect(mismatch.pass).toBe(false);
  expect(mismatch.reason).toContain("spec.default");
});
test.each([{}, DEFAULT_POLICY])(
  "routing with no differing cell fails rather than passing vacuously",
  (policy) => {
    expect(findOverlayCell(policy, DEFAULT_POLICY)).toBeUndefined();
    const check = checkOverlay(policy, DEFAULT_POLICY, {});
    expect(check.pass).toBe(false);
    expect(check.reason).toContain("no overlay cell differs");
  },
);
test("formatter prints one row with the verdict and failure reason", () => {
  expect(formatRow("version", { pass: true })).toBe("version\tPASS");
  expect(formatRow("UI", { pass: false, reason: "/a.js\nHTTP 404" })).toBe("UI\tFAIL\t/a.js HTTP 404");
});

type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      "runs-on": string;
      "timeout-minutes": number;
      needs?: unknown;
      steps: { uses?: string; run?: string; with?: { "bun-version": string } }[];
    }
  >;
};
test("packaged workflows pin toolchains, run Linux in parallel and reserve macOS for dispatch", () => {
  const read = (name: string) =>
    Bun.YAML.parse(readFileSync(join(import.meta.dir, "../.github/workflows", name), "utf8")) as Workflow;
  const ci = read("ci.yml"),
    manual = read("packaged-smoke.yml");
  expect(Object.keys(manual.on)).toEqual(["workflow_dispatch"]);
  expect(manual.permissions).toEqual({ contents: "read" });
  const checkActions = ci.jobs.check?.steps.flatMap((step) => (step.uses ? [step.uses] : [])) ?? [];
  for (const action of checkActions) expect(action).toMatch(/@[0-9a-f]{40}$/);
  // Only the check job uploads the JUnit report; the toolchain actions must match.
  const actions = checkActions.filter((action) => !action.startsWith("actions/upload-artifact@"));
  for (const [workflow, platform] of [
    [ci, "ubuntu-latest"],
    [manual, "macos-15"],
  ] as const) {
    const job = workflow.jobs["packaged-smoke"];
    expect(job?.["runs-on"]).toBe(platform);
    expect(job?.["timeout-minutes"]).toBe(15);
    expect(job?.needs).toBeUndefined();
    const uses = job?.steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses).toEqual(actions);
    for (const action of uses ?? []) expect(action).toMatch(/@[0-9a-f]{40}$/);
    expect(job?.steps.some((step) => step.with?.["bun-version"] === "1.4.3")).toBe(true);
    const commands = job?.steps.map((step) => step.run);
    expect(commands).toContain("bun install --frozen-lockfile");
    expect(commands).toContain("bun scripts/packaged-smoke.ts");
  }
});
