import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { sh } from "../util/proc.ts";
import {
  bounded,
  DEFAULT_MAX_WAIT_MS,
  type DeployClient,
  type DeployClock,
  DrainUnsupportedError,
  deployClock,
  localDeployClient,
  requestAdmin,
  validateHealth,
  waitForDrain,
  waitForHealthy,
} from "./deploy-wait.ts";
import { type LeaseClient, type LeaseOptions, localLeaseClient, withGateLease } from "./gate-slot.ts";

const LABEL = "dev.limitless.daemon";
const TUNNEL_LABEL = "dev.limitless.tunnel";
const MTPLX_LABEL = "dev.limitless.mtplx";
const MTPLX_MODEL = process.env.LIMITLESS_MTPLX_MODEL ?? "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality";
const REPO_URL = "git@github.com:MattFlower/limitless.git";

const home = homedir();
const appDir = process.env.LIMITLESS_APP_DIR ?? join(home, ".limitless", "app");
const logDir = join(home, ".limitless", "logs");
const agentsDir = join(home, "Library", "LaunchAgents");
const uid = userInfo().uid;
const deployLock = join(home, ".limitless", "deploy.lock");

function acquireDeployLock(path: string): () => void {
  mkdirSync(join(path, ".."), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => unlinkSync(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`deploy lock has no valid pid: ${path}`);
      }
      try {
        process.kill(pid, 0);
        throw new Error(`deploy already running (pid ${pid})`);
      } catch (probe) {
        if (!(probe instanceof Error) || !("code" in probe) || probe.code !== "ESRCH") throw probe;
      }
      unlinkSync(path);
    }
  }
}
// Same precedence as the operator's shell: Homebrew before ~/.bun/bin, which may hold stale
// globally-installed npm copies of the agent CLIs.
const PATH = [
  join(home, ".local", "bin"),
  "/opt/homebrew/bin",
  join(home, ".bun", "bin"),
  join(home, ".mtplx", "bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

function plist(
  label: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  workingDirectory = appDir,
): string {
  const env = { PATH, NODE_ENV: "production", ...extraEnv };
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>LimitlessService</key><string>${label.split(".").at(-1)}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `\n    <string>${xml(a)}</string>`).join("")}
  </array>
  <key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env)
    .map(([k, v]) => `\n    <key>${k}</key><string>${xml(v)}</string>`)
    .join("")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, `${label}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, `${label}.log`))}</string>
</dict>
</plist>
`;
}

export function mtplxPlist(): string {
  return plist(MTPLX_LABEL, [
    join(home, ".mtplx", "bin", "mtplx"),
    "serve",
    "--model",
    MTPLX_MODEL,
    "--host",
    "127.0.0.1",
    "--port",
    "8000",
    "--api-key",
    "mtplx-local",
    "--batching-preset",
    "agent",
    "--yes",
  ]);
}

async function launchctl(args: string[], allowFail = true) {
  return sh(["launchctl", ...args], { cwd: home, allowFail });
}

async function loaded(label: string): Promise<boolean> {
  return (await launchctl(["print", `gui/${uid}/${label}`])).exitCode === 0;
}

