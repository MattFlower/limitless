import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { Stage } from "../core/types.ts";
import { githubWait } from "../git/github-wait.ts";
import type { ModelTarget } from "../harness/types.ts";
import { type InvokeOutcome, NeedsHumanError, type Replay, type RunContext } from "./context.ts";
export class NetworkWaitError extends Error {}
export interface NetworkDependencies {
  probe?: (url: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  timeoutMs?: number;
}
const stageCalls = new WeakMap<Stage, Replay>();
const noCredentials = { backend: undefined, openai: undefined, decisions: undefined };
export function agentCall(stage: Stage, wait: RunContext["state"]["networkWait"]) {
  const calls = stageCalls.get(stage) ?? [];
  stageCalls.set(stage, calls);
  const n = calls.push(null) - 1;
  const prefix = `agent:${stage.name}:${stage.round}:`;
  const prior = wait?.operation.startsWith(prefix) ? wait.replay?.[n] : undefined;
  const record = (o: InvokeOutcome, retry?: InvokeOutcome["retry"]) =>
    calls.fill({ ...o, retry, target: { ...o.target, ...noCredentials } }, n, n + 1) && o;
  const replayed = prior?.retry ? undefined : prior;
  const pending = prior?.retry ? prior : undefined;
  return { calls, n, operation: prefix + n, record, replayed, pending };
}
export type AgentCall = ReturnType<typeof agentCall>;
const transport =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ENETUNREACH|ETIMEDOUT|EPIPE)\b|could not resolve (?:host|hostname)|temporary failure in name resolution|connection (?:error|reset|refused|closed|terminated|timed out)|stream (?:disconnected|interrupted|closed before completion)|TLS handshake timeout|socket hang up|network is unreachable/i;
export const transportError = (text: string): boolean =>
  !/authenticat|unauthorized|forbidden|quota|rate.limit|structured output/i.test(text) &&
  transport.test(text);
const hosts: Record<string, string> = { claude: "https://api.anthropic.com", codex: "https://chatgpt.com" };
export const modelDestination = (t: ModelTarget) => t.backend?.baseUrl ?? hosts[t.harness];
const install = /^(bun|npm|pnpm|yarn) (install|ci)( --(frozen-lockfile|immutable|ignore-scripts))*$/;
export function setupDestination(command: string, cwd: string): string | undefined {
  const configs = [".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml"];
  const manager = install.exec(command.trim())?.[1];
  try {
    if (!manager || configs.some((f) => lstatSync(join(cwd, f), { throwIfNoEntry: false }))) return;
    const registry = `https://registry.${manager === "yarn" ? "yarnpkg.com" : "npmjs.org"}`;
    return process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? registry;
  } catch {}
}
export function networkDeadline(ctx: RunContext): void {
  const wait = ctx.state.networkWait;
  if (wait && (ctx.deps.network?.now ?? Date.now)() >= wait.since + githubWait.maxMs) {
    ctx.state.networkWait = undefined;
    ctx.checkpointer.writeState(ctx.run.id, ctx.state);
    throw new NeedsHumanError(`${wait.reason}; network outage deadline reached`);
  }
}
const head = (url: string, signal: AbortSignal) =>
  fetch(url, { signal, redirect: "manual", method: "HEAD" }).then(() => true);
type Call = { operation: string; calls?: Replay };
export function confirmNetwork(ctx: RunContext, call: Call, hint?: string | false, endpoint?: string) {
  const url = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : null;
  if (hint && url && /^https?:$/.test(url.protocol) && transportError(hint))
    return probeNetwork(ctx, call, url);
  if (ctx.state.networkWait?.operation === call.operation) ctx.state.networkWait = undefined;
}
async function probeNetwork(ctx: RunContext, call: Call, url: URL) {
  const net = ctx.deps.network ?? {};
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(5000, net.timeoutMs ?? 5000))]);
  const aborted = new Promise<false>((done) => signal.addEventListener("abort", () => done(false)));
  const probe = (net.probe ?? head)(url.origin, signal).catch(() => false);
  const reachable = await Promise.race([probe, aborted]);
  ctx.checkCancelled();
  if (!reachable) {
    const now = (net.now ?? Date.now)();
    const since = ctx.state.networkWait?.since ?? now;
    const nextAttemptAt = Math.min(now + githubWait.intervalMs, since + githubWait.maxMs);
    const reason = `Network unavailable during ${call.operation}`;
    ctx.state.networkWait = { since, nextAttemptAt, reason, operation: call.operation, replay: call.calls };
    throw new NetworkWaitError(reason);
  }
  if (ctx.state.networkWait?.operation === call.operation) ctx.state.networkWait = undefined;
}
