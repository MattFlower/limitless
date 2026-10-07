import type { Role } from "../core/types.ts";
import type { RoutePreview } from "../router/router.ts";
import type { RuntimePolicy } from "../router/runtime-policy.ts";

type Snapshot = ReturnType<RuntimePolicy["snapshot"]>;
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export async function routingCommand(
  args: string[],
  options: { role?: string; note?: string; all?: boolean; run?: string },
  api: Api,
): Promise<void> {
  const [action, entry, chain] = args;
  if (options.run !== undefined && action !== "show" && action !== "preview")
    throw new Error("--run applies only to routing show and preview");
  const cellPath = (key: string) => {
    const parts = key.split(".");
    if (parts.length !== 2 || parts.some((s) => !s)) throw new Error("expected <role>.<cell>");
    return `/api/routing/cells/${parts.map(encodeURIComponent).join("/")}`;
  };
  if (action === "show" && args.length === 1) {
    const routing = await api<Snapshot>(
      options.run ? `/api/routing?${new URLSearchParams({ run: options.run })}` : "/api/routing",
    );
    console.log(
      routing.runId
        ? `Routing for run ${routing.runId}: model chains override every policy cell`
        : "Global routing policy: per-run model chains take precedence",
    );
    if (options.role && !Object.hasOwn(routing.effective, options.role))
      throw new Error(`unknown role ${options.role}`);
    for (const [role, cells] of Object.entries(routing.effective)) {
      if (options.role && options.role !== role) continue;
      for (const [cell, value] of Object.entries(cells))
        console.log(`${role}.${cell} [${value.layer}] ${value.groups.join(",")}`);
    }
    console.log(
      `exclude_origins: ${routing.excludeOrigins === undefined ? "none" : JSON.stringify(routing.excludeOrigins)}`,
    );
    console.log(`prefer: ${routing.prefer.join(",")}`);
  } else if (action === "set" && args.length === 3 && entry && chain) {
    const groups = chain.split(",").map((g) =>
      g
        .split("|")
        .map((id) => id.trim())
        .join("|"),
    );
    await api(cellPath(entry), { method: "PUT", body: JSON.stringify({ groups, note: options.note }) });
    console.log(`${entry}: ${groups.join(",")}`);
  } else if (
    action === "reset" &&
    ((args.length === 2 && entry && !options.all) || (args.length === 1 && options.all))
  ) {
    if (entry) await api(cellPath(entry), { method: "DELETE" });
    else {
      const routing = await api<Snapshot>("/api/routing");
      for (const [role, cells] of Object.entries(routing.layers.operator) as [
        Role,
        Record<string, string[]>,
      ][])
        for (const cell of Object.keys(cells)) await api(cellPath(`${role}.${cell}`), { method: "DELETE" });
      if (routing.operatorPrefer !== null) await api("/api/routing/prefer", { method: "DELETE" });
    }
    console.log(`Routing reset: ${entry ?? "all operator overrides"}`);
  } else if (action === "preview" && entry && (args.length === 2 || args.length === 3)) {
    const query = new URLSearchParams({ role: entry, complexity: chain ?? "medium" });
    if (options.run) query.set("run", options.run);
    const candidates = await api<RoutePreview[]>(`/api/routing/preview?${query}`);
    for (const c of candidates)
      console.log(`${c.modelId}: ${c.eligible ? "eligible" : `skipped (${c.reason})`}`);
  } else
    throw new Error(
      "usage: limitless routing show [--role r] [--run id] | set <role>.<cell> <chain> [--note …] | reset <role>.<cell> | reset --all | preview <role> [<complexity>] [--run id]",
    );
}
