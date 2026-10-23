import type { ConfigReload } from "../config-reload.ts";

export async function configCommand(
  args: string[],
  deps: { api: <T>(path: string, init?: RequestInit) => Promise<T>; print: (line: string) => void },
): Promise<void> {
  if (args.length !== 1 || args[0] !== "reload") throw new Error("Usage: limitless config reload");
  const result = await deps.api<ConfigReload>("/api/admin/config/reload", { method: "POST", body: "{}" });
  for (const key of ["applied", "restartRequired", "unchanged"] as const)
    deps.print(`${key}: ${result[key].join(", ") || "(none)"}`);
}