function samePath(a: unknown, b: string): boolean {
  try {
    return typeof a === "string" && realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
type Migration = Record<"label" | "path" | "target" | "phase" | "backup", string> & {
  old: { label: string; path: string };
};
type ServiceOptions = NonNullable<Parameters<typeof deploy>[3]>;
export async function installedUnits(opts: ServiceOptions = {}) {
  const dir = opts.agentsDir ?? agentsDir;
  const release = opts.releaseDir ?? appDir;
  const entry = join(release, "src", "cli", "main.ts");
  const units = [] as { label: string; path: string; kind: string }[];
  const run = opts.command ?? sh;
  const options = { cwd: home, allowFail: true };
  const config = join(home, ".cloudflared", "limitless.yml");
  for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".plist")) : []) {
    const path = join(dir, file);
    const result = await run(["plutil", "-convert", "json", "-o", "-", path], options);
    if (result.exitCode !== 0) continue;
    const data: Record<string, unknown> = JSON.parse(result.stdout);
    if (!data || !Array.isArray(data.ProgramArguments) || typeof data.Label !== "string") continue;
    const args = data.ProgramArguments;
    const executable = basename(String(args[0]));
    const is = (at: number, ...parts: string[]) =>
      parts.every((part, i) => (part.startsWith("/") ? samePath(args[at + i], part) : args[at + i] === part));
    let kind = "";
    if (executable === "bun" && is(1, entry, "serve")) kind = "daemon";
    else if (samePath(data.WorkingDirectory, release)) {
      if (is(0, join(home, ".mtplx", "bin", "mtplx"), "serve")) kind = "mtplx";
      if (executable === "cloudflared" && is(1, "tunnel", "--config", config, "run")) kind = "tunnel";
    }
    if (kind && (data.LimitlessService === undefined || data.LimitlessService === kind)) {
      if (units.some((unit) => unit.kind === kind)) throw new Error(`multiple installed ${kind} agents`);
      units.push({ label: data.Label, path, kind });
    }
  }
  return units;
}
/** The cloudflared config: only `/webhooks/` on the configured public host reaches the daemon. */
export function tunnelYaml(
  tunnelId: string,
  credentialsFile: string,
  hostname: string,
  port: number,
): string {
  return `# Managed by \`limitless service install\`. Only webhooks are exposed publicly.
tunnel: ${tunnelId}
credentials-file: ${credentialsFile}
ingress:
  - hostname: ${hostname}
    path: ^/webhooks/
    service: http://127.0.0.1:${port}
  - service: http_status:404
`;
}

function tunnelConfig(port: number, publicUrl: string | null): string | null {
  const dir = join(home, ".cloudflared");
  if (!existsSync(dir)) return null;
  const creds = readdirSync(dir).find((f) => /^[0-9a-f-]{36}\.json$/.test(f));
  if (!creds) return null;
  const hostname = publicUrl ? URL.parse(publicUrl)?.hostname : undefined;
  if (!hostname) {
    console.warn('set [server] public_url (e.g. "https://limitless.example.com") to name the tunnel host');
    return null;
  }
  const path = join(dir, "limitless.yml");
  writeFileSync(path, tunnelYaml(creds.replace(".json", ""), join(dir, creds), hostname, port));
  return path;
}

async function ensureRelease(dir = appDir, command: typeof sh = sh): Promise<void> {
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(join(dir, ".."), { recursive: true });
    await command(["git", "clone", REPO_URL, dir], { cwd: home, timeoutMs: 300_000 });
  }
}

async function health(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(1000);
  }
  return false;
}

export function installationUnits(
  opts: { mtplx?: boolean } = {},
  tunnel: string | null = null,
): [string, string][] {
  const units: [string, string][] = [
    [LABEL, plist(LABEL, [join(home, ".bun", "bin", "bun"), join(appDir, "src", "cli", "main.ts"), "serve"])],
  ];
  if (opts.mtplx === true) {
    units.push([MTPLX_LABEL, mtplxPlist()]);
  }
  if (tunnel) {
    units.push([
      TUNNEL_LABEL,
      plist(TUNNEL_LABEL, ["/opt/homebrew/bin/cloudflared", "tunnel", "--config", tunnel, "run"]),
    ]);
  }
  return units;
}

