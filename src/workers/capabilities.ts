import { subscriptionToken } from "../harness/auth.ts";
import { CLAUDE_VERSION, CODEX_VERSION } from "../harness/versions.ts";
import { agentEnv, redactCredentials, sh } from "../util/proc.ts";

export type Cli = { version: string | null; loggedIn: boolean };
export const loginArgs = { claude: ["auth", "status"], codex: ["login", "status"] };
export const loggedIn = (result: { exitCode: number | null; stdout: string } | null) =>
  result?.exitCode === 0 && !/"loggedIn"\s*:\s*false/.test(result.stdout);
export type CapabilityRunner = (
  args: string[],
  options: Parameters<typeof sh>[1],
) => Promise<{ exitCode: number | null; stdout: string; stderr?: string }>;

async function command(
  name: keyof typeof loginArgs,
  args: string[],
  run: CapabilityRunner,
  signal?: AbortSignal,
  secrets: Record<string, string> = {},
) {
  const token = subscriptionToken(name, secrets);
  try {
    return await run([name, ...args], {
      cwd: process.cwd(),
      env: { ...agentEnv(), ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) },
      timeoutMs: 30_000,
      allowFail: true,
      signal,
    });
  } catch (error) {
    return token ? { exitCode: null, stdout: redactCredentials(String(error)), stderr: "" } : null;
  }
}
export async function checkLogin(
  name: keyof typeof loginArgs,
  run: CapabilityRunner = sh,
  signal?: AbortSignal,
  secrets: Record<string, string> = {},
) {
  const token = subscriptionToken(name, secrets);
  const result = await command(name, loginArgs[name], run, signal, secrets);
  if (!loggedIn(result) && token)
    throw new Error(
      redactCredentials(result?.stderr?.trim() || result?.stdout.trim() || "Worker CLI not logged in").slice(
        0,
        4000,
      ),
    );
  return loggedIn(result);
}
export async function probeAgents(
  run: CapabilityRunner = sh,
  signal?: AbortSignal,
  secrets: Record<string, string> = {},
): Promise<Record<keyof typeof loginArgs, Cli>> {
  const probe = async (name: keyof typeof loginArgs): Promise<Cli> => {
    const result = await command(name, ["--version"], run, signal, secrets);
    const line =
      result?.exitCode === 0 ? (redactCredentials(result.stdout).split("\n")[0]?.trim() ?? "") : "";
    const pattern = name === "codex" ? CODEX_VERSION : CLAUDE_VERSION;
    return {
      version: pattern.test(line) ? line : null,
      loggedIn: result?.exitCode === 0 && (await checkLogin(name, run, signal, secrets).catch(() => false)),
    };
  };
  const [claude, codex] = await Promise.all([probe("claude"), probe("codex")]);
  return { claude, codex };
}
