import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, repoName } from "../config.ts";
import type { GitHubAccessProblem } from "../core/types.ts";
import { githubDoctor } from "../integrations/github-poller.ts";
import { installIntegrations, repositoryRoot } from "../integrations/install.ts";
import { resolveCatalog, tomlValue } from "../router/config-catalog.ts";
import { sh } from "../util/proc.ts";
export type Check = { id: string; status: "ok" | "warn" | "fail"; message: string; fix?: string };
type CommandResult = { exitCode: number | null; stdout: string; stderr: string };
type SmokeRow = { name: string; status: "pass" | "fail" | "skip"; reason?: string; durationMs: number };
type Health = { ok: boolean; sha: string };
type ModelList = { data?: { id: string; type?: string }[] };
export type SetupDeps = ReturnType<typeof setupDeps>;
async function get(d: SetupDeps, url: string, token?: string) {
  try {
    const headers: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
    return await d.fetch(url, { method: "GET", signal: AbortSignal.timeout(2000), headers });
  } catch {
    return null;
  }
}
function safe(d: SetupDeps, text: string): string {
  for (const value of Object.values(d.config.secrets)) if (value) text = text.replaceAll(value, "[redacted]");
  return text;
}
function encoded(d: SetupDeps, value: unknown): string {
  const redact = (_: string, v: unknown) => (typeof v === "string" ? safe(d, v) : v);
  return JSON.stringify(value, redact);
}
export async function doctor(d: SetupDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const fixes: Record<string, string> = {
    git: "upgrade git to 2.40 or newer",
    gh: "gh auth login",
    claude: "install Claude Code, then run claude and /login",
    codex: "install Codex, then run codex login",
    python3: "install python3; it is needed for the sandbox probe",
    daemon: "limitless service install",
    smoke: "run limitless init",
    "feed-access": "limitless service install",
  };
  const add = (id: string, status: Check["status"], message: string) => {
    checks.push({ id, status, message, ...(status === "ok" ? {} : { fix: fixes[id] }) });
  };
  const run = (...args: string[]) =>
    Promise.resolve()
      .then(() => d.run(args))
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  const git = await run("git", "--version"),
    version = /git version (\d+)\.(\d+)/.exec(git.stdout);
  const [major = 0, minor = 0] = (version?.slice(1) ?? []).map(Number);
  const gitOk = git.exitCode === 0 && (major > 2 || (major === 2 && minor >= 40));
  add("git", gitOk ? "ok" : "fail", "git ≥ 2.40 required");
  let ghOk = (await run("gh", "auth", "status")).exitCode === 0;
  const repo = (d.config.raw.github as { repos?: string[] } | undefined)?.repos?.[0];
  if (ghOk && repo) {
    const read = await run("gh", "api", `repos/${repo}`, "-i"),
      output = `${read.stdout}\n${read.stderr}`;
    ghOk = read.exitCode === 0 && !/HTTP\/\S+\s+[45]\d\d\b/i.test(output);
    fixes.gh =
      /\b403\b/.test(output) && /^X-GitHub-SSO:/im.test(output)
        ? "sign in to your identity provider, then `gh auth refresh`"
        : `grant repository access to ${repo}, then run gh auth refresh`;
  }
  add("gh", ghOk ? "ok" : "fail", ghOk ? "authenticated" : "not authenticated or no repo access");
  const cli = await Promise.all([run("claude", "--version"), run("codex", "--version")]);
  for (const [index, name] of ["claude", "codex"].entries()) {
    const present = cli[index]?.exitCode === 0;
    const args = name === "claude" ? ["auth", "status"] : ["login", "status"];
    const login = present ? await run(name, ...args) : null;
    const loggedIn = login?.exitCode === 0 && !/"loggedIn"\s*:\s*false/.test(login.stdout);
    const missing = !present && cli.some((c) => c.exitCode === 0) ? "warn" : "fail";
    add(name, loggedIn ? "ok" : missing, loggedIn ? "installed and logged in" : "CLI missing or logged out");
  }
  const python = (await run("python3", "--version")).exitCode === 0;
  add("python3", python ? "ok" : "warn", python ? "installed" : "sandbox probe prerequisite missing");
  const configured = d.config.raw.providers;
  const ids = Array.isArray(configured)
    ? configured.map((p) => p.id ?? p.preset)
    : Object.keys(configured ?? {});
  for (const p of resolveCatalog(configured).providers.filter((p) => ids.includes(p.id))) {
    const key = p.apiKeySecret,
      token = key ? d.config.secrets[key] : p.apiKey;
    if (key) {
      const id = `provider:${p.id}:key`;
      fixes[id] = `add ${key}=... to ${d.config.paths.configDir}/secrets.env`;
      add(id, token ? "ok" : "fail", `${key} ${token ? "present" : "missing"}`);
    }
    if (p.healthUrl) {
      const id = `provider:${p.id}:health`,
        healthy = (await get(d, p.healthUrl, token))?.ok;
      fixes[id] = `start or repair provider ${p.id}, then run limitless doctor`;
      add(id, healthy ? "ok" : "warn", healthy ? "healthy" : "health check failed");
    }
  }
  const health = await get(d, `${d.url}/api/health`);
  const body = health?.ok ? ((await health.json().catch(() => null)) as Health) : null;
  const sha = await d.run(["git", "rev-parse", "HEAD"], d.appDir).catch(() => null);
  const healthy = body?.ok === true && sha?.exitCode === 0 && !!body.sha && body.sha === sha.stdout.trim();
  if (health?.ok) fixes.daemon = "limitless deploy";
  const daemonMessage = health?.ok ? "version differs or cannot be verified" : "unreachable";
  add("daemon", healthy ? "ok" : "warn", healthy ? "healthy at installed sha" : daemonMessage);
  const rows = (await d.readJson(join(d.config.paths.home, "smoke-last.json"))) as SmokeRow[] | null;
  const smokeOk =
    Array.isArray(rows) && rows.length > 0 && rows.every((r) => r && ["pass", "skip"].includes(r.status));
  const failed = Array.isArray(rows) ? rows.filter((r) => r?.status === "fail").map((r) => r.name) : [];
  const smokeMessage = smokeOk ? "last smoke passed" : `missing or failed smoke: ${failed.join(", ")}`;
  add("smoke", smokeOk ? "ok" : "warn", smokeMessage);
  try {
    const response = health?.ok ? await get(d, `${d.url}/api/github/access`) : null;
    const problems = response?.ok ? ((await response.json()) as GitHubAccessProblem[]) : null;
    if (problems && !Array.isArray(problems)) throw new Error("invalid access feed");
    const lines = problems ? githubDoctor(problems) : [];
    const details = lines.filter((s) => !s.startsWith("  ")).join("; ");
    const actions = lines.filter((s) => s.startsWith("  "));
    const fix = actions.join("; ").replace(/\s*Fix: /g, "");
    fixes["feed-access"] = fix || "limitless service install";
    const status = problems ? (problems.length ? "fail" : "ok") : "warn";
    add("feed-access", status, details || "access feed unavailable");
  } catch {
    add("feed-access", "warn", "access feed unavailable");
  }
  return JSON.parse(encoded(d, checks)) as Check[];
}
type Flags = { yes?: boolean; json?: boolean; repo?: string[] };
export async function setupCommand(command: "doctor" | "init", flags: Flags, d: SetupDeps): Promise<number> {
  const checks = await doctor(d),
    ok = checks.every((c) => c.status !== "fail");
  const printChecks = () => {
    for (const c of checks) d.print(`${c.status} ${c.id}: ${c.message}${c.fix ? `\n  Fix: ${c.fix}` : ""}`);
  };
  if (command === "doctor" || !ok) {
    if (flags.json) d.print(JSON.stringify({ checks, ok }));
    else printChecks();
    return ok ? 0 : 1;
  }
  if (!flags.json) printChecks();
  const ask = (q: string, fallback: string) =>
    flags.yes || !d.tty ? Promise.resolve(fallback) : d.ask(q, fallback);
  const confirm = async (q: string, fallback: boolean) =>
    flags.yes || (await ask(q, fallback ? "yes" : "no")).toLowerCase() === "yes";
  const raw = structuredClone(d.config.raw);
  const entries: Record<string, unknown>[] = Array.isArray(raw.providers)
    ? (raw.providers as Record<string, unknown>[])
    : Object.entries(raw.providers ?? {}).map(([id, fields]) => ({ id, ...(fields as object) }));
  const providers = { added: [] as string[], existing: entries.map((p) => String(p.id ?? p.preset)) };
  const candidates: Record<string, unknown>[] = checks
    .filter((c) => ["claude", "codex"].includes(c.id) && c.status === "ok")
    .map((c) => ({ preset: c.id }));
  for (const port of [1234, 8000, 8080, 11434, 10240]) {
    const base = `http://127.0.0.1:${port}`,
      response = await get(d, `${base}/v1/models`);
    try {
      const body = response?.ok ? ((await response.json()) as ModelList) : null;
      if (!body?.data?.length) continue;
      const price = { input: 0, output: 0 },
        efforts = ["none"],
        origin = "unknown";
      const defaults = { vendor: "other", origin, base_origin: origin, tier: 2, price, efforts };
      const kind = body.data[0]?.type === "model" ? "anthropic-compatible" : "openai-compatible";
      candidates.push({
        id: `local-${port}`,
        kind,
        base_url: kind === "anthropic-compatible" ? base : `${base}/v1`,
        health_url: `${base}/v1/models`,
        billing: "free",
        max_concurrent: 1,
        models: body.data.map((m, i) => ({ ...defaults, id: `model-${i}`, model: m.id })),
      });
    } catch {
      /* A loopback listener need not be a model server. */
    }
  }
  for (const p of candidates) {
    const id = String(p.id ?? p.preset);
    if (entries.some((e) => e.id === id || e.preset === id || (p.base_url && e.base_url === p.base_url)))
      continue;
    if (p.preset || (await confirm(`Enable ${id}?`, true))) {
      entries.push(p);
      providers.added.push(id);
    }
  }
  const github = (raw.github ?? {}) as Record<string, unknown>,
    existing = (github.repos ?? []) as string[];
  const answer = (flags.repo ? "" : await ask("Repositories (comma separated)", "")).trim();
  const parsed = answer.split(/\s*,\s*/);
  const requested = flags.repo ?? parsed.filter(Boolean);
  if (requested.some((r) => !repoName.test(r))) throw new Error("--repo requires owner/name");
  const repos = { added: [...new Set(requested)].filter((r) => !existing.includes(r)), existing };
  const merge = github.merge ?? (await ask("Merge policy (auto/pr/none)", "pr"));
  raw.github = { ...github, repos: [...existing, ...repos.added], merge };
  raw.providers = entries;
  d.validate(raw);
  const missing = providers.added.length || repos.added.length || !("repos" in github && "merge" in github);
  if (missing) {
    const line = ([k, v]: [string, unknown]) => `${tomlValue(k)} = ${tomlValue(v)}\n`;
    const assignments = (r: Record<string, unknown>) => Object.entries(r).map(line).join("");
    const { providers: _providers, ...other } = raw;
    const text = assignments(other) + entries.map((p) => `\n[[providers]]\n${assignments(p)}`).join("");
    d.validate(Bun.TOML.parse(text) as Record<string, unknown>);
    d.write(join(d.config.paths.configDir, "config.toml"), text);
  }
  d.config.raw = raw;
  let service = "already set";
  if (checks.find((c) => c.id === "daemon")?.status !== "ok") {
    await d.install();
    service = "started";
    const sha = await d.run(["git", "rev-parse", "HEAD"], d.appDir);
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      const response = await get(d, `${d.url}/api/health`);
      const body = response?.ok ? await response.json().catch(() => null) : null;
      ready = body?.ok === true && sha.exitCode === 0 && body.sha === sha.stdout.trim();
      if (!ready) await d.sleep();
    }
    if (!ready) throw new Error("daemon did not become healthy; run limitless service install");
  }
  const smoke = await d.smoke();
  d.write(join(d.config.paths.home, "smoke-last.json"), encoded(d, smoke));
  const mcp = await d.mcp(await confirm("Register MCP with Claude Code and Codex?", false));
  const discreet = "skipped: discreet mode: not available yet (#37)";
  const summary = { checks, providers, repos, merge, service, smoke, mcp, discreet };
  if (flags.json) d.print(encoded(d, summary));
  else {
    for (const id of providers.existing.concat(repos.existing)) d.print(`${id}: already set`);
    for (const [key, value] of Object.entries(summary).filter(([k]) => k !== "checks"))
      d.print(safe(d, `${key}: ${typeof value === "string" ? value : encoded(d, value)}`));
  }
  return smoke.some((r) => r.status === "fail") ? 1 : 0;
}
type SetupPaths = Partial<{ configDir: string; home: string; appDir: string; userHome: string }>;
export function setupDeps(options: SetupPaths = {}) {
  const config = loadConfig({ ...options, readOnly: true }),
    appDir = options.appDir ?? process.env.LIMITLESS_APP_DIR ?? join(homedir(), ".limitless/app");
  const main = join(repositoryRoot, "src/cli/main.ts");
  const run = (args: string[], cwd = repositoryRoot, timeoutMs = 10000): Promise<CommandResult> =>
    sh(args, { cwd, allowFail: true, timeoutMs, env: { LIMITLESS_PORT: String(config.port) } });
  const d = {
    config,
    appDir,
    url: process.env.LIMITLESS_URL ?? `http://127.0.0.1:${config.port}`,
    tty: !!process.stdin.isTTY,
    run,
    fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
    print: (text: string) => console.log(text),
    readJson: (p: string): Promise<unknown> => Promise.resolve(Bun.file(p).json()).catch(() => null),
    write: (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    },
    validate: (raw: Record<string, unknown>) => void loadConfig({ ...options, readOnly: true, raw }),
    ask: async (q: string, fallback: string) => prompt(`${q} [${fallback}]:`)?.trim() || fallback,
    install: async (): Promise<void> => {
      const result = await d.run(["bun", main, "service", "install"], repositoryRoot, 900000);
      if (result.exitCode !== 0)
        throw new Error("service installation failed; run limitless service install");
    },
    sleep: () => Bun.sleep(1000),
    smoke: async (): Promise<SmokeRow[]> => {
      const rows: SmokeRow[] = [];
      await (await import("../../scripts/smoke.ts")).main(() => {}, { onRow: (row) => rows.push(row) });
      return rows;
    },
    mcp: async (write: boolean): Promise<string> => {
      if (!write) {
        const lines: string[] = [];
        installIntegrations({ home: options.userHome, print: (s) => lines.push(s) });
        return lines.join("\n");
      }
      for (const cli of ["claude", "codex"]) {
        if ((await d.run([cli, "mcp", "get", "limitless"])).exitCode === 0) continue;
        if ((await d.run([cli, "--version"])).exitCode !== 0) continue;
        const scope = cli === "claude" ? ["--scope", "user"] : [];
        const args = ["mcp", "add", "limitless", "--env", `LIMITLESS_URL=${d.url}`, ...scope];
        const command = ["bun", join(appDir, "src/cli/main.ts"), "mcp"];
        const result = await d.run([cli, ...args, "--", ...command]);
        if (result.exitCode !== 0) throw new Error(`MCP ${cli} failed; run limitless integrations install`);
      }
      return "MCP already set or registered";
    },
  };
  return d;
}