export async function install(
  port: number,
  opts: { tunnel?: boolean; mtplx?: boolean; publicUrl?: string | null } & ServiceOptions = {},
  control?: { run: typeof sh; race: <T>(work: Promise<T>) => Promise<T>; recover?: boolean },
): Promise<void> {
  // Reuse deploy's lock and signal scope for installation and journal recovery.
  if (!control)
    return deploy(port, undefined, false, {
      ...opts,
      lifecycle: (run, race) => install(port, opts, { run, race }),
    });
  const { run: command, race } = control;
  let restoring = false;
  const raw = opts.command ?? sh,
    clock = opts.clock ?? deployClock;
  const client = opts.client ?? localDeployClient(port);
  const ctl = async (args: string[]) =>
    (restoring ? raw : command)(["launchctl", ...args], { cwd: home, allowFail: true });
  const isLoaded = async (label: string) => (await ctl(["print", `gui/${uid}/${label}`])).exitCode === 0;
  const stop = async (label: string) => {
    if (!(await isLoaded(label))) return;
    const result = await ctl(["bootout", `gui/${uid}/${label}`]);
    if (result.exitCode !== 0) throw new Error(`bootout ${label}: ${result.stderr}`);
    for (let i = 0; i < 30 && (await isLoaded(label)); i++) await clock.sleep(500);
    if (await isLoaded(label)) throw new Error(`agent still loaded: ${label}`);
  };
  const start = async (path: string) => {
    const result = await ctl(["bootstrap", `gui/${uid}`, path]);
    if (result.exitCode !== 0) throw new Error(`launchctl bootstrap failed for ${path}: ${result.stderr}`);
  };
  const directory = join(opts.lockPath ?? deployLock, "..", "service-backup");
  const journal = (state: Migration) => join(directory, `${state.label}.json`);
  const save = (state: Migration) => {
    writeFileSync(`${journal(state)}.tmp`, JSON.stringify(state), { mode: 0o600, flush: true });
    renameSync(`${journal(state)}.tmp`, journal(state));
  };
  const clear = (state: Migration) => {
    if (existsSync(journal(state))) unlinkSync(journal(state));
  };
  const restore = async (state: Migration) => {
    restoring = true;
    const errors: string[] = [];
    await (async () => save({ ...state, phase: "rollback" }))().catch((e) => errors.push(String(e)));
    for (const l of [state.label, state.old.label]) await stop(l).catch((e) => errors.push(String(e)));
    await (async () => {
      if (existsSync(state.path)) unlinkSync(state.path);
      writeFileSync(state.old.path, Buffer.from(state.backup, "base64"));
      if (state.old.label === state.label || !(await isLoaded(state.old.label))) await start(state.old.path);
    })().catch((error) => errors.push(String(error)));
    if (errors.length) throw new Error(errors.join("; "));
    save({ ...state, phase: "restored" });
  };
  if (control.recover) {
    const recovered: string[] = [];
    const failures: string[] = [];
    for (const file of existsSync(directory)
      ? readdirSync(directory).filter((f) => f.endsWith(".json"))
      : []) {
      const state: Migration = JSON.parse(readFileSync(join(directory, file), "utf8"));
      // Rollback data outlives a running old agent: only a healthy replacement retires it.
      if (["prepared", "restored"].includes(state.phase) && (await isLoaded(state.old.label))) continue;
      try {
        if (state.phase !== "replacing" || !(await isLoaded(state.label)))
          throw new Error("pending migration");
        if (state.label === LABEL) await race(waitForHealthy(client, clock, state.target));
      } catch (error) {
        await restore(state)
          .then(() => recovered.push(`${state.old.label}: ${String(error)}`))
          .catch((e) => failures.push(`Restoration failed for ${state.old.label}: ${e}`));
        continue;
      }
      clear(state);
    }
    if (recovered.length)
      failures.push(`Recovered previous agent ${recovered.join("; ")}; retry installation.`);
    if (failures.length) throw new Error(failures.join("\n"));
    return;
  }
  mkdirSync(logDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  await ensureRelease(appDir, command);
  await command(["bun", "install", "--frozen-lockfile"], { cwd: appDir, timeoutMs: 300_000 });
  const previous = await installedUnits({ command });
  const target = (await command(["git", "rev-parse", "HEAD"], { cwd: appDir })).stdout.trim();
  // The public tunnel is opt-in: only once webhook authentication is in place.
  const tunnel = opts.tunnel ? tunnelConfig(port, opts.publicUrl ?? null) : null;
  if (opts.tunnel && !tunnel) console.warn("skipping tunnel: no cloudflared credentials or no public_url");
  const units = installationUnits(opts, tunnel);
  for (const [label, content] of units) {
    const path = join(agentsDir, `${label}.plist`);
    const old = previous.find((unit) => `dev.limitless.${unit.kind}` === label);
    if (existsSync(path) && !samePath(old?.path, path)) throw new Error(`unrelated agent: ${path}`);
    if (old?.label !== label && (await isLoaded(label))) throw new Error(`unrecognized agent: ${label}`);
    const state = old
      ? { old, label, path, target, phase: "prepared", backup: readFileSync(old.path).toString("base64") }
      : null;
    if (state) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      save(state);
    }
    let drainAttempted = false;
    try {
      if (old && label === LABEL && (await isLoaded(old.label))) {
        drainAttempted = true;
        await race(requestAdmin(client, clock, "drain"));
        await race(waitForDrain(client, clock, DEFAULT_MAX_WAIT_MS, false, console.log));
      }
      if (state) save(Object.assign(state, { phase: "stopping" }));
      if (old) await race(stop(old.label));
    } catch (error) {
      restoring = true;
      try {
        if (state && !(await isLoaded(state.old.label))) await restore(state);
        if (drainAttempted && old && (await isLoaded(old.label))) await requestAdmin(client, clock, "resume");
      } catch (resume) {
        throw new Error(`${String(error)}\nResume scheduler failed: ${String(resume)}`, { cause: error });
      }
      throw error;
    }
    try {
      if (state) save({ ...state, phase: "replacing" });
      if (old) unlinkSync(old.path);
      writeFileSync(path, content);
      await race(start(path));
      if (label === LABEL) await race(waitForHealthy(client, clock, target));
      if (state) clear(state);
    } catch (error) {
      try {
        restoring = true;
        if (state) await restore(state);
        else {
          await stop(label);
          if (existsSync(path)) unlinkSync(path);
        }
      } catch (restore) {
        throw new Error(`${String(error)}\nRestoration failed: ${String(restore)}`, { cause: error });
      }
      throw error;
    }
    console.log(`installed ${label}`);
  }
}

