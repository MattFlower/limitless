import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { version } from "../package.json";
import type { WrapperConfig } from "../src/cli/agent-test.ts";
import { migrationNames } from "../src/db/migration-runner.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { withScratch } from "../src/harness/scratch.ts";
import { withSlottedCommands } from "../src/harness/slotted.ts";
import { DEFAULT_POLICY } from "../src/router/catalog.ts";
import { redactCredentials } from "../src/util/proc.ts";

type Result = { pass: boolean; reason?: string };
type Migration = { name: string; sha256: string };
type Policy = Record<string, Partial<Record<string, string[]>>>;
const result = (pass: boolean, reason: string): Result => ({ pass, ...(pass ? {} : { reason }) });
export const formatRow = (name: string, check: Result) =>
  `${name}\t${check.pass ? "PASS" : "FAIL"}${check.reason ? `\t${check.reason.replace(/\s+/g, " ")}` : ""}`;

export function compareMigrations(
  versions: number[],
  rows: Migration[],
  files: Migration[],
  expectedVersions = MIGRATIONS.map((m) => m.version),
): Result {
  for (const v of new Set([...versions, ...expectedVersions]))
    if (versions.filter((n) => n === v).length !== (expectedVersions.includes(v) ? 1 : 0))
      return result(false, `schema_migrations version ${v} differs`);
  for (const name of new Set([...rows, ...files].map((f) => f.name))) {
    const recorded = rows.filter((f) => f.name === name);
    const expected = files.find((f) => f.name === name);
    if (!expected || recorded.length !== 1 || recorded[0]?.sha256 !== expected.sha256)
      return result(false, `applied_migrations ${name}: missing, extra or changed hash`);
  }
  return { pass: true };
}

export function referencedAssets(html: string): string[] {
  const assets = new Set<string>();
  new HTMLRewriter()
    .on("[src], [href]", {
      element(el) {
        for (const attr of ["src", "href"]) {
          const value = el.getAttribute(attr);
          if (value?.startsWith("/") && !value.startsWith("//")) assets.add(value);
        }
      },
    })
    .transform(html);
  return [...assets];
}
export const checkAssets = (assets: string[]): Result =>
  result(assets.length > 0, "UI references no root-relative assets");

export function checkAutoload(
  paths: { path: string; exists: boolean }[],
  port?: { port: number; listening: boolean },
): Result {
  if (port?.listening) return result(false, `hostile port ${port.port} is listening`);
  const found = paths.find((p) => p.exists);
  return result(!found, `hostile path exists: ${found?.path}`);
}

export function findOverlayCell(overlay: Policy, defaults: Policy) {
  for (const [role, cells] of Object.entries(overlay))
    for (const [cell, groups] of Object.entries(cells))
      if (groups && !isDeepStrictEqual(groups, defaults[role]?.[cell])) return { role, cell, groups };
}
export function checkOverlay(
  overlay: Policy,
  defaults: Policy,
  effective: Record<string, Record<string, { groups: string[] }>>,
): Result {
  const entry = findOverlayCell(overlay, defaults);
  return entry
    ? result(
        isDeepStrictEqual(effective[entry.role]?.[entry.cell]?.groups, entry.groups),
        `routing ${entry.role}.${entry.cell} differs from embedded overlay`,
      )
    : result(false, "no overlay cell differs from default");
}

