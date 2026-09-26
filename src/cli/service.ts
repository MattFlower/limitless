import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { sh } from "../util/proc.ts";

const LABEL = "cc.mattflower.limitless";
const TUNNEL_LABEL = "cc.mattflower.limitless-tunnel";
const MTPLX_LABEL = "cc.mattflower.limitless-mtplx";
const MTPLX_MODEL = process.env.LIMITLESS_MTPLX_MODEL ?? "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality";
const ALL_LABELS = [LABEL, MTPLX_LABEL, TUNNEL_LABEL];
const REPO_URL = "git@github.com:MattFlower/limitless.git";

const home = homedir();
const appDir = process.env.LIMITLESS_APP_DIR ?? join(home, ".limitless", "app");
const logDir = join(home, ".limitless", "logs");
const agentsDir = join(home, "Library", "LaunchAgents");
const uid = userInfo().uid;
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

function plist(label: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const env = { PATH, NODE_ENV: "production", ...extraEnv };
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `\n    <string>${xml(a)}</string>`).join("")}
  </array>
  <key>WorkingDirectory</key><string>${xml(appDir)}</string>
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

async function launchctl(args: string[], allowFail = true) {
  return sh(["launchctl", ...args], { cwd: home, allowFail });
}

async function loaded(label: string): Promise<boolean> {
  return (await launchctl(["print", `gui/${uid}/${label}`])).exitCode === 0;
}

function tunnelConfig(port: number): string | null {
  const dir = join(home, ".cloudflared");
  if (!existsSync(dir)) return null;
  const creds = readdirSync(dir).find((f) => /^[0-9a-f-]{36}\.json$/.test(f));
  if (!creds) return null;
  const path = join(dir, "limitless.yml");
  writeFileSync(
    path,
    `# Managed by \`limitless service install\`. Only webhooks are exposed publicly.
tunnel: ${creds.replace(".json", "")}
credentials-file: ${join(dir, creds)}
ingress:
  - hostname: limitless.mattflower.cc
    path: ^/webhooks/
    service: http://127.0.0.1:${port}
  - service: http_status:404
`,
  );
  return path;
}

async function ensureRelease(): Promise<void> {
  if (!existsSync(join(appDir, ".git"))) {
    mkdirSync(join(appDir, ".."), { recursive: true });
    await sh(["git", "clone", REPO_URL, appDir], { cwd: home, timeoutMs: 300_000 });
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

export async function install(port: number, opts: { tunnel?: boolean; mtplx?: boolean } = {}): Promise<void> {
  mkdirSync(logDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  await ensureRelease();
  await sh(["bun", "install", "--frozen-lockfile"], { cwd: appDir, timeoutMs: 300_000 });
  const units: [string, string][] = [
    [LABEL, plist(LABEL, [join(home, ".bun", "bin", "bun"), join(appDir, "src", "cli", "main.ts"), "serve"])],
  ];
  if (opts.mtplx !== false) {
    units.push([
      MTPLX_LABEL,
      plist(MTPLX_LABEL, [
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
      ]),
    ]);
  }
  // The public tunnel is opt-in: only once webhook authentication is in place.
  const tunnel = opts.tunnel ? tunnelConfig(port) : null;
  if (opts.tunnel && !tunnel) console.warn("no cloudflared credentials found; skipping tunnel");
  if (tunnel) {
    units.push([
      TUNNEL_LABEL,
      plist(TUNNEL_LABEL, ["/opt/homebrew/bin/cloudflared", "tunnel", "--config", tunnel, "run"]),
    ]);
  }
  for (const [label, content] of units) {
    const path = join(agentsDir, `${label}.plist`);
    if (await loaded(label)) {
      await launchctl(["bootout", `gui/${uid}/${label}`]);
      // bootout returns before the old instance is gone; bootstrapping too early fails with EIO.
      for (let i = 0; i < 30 && (await loaded(label)); i++) await Bun.sleep(500);
    }
    writeFileSync(path, content);
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      if (attempt) await Bun.sleep(1000 * attempt);
      ok = (await launchctl(["bootstrap", `gui/${uid}`, path])).exitCode === 0;
    }
    if (!ok) throw new Error(`launchctl bootstrap failed for ${label}`);
    console.log(`installed ${label}`);
  }
  console.log((await health(port)) ? "daemon healthy" : "daemon did not become healthy — check the log");
}

export async function uninstall(): Promise<void> {
  for (const label of ALL_LABELS) {
    if (await loaded(label)) await launchctl(["bootout", `gui/${uid}/${label}`]);
    const path = join(agentsDir, `${label}.plist`);
    if (existsSync(path)) unlinkSync(path);
    console.log(`removed ${label}`);
  }
}

/**
 * Deploy a ref to the release checkout: gate on `bun run check`, restart, health-check, and roll
 * back to the previous commit if the new version does not come up.
 */
export async function deploy(port: number, ref = "origin/main"): Promise<void> {
  await ensureRelease();
  const previous = (await sh(["git", "rev-parse", "HEAD"], { cwd: appDir })).stdout.trim();
  await sh(["git", "fetch", "origin", "--prune"], { cwd: appDir, timeoutMs: 300_000 });
  const target = (await sh(["git", "rev-parse", ref], { cwd: appDir })).stdout.trim();
  if (target === previous) {
    console.log(`already at ${target.slice(0, 8)}`);
    return;
  }
  await sh(["git", "checkout", "-q", "--detach", target], { cwd: appDir });
  try {
    await sh(["bun", "install", "--frozen-lockfile"], { cwd: appDir, timeoutMs: 300_000 });
    await sh(["bun", "run", "check"], { cwd: appDir, timeoutMs: 600_000 });
  } catch (e) {
    await sh(["git", "checkout", "-q", "--detach", previous], { cwd: appDir });
    await sh(["bun", "install", "--frozen-lockfile"], { cwd: appDir, timeoutMs: 300_000, allowFail: true });
    throw new Error(`deploy gate failed; staying on ${previous.slice(0, 8)}\n${(e as Error).message}`);
  }
  await launchctl(["kickstart", "-k", `gui/${uid}/${LABEL}`], false);
  if (await health(port, 45_000)) {
    console.log(`deployed ${previous.slice(0, 8)} → ${target.slice(0, 8)}`);
    return;
  }
  console.error("new version is unhealthy; rolling back");
  await sh(["git", "checkout", "-q", "--detach", previous], { cwd: appDir });
  await sh(["bun", "install", "--frozen-lockfile"], { cwd: appDir, timeoutMs: 300_000, allowFail: true });
  await launchctl(["kickstart", "-k", `gui/${uid}/${LABEL}`], false);
  throw new Error(`rolled back to ${previous.slice(0, 8)}`);
}

export async function status(port: number): Promise<void> {
  for (const label of ALL_LABELS) console.log(`${label}: ${(await loaded(label)) ? "loaded" : "not loaded"}`);
  if (existsSync(join(appDir, ".git"))) {
    const head = (await sh(["git", "log", "-1", "--format=%h %s"], { cwd: appDir })).stdout.trim();
    console.log(`release: ${head}`);
  }
  console.log(`health: ${(await health(port, 2000)) ? "ok" : "unreachable"}`);
}