export async function uninstall(): Promise<void> {
  for (const { label, path } of await installedUnits()) {
    if (await loaded(label)) await launchctl(["bootout", `gui/${uid}/${label}`], false);
    unlinkSync(path);
    console.log(`removed ${label}`);
  }
}

/**
 * The factory's gate commands, run directly instead of through `bun run check`: `bun run` puts every
 * parent directory's node_modules/.bin first on PATH, so a stray CLI under $HOME (an older `codex`,
 * say) would be checked and smoke-tested instead of the one the daemon runs.
 */
const GATES = [
  ["bun", "run", "lint"],
  ["bun", "run", "typecheck"],
  ["bun", "test"],
];
const SMOKE = ["bun", "scripts/smoke.ts"];

const GATE_TAIL_LINES = 60;
const GATE_TAIL_BYTES = 4_000;
const GATE_LINE_CHARS = 500;
const GATE_FAIL_ROWS = 10;
const SMOKE_FAIL_ROW = /\S\s{2,}FAIL\s{2,}/;

const bytes = (lines: string[]) => lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);

/** The last lines that fit both limits; one long line is cut rather than dropping everything. */
function tailLines(lines: string[], maxLines: number, maxBytes: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const raw = lines[i] ?? "";
    const line = raw.length > GATE_LINE_CHARS ? `…${raw.slice(-GATE_LINE_CHARS)}` : raw;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > maxBytes) break;
    kept.unshift(line);
  }
  return kept;
}