export function writeHostileDir(
  dir: string,
  opts: { port: number; home: string; config: string; marker: string },
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".env"),
    `LIMITLESS_PORT=${opts.port}\nLIMITLESS_HOME=${opts.home}\nLIMITLESS_CONFIG_DIR=${opts.config}\nLIMITLESS_URL=http://127.0.0.1:${opts.port}\n`,
  );
  writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(dir, "preload.ts"), `await Bun.write(${JSON.stringify(opts.marker)}, "preload ran");\n`);
  for (const name of ["package.json", "tsconfig.json"]) writeFileSync(join(dir, name), "{}\n");
  return opts;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  const address = server.address();
  await new Promise<void>((yes, no) => server.close((error) => (error ? no(error) : yes())));
  if (!address || typeof address === "string") throw new Error("No loopback port assigned");
  return address.port;
}
async function listening(port: number): Promise<boolean> {
  return new Promise((yes, no) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      no(new Error(`TCP probe timed out: ${port}`));
    });
    socket.once("connect", () => {
      socket.destroy();
      yes(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNREFUSED" ? yes(false) : no(error),
    );
  });
}
async function waitExit(child: Bun.Subprocess, ms: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<null>((yes) => {
        timer = setTimeout(() => yes(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stop(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if ((await waitExit(child, 1000)) === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function smoke(root: string, binaryPath: string | undefined, diagnostic: (text: string) => string) {
  const checkout = resolve(import.meta.dir, "..");
  const children: Bun.Subprocess[] = [];
  let failed = false;
  const run = async (name: string, fn: () => Result | undefined | Promise<Result | undefined>) => {
    let check: Result;
    try {
      check = (await fn()) ?? { pass: true };
    } catch (error) {
      check = result(false, String(error));
    }
    failed ||= !check.pass;
    console.log(formatRow(name, { ...check, reason: check.reason && diagnostic(check.reason) }));
    return check.pass;
  };
  try {
    for (const path of ["home", "config", "tmp", "stubs"]) mkdirSync(join(root, path));
    const port = await freePort();
    let decoy = await freePort();
    while (decoy === port) decoy = await freePort();
    const hostile = join(root, "hostile");
    const traps = writeHostileDir(hostile, {
      port: decoy,
      home: join(root, "decoy-home"),
      config: join(root, "decoy-config"),
      marker: join(root, "preload-marker"),
    });
    for (const name of ["claude", "codex", "gh"])
      writeFileSync(join(root, "stubs", name), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    const env = {
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      LIMITLESS_HOME: join(root, "home"),
      LIMITLESS_CONFIG_DIR: join(root, "config"),
      LIMITLESS_PORT: String(port),
      PATH: `${join(root, "stubs")}:${process.env.PATH ?? ""}`,
      LANG: "C.UTF-8",
    };
    const launch = (cmd: string[], cwd = hostile, timeout = 30_000, childEnv: NodeJS.ProcessEnv = env) => {
      const out = join(root, `${children.length}.stdout`),
        err = join(root, `${children.length}.stderr`);
      const child = Bun.spawn(cmd, {
        cwd,
        env: childEnv,
        stdin: "ignore",
        stdout: Bun.file(out),
        stderr: Bun.file(err),
      });
      children.push(child);
      return {
        child,
        done: async () => {
          const code = await waitExit(child, timeout);
          if (code === null) await stop(child);
          return code;
        },
        stdout: () => readFileSync(out, "utf8"),
        tail: () => diagnostic(readFileSync(out, "utf8") + readFileSync(err, "utf8")).slice(-4000),
      };
    };
    const git = launch(["git", "rev-parse", "HEAD"], checkout, 30_000);
    if ((await git.done()) !== 0) throw new Error(`Cannot read build SHA: ${git.tail()}`);
    const sha = git.stdout().trim();
    const binary = binaryPath ? resolve(binaryPath) : join(root, "build", "limitless");
    let buildError: string | undefined;
    if (!binaryPath) {
      const build = launch(
        [process.execPath, "scripts/build-binary.ts", "--outdir", join(root, "build")],
        checkout,
        600_000,
        { ...process.env, ...env },
      );
      if ((await build.done()) !== 0) buildError = `build failed or timed out: ${build.tail()}`;
    }
    await run("version", async () => {
      if (buildError) throw new Error(buildError);
      const cmd = launch([binary, "version", "--json"], hostile, 30_000);
      if ((await cmd.done()) !== 0)
        throw new Error(`version exited unsuccessfully or timed out: ${cmd.tail()}`);
      const actual = JSON.parse(cmd.stdout());
      for (const [key, expected] of Object.entries({ kind: "packaged", sha, version, bun: Bun.version }))
        if (actual?.[key] !== expected)
          throw new Error(`version ${key}: expected ${expected}, got ${actual?.[key]}`);
    });
    await run("slotted commands", async () => {
      if (buildError) throw new Error(buildError);
      const requests: Record<string, unknown>[] = [];
      const unix = join(root, "lease.sock");
      const marker = join(root, "agent-test-marker");
      const optionsMarker = join(root, "options-preload-marker");
      writeFileSync(
        join(hostile, "setup.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(optionsMarker)}, "ran"); process.exit(93);\n`,
      );
      writeFileSync(
        join(hostile, "package.json"),
        JSON.stringify({ scripts: { "__agent-test": `touch '${marker.replaceAll("'", "'\\''")}'` } }),
      );
      writeFileSync(
        join(root, "stubs", "slot-probe"),
        `#!/bin/sh\n[ "\${BUN_BE_BUN+x}" != x ] || exit 91\nprintf "real:%s\\n" "$@"\nprintf "options:%s:<%s>\\n" "\${BUN_OPTIONS+x}" "\${BUN_OPTIONS-}"\nexit 37\n`,
        { mode: 0o755 },
      );
      const stub = Bun.serve({
        unix,
        async fetch(req) {
          requests.push(await req.json());
          return Response.json({ id: "smoke-lease", acquired: true });
        },
      });
      try {
        await withScratch(hostile, (scratch) =>
          withSlottedCommands(
            [["slot-probe", "leased"]],
            hostile,
            scratch,
            undefined,
            () => {},
            async (path) => {
              if (!path) throw new Error("Missing wrapper PATH");
              const configPath = join(path.split(delimiter)[0] ?? "", "config.json");
              const config: WrapperConfig = JSON.parse(readFileSync(configPath, "utf8"));
              chmodSync(configPath, 0o600);
              writeFileSync(configPath, JSON.stringify({ ...config, unix }));
              for (const [mode, options] of [
                ["leased", "--preload=./setup.cjs"],
                ["direct", "--preload=./setup.cjs"],
                ["leased", undefined],
                ["direct", undefined],
                ["leased", ""],
                ["direct", ""],
              ] as const) {
                const before = requests.length;
                const cmd = launch(["slot-probe", mode], hostile, 30_000, {
                  ...env,
                  PATH: `${path.split(delimiter)[0]}${delimiter}${env.PATH}`,
                  BUN_BE_BUN: "1",
                  ...(options === undefined ? {} : { BUN_OPTIONS: options }),
                });
                if (
                  (await cmd.done()) !== 37 ||
                  cmd.stdout() !==
                    `real:${mode}\noptions:${options === undefined ? "" : "x"}:<${options ?? ""}>\n` ||
                  existsSync(marker) ||
                  existsSync(optionsMarker)
                )
                  throw new Error(`${mode} wrapper failed: ${cmd.tail()}`);
                const observed = requests.slice(before);
                if (
                  mode === "leased"
                    ? !observed.some(
                        (r) =>
                          r.name === "slot-probe leased" && r.token === config.token && r.lane === "gate",
                      )
                    : observed.length !== 0
                )
                  throw new Error(`${mode}: unexpected lease requests`);
              }
            },
            undefined,
            {},
            { release: { kind: "packaged", version, sha, bun: Bun.version }, executable: binary },
          ),
        );
      } finally {
        stub.stop(true);
        rmSync(unix, { force: true });
      }
    });
    const get = async (path: string, timeout = 5000) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
        proxy: "",
      });
      const body = await response.text();
      if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}`);
      return { body, type: response.headers.get("content-type")?.split(";")[0] };
    };
    let serve: ReturnType<typeof launch> | undefined;
    const healthy = await run("serve/health", async () => {
      if (buildError) throw new Error(buildError);
      serve = launch([binary, "serve"]);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && serve.child.exitCode === null && serve.child.signalCode === null) {
        try {
          if (
            JSON.parse((await get("/api/health", Math.max(1, Math.min(1000, deadline - Date.now())))).body)
              .sha === sha
          )
            return;
        } catch {
          /* Startup is not ready yet. */
        }
        await Bun.sleep(100);
      }
      throw new Error(`serve exited or health deadline expired: ${serve.tail()}`);
    });
    const requireHealth = () => {
      if (!healthy) throw new Error("serve/health failed");
    };
    await run("no autoload while serving", async () => {
      requireHealth();
      // Bun preserves launchd's values during dotenv loading. URL is absent from env,
      // so loading the hostile .env redirects this client to the unused decoy port.
      const probe = launch([binary, "routing", "show"]);
      if ((await probe.done()) !== 0)
        throw new Error(`dotenv isolation probe (hostile port ${decoy}) failed: ${probe.tail()}`);
      return checkAutoload(
        [traps.home, traps.config].map((path) => ({ path, exists: existsSync(path) })),
        { port: decoy, listening: await listening(decoy) },
      );
    });
    await run("UI", async () => {
      requireHealth();
      const index = await get("/");
      if (index.type !== "text/html" || index.body !== (await get("/index.html")).body)
        throw new Error("/ is not the embedded index.html");
      const assets = referencedAssets(index.body);
      const check = checkAssets(assets);
      if (!check.pass) return check;
      for (const asset of assets) {
        const response = await get(asset);
        if (!["application/javascript", "text/javascript", "text/css"].includes(response.type ?? ""))
          throw new Error(`${asset}: unexpected content type ${response.type}`);
      }
    });
    await run("migrations", () => {
      requireHealth();
      const directory = join(checkout, "src/db/migrations");
      const files = migrationNames(directory).map((name) => ({
        name,
        sha256: createHash("sha256")
          .update(readFileSync(join(directory, name), "utf8"))
          .digest("hex"),
      }));
      const db = new Database(join(env.LIMITLESS_HOME, "limitless.db"), { readonly: true });
      try {
        return compareMigrations(
          db
            .query<{ version: number }, []>("SELECT version FROM schema_migrations")
            .all()
            .map((r) => r.version),
          db.query<Migration, []>("SELECT name, sha256 FROM applied_migrations").all(),
          files,
        );
      } finally {
        db.close();
      }
    });
    await run("routing overlay", async () => {
      requireHealth();
      return checkOverlay(
        JSON.parse(readFileSync(join(checkout, "routing/policy.json"), "utf8")),
        DEFAULT_POLICY,
        JSON.parse((await get("/api/routing")).body).effective,
      );
    });
    await run("shutdown", async () => {
      requireHealth();
      if (!serve || serve.child.exitCode !== null || serve.child.signalCode !== null)
        throw new Error("serve exited before SIGTERM");
      serve.child.kill("SIGTERM");
      const code = await waitExit(serve.child, 30_000);
      if (code !== 0 && code !== 143) {
        await stop(serve.child);
        throw new Error(`SIGTERM exit ${code}: ${serve.tail()}`);
      }
    });
    for (const child of children) await stop(child);
    await run("no preload", () => checkAutoload([{ path: traps.marker, exists: existsSync(traps.marker) }]));
  } finally {
    try {
      for (const child of children) await stop(child);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    if (failed) process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  // Capture the runner's home before children receive their isolated HOME.
  const home = homedir();
  let root = "";
  const diagnostic = (text: string) => {
    let safe = redactCredentials(text);
    // Replace the most specific prefix first, including when scratch is under HOME.
    const prefixes: [string, string][] = [
      [root, "<tmp>"],
      [home, "<home>"],
    ];
    for (const [prefix, label] of prefixes.sort((a, b) => b[0].length - a[0].length))
      if (prefix) safe = safe.replaceAll(prefix, label);
    return safe;
  };
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: { binary: { type: "string" } } });
    root = mkdtempSync(join(tmpdir(), "limitless-packaged-smoke-"));
    await smoke(root, values.binary, diagnostic);
  } catch (error) {
    console.error(diagnostic(String(error)));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
