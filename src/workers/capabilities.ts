import { CLAUDE_VERSION, CODEX_VERSION } from "../harness/versions.ts";
import { agentEnv, sh } from "../util/proc.ts";

export type Cli = { version: string | null; loggedIn: boolean };
export const loginArgs = { claude: ["auth", "status"], codex: ["login", "status"] };
export const loggedIn = (result: { exitCode: number | null; stdout: string } | null) =>
  result?.exitCode === 0 && !/"loggedIn"\s*:\s*false/.test(result.stdout);
export type CapabilityRunner = (
  args: string[],
  options: Parameters<typeof sh>[1],
) => Promise<{ exitCode: number | null; stdout: string }>;

async function command(
  name: keyof typeof loginArgs,
  args: string[],
  run: CapabilityRunner,
  signal?: AbortSignal,
) {
  try {
    return await run([name, ...args], {
      cwd: process.cwd(),
      env: agentEnv(),
      timeoutMs: 30_000,
      allowFail: true,
      signal,
    });
  } catch {
    return null;
  }
}
export async function checkLogin(
  name: keyof typeof loginArgs,
  run: CapabilityRunner = sh,
  signal?: AbortSignal,
) {
  return loggedIn(await command(name, loginArgs[name], run, signal));
}
export async function probeAgents(
  run: CapabilityRunner = sh,
  signal?: AbortSignal,
): Promise<Record<keyof typeof loginArgs, Cli>> {
  const probe = async (name: keyof typeof loginArgs): Promise<Cli> => {
    const result = await command(name, ["--version"], run, signal);
    const line = result?.exitCode === 0 ? (result.stdout.split("\n")[0]?.trim() ?? "") : "";
    const pattern = name === "codex" ? CODEX_VERSION : CLAUDE_VERSION;
    return {
      version: pattern.test(line) ? line : null,
      loggedIn: result?.exitCode === 0 && (await checkLogin(name, run, signal)),
    };
  };
  const [claude, codex] = await Promise.all([probe("claude"), probe("codex")]);
  return { claude, codex };
}