async function gates(run: typeof sh, dir: string, smoke: boolean, lease: LeaseOptions): Promise<void> {
  const gate = async (args: string[], timeoutMs: number) => {
    const res = await run(args, { cwd: dir, timeoutMs, allowFail: true });
    if (res.exitCode === 0) return;
    // The failing check (a smoke row, a test name) is usually near the end of the output.
    const out = res.stdout.trimEnd().split("\n").filter(Boolean);
    const err = res.stderr.trimEnd().split("\n").filter(Boolean);
    // A smoke FAIL row names the failed check, so room is reserved for it; stderr comes next so a
    // `bun test` failure summary is not pushed out by stdout lines, and stdout gets what is left.
    const failRows = tailLines(
      out.filter((line) => SMOKE_FAIL_ROW.test(line)),
      GATE_FAIL_ROWS,
      GATE_TAIL_BYTES / 4,
    );
    const errTail = tailLines(err, GATE_TAIL_LINES - failRows.length, GATE_TAIL_BYTES - bytes(failRows));
    const outTail = (reserved: string[]) =>
      tailLines(
        out,
        GATE_TAIL_LINES - errTail.length - reserved.length,
        GATE_TAIL_BYTES - bytes(errTail) - bytes(reserved),
      );
    let outKept = outTail([]);
    const missed = failRows.filter((line) => !outKept.includes(line));
    if (missed.length) outKept = outTail(missed);
    const section = (name: string, lines: string[], kept: string[]) =>
      kept.length ? [`--- ${name} (last ${kept.length} of ${lines.length} lines) ---`, ...kept] : [];
    const tail = [
      ...(missed.length ? ["--- failed smoke rows from stdout ---", ...missed] : []),
      ...section("stdout", out, outKept),
      ...section("stderr", err, errTail),
    ];
    throw new Error(
      [`Command failed (${res.exitCode ?? "killed or timed out"}): ${args.join(" ")}`, ...tail].join("\n"),
    );
  };
  // The full suite takes 8–11 minutes alone and longer while runs use the machine.
  await withGateLease(
    "deploy",
    async () => {
      for (const args of GATES) await gate(args, args.includes("test") ? 1_200_000 : 600_000);
    },
    lease,
  );
  if (smoke) await gate(SMOKE, 900_000);
}

/**
 * Deploy a ref to the release checkout: gate on the checks, restart, health-check, and roll
 * back to the previous commit if the new version does not come up.
 */
