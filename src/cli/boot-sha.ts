import { sh } from "../util/proc.ts";

export async function resolveBootSha(cwd: string, command: typeof sh = sh): Promise<string | undefined> {
  try {
    return (await command(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