export async function deploy(
  port: number,
  ref = "origin/main",
  smoke = false,
  opts: {
    leaseClient?: LeaseClient;
    lifecycle?: (run: typeof sh, race: <T>(work: Promise<T>) => Promise<T>) => Promise<void>;
    agentsDir?: string;
    releaseDir?: string;
    command?: typeof sh;
    client?: DeployClient;
    clock?: DeployClock;
    restart?: () => Promise<unknown>;
    log?: (message: string) => void;
    maxWaitMs?: number;
    now?: boolean;
    lockPath?: string;
    exit?: (code: number) => void;
  } = {},
): Promise<void> {
  const dir = opts.releaseDir ?? appDir;
  const command = opts.command ?? sh;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) throw new Error("invalid deployment wait budget");
  const client = opts.client ?? localDeployClient(port);
  const clock = opts.clock ?? deployClock;
  const restart =
    opts.restart ??
    (async () => {
      const agent = (await installedUnits(opts)).find((unit) => unit.kind === "daemon");
      if (!agent) throw new Error("no installed daemon agent; run limitless service install");
      return command(["launchctl", "kickstart", "-k", `gui/${uid}/${agent.label}`], { cwd: home });
    });
  const log = opts.log ?? console.log;
  const unlock = acquireDeployLock(opts.lockPath ?? deployLock);
  let interrupted: Error | null = null;
  const commandAbort = new AbortController();
  const lease = { client: opts.leaseClient ?? localLeaseClient(port), signal: commandAbort.signal };
  let rejectSignal = (_error: Error) => {};
  const signal = new Promise<never>((_, reject) => {
    rejectSignal = reject;
  });
  void signal.catch(() => {});
  const onSignal = (name: string) => {
    if (interrupted) {
      (opts.exit ?? process.exit)(name === "SIGINT" ? 130 : 143);
      return;
    }
    interrupted = new Error(`deploy interrupted by ${name}`);
    log("interrupted, rolling back...");
    commandAbort.abort();
    rejectSignal(interrupted);
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, signal]);
  const run: typeof sh = async (args, options) => {
    if (interrupted) throw interrupted;
    const result = await command(args, { ...options, signal: commandAbort.signal });
    if (interrupted) throw interrupted;
    return result;
  };
  let previous = "";
  let drainAttempted = false;
  let restartAttempted = false;
  let gatesPassed = false;
  try {
    await install(port, opts, { run, race, recover: true });
    if (opts.lifecycle) return await opts.lifecycle(run, race);
    await ensureRelease(dir, run);
    const running = validateHealth(await race(bounded(clock, (signal) => client.health(signal))));
    drainAttempted = running.draining;
    log(`daemon before: ${running.sha}`);
    previous = running.sha === "unknown" ? "" : running.sha;
    const checkout = (await run(["git", "rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    await run(["git", "fetch", "origin", "--prune"], { cwd: dir, timeoutMs: 300_000 });
    const target = (await run(["git", "rev-parse", `${ref}^{commit}`], { cwd: dir })).stdout.trim();
    if (running.sha === "unknown" && checkout === target) {
      const label = (await installedUnits(opts)).find((unit) => unit.kind === "daemon")?.label ?? LABEL;
      throw new Error(
        `daemon boot SHA is unknown and checkout already matches target; recover with launchctl kickstart -k gui/${uid}/${label} or limitless service install`,
      );
    }
    // Legacy upgrades can use the checkout for rollback, but never as proof of completion.
    previous ||= checkout;
    if (target === previous) {
      if (checkout !== target) {
        await run(["git", "checkout", "-q", "--detach", target], { cwd: dir });
        await run(["bun", "install", "--frozen-lockfile"], { cwd: dir, timeoutMs: 300_000 });
      }
      if (running.draining) {
        log(`daemon ${previous} is draining; resuming scheduler`);
        await race(requestAdmin(client, clock, "resume"));
        drainAttempted = false;
      }
      if (smoke) await gates(run, dir, smoke, lease);
      log(`daemon after: ${running.sha}`);
      log(`already deployed ${target}`);
      return;
    }
    if (checkout !== target) await run(["git", "checkout", "-q", "--detach", target], { cwd: dir });
    else log(`checkout already at ${target}; continuing deployment`);
    await run(["bun", "install", "--frozen-lockfile"], { cwd: dir, timeoutMs: 300_000 });
    await gates(run, dir, smoke, lease);
    gatesPassed = true;
    // A lost response may still have enabled drain on the daemon.
    drainAttempted = true;
    try {
      if (running.draining) log(`daemon ${previous} is already draining; continuing deployment`);
      else await race(requestAdmin(client, clock, "drain"));
      await race(waitForDrain(client, clock, maxWaitMs, opts.now === true, log));
    } catch (error) {
      if (!(error instanceof DrainUnsupportedError)) throw error;
      // A daemon from before graceful deploys can only be replaced by restarting it outright.
      drainAttempted = false;
      if (!opts.now)
        throw new Error(
          "the running daemon has no drain endpoint (it predates graceful deploys); re-run with --now to restart it without draining",
        );
      log("--now: the running daemon has no drain endpoint; restarting without draining");
    }
    if (interrupted) throw interrupted;
    restartAttempted = true;
    await race(restart());
    const replacement = await race(waitForHealthy(client, clock, target, log));
    log(`daemon after: ${replacement.sha}`);
    log(`deployed ${previous.slice(0, 8)} → ${target.slice(0, 8)}`);
  } catch (error) {
    if (interrupted && restartAttempted) throw interrupted;
    if (!previous) throw error;
    const cleanupErrors: string[] = [];
    const cleanup = async (name: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(`${name}: ${String(error)}`);
      }
    };
    await cleanup("restore previous release", async () => {
      await command(["git", "checkout", "-q", "--detach", previous], { cwd: dir });
      await command(["bun", "install", "--frozen-lockfile"], { cwd: dir, timeoutMs: 300_000 });
    });
    if (restartAttempted) await cleanup("restart previous release", restart);
    if (drainAttempted) await cleanup("resume scheduler", () => requestAdmin(client, clock, "resume"));
    throw new Error(
      `${gatesPassed ? "deploy failed; rollback attempted to" : "deploy gate failed; staying on"} ${previous.slice(0, 8)}\n${String(error)}` +
        (cleanupErrors.length ? `\nCleanup failures:\n${cleanupErrors.join("\n")}` : ""),
      { cause: error },
    );
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    unlock();
  }
}

export async function status(port: number): Promise<void> {
  for (const { label } of await installedUnits())
    console.log(`${label}: ${(await loaded(label)) ? "loaded" : "not loaded"}`);
  if (existsSync(join(appDir, ".git"))) {
    const head = (await sh(["git", "log", "-1", "--format=%h %s"], { cwd: appDir })).stdout.trim();
    console.log(`release: ${head}`);
  }
  console.log(`health: ${(await health(port, 2000)) ? "ok" : "unreachable"}`);
}
