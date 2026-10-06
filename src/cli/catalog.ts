import type { RuntimeCatalog } from "../router/runtime-catalog.ts";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
export async function catalogCommand(
  args: string[],
  options: {
    model?: string[];
    origin?: string;
    "base-origin"?: string;
    vendor?: string;
    tier?: string;
    efforts?: string;
    effort?: string;
    "price-input"?: string;
    "price-output"?: string;
    "price-cache-read"?: string;
    notes?: string;
  },
  api: Api,
): Promise<void> {
  const [action, id] = args;
  if (action === "list" && args.length === 1) {
    const catalog = await api<ReturnType<RuntimeCatalog["snapshot"]>>("/api/catalog");
    for (const m of catalog.models) console.log(`${m.id} [${m.source}] ${m.model} tier ${m.tier}`);
    for (const p of catalog.providers)
      console.log(`${p.provider} served: ${p.served?.join(", ") ?? "inconclusive"}`);
  } else if (action === "remove" && id && args.length === 2) {
    await api(`/api/catalog/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    console.log(`Removed ${id}`);
  } else if (action === "add" && id && args.length === 2) {
    const parts = id.split("/");
    if (parts.length !== 2 || parts.some((p) => !p)) throw new Error("expected <provider>/<id>");
    for (const flag of ["origin", "base-origin", "vendor", "tier", "price-input", "price-output"] as const)
      if (options[flag] === undefined) throw new Error(`--${flag} is required`);
    if (options.model?.length !== 1) throw new Error("--model is required exactly once");
    const model = {
      provider: parts[0],
      id: parts[1],
      model: options.model[0],
      origin: options.origin,
      base_origin: options["base-origin"],
      vendor: options.vendor,
      tier: Number(options.tier),
      efforts: options.efforts?.split(",") ?? [],
      effort: options.effort,
      price: {
        input: Number(options["price-input"]),
        output: Number(options["price-output"]),
        ...(options["price-cache-read"] === undefined
          ? {}
          : { cache_read: Number(options["price-cache-read"]) }),
      },
      notes: options.notes,
    };
    await api("/api/catalog/models", { method: "POST", body: JSON.stringify(model) });
    console.log(`Added ${id}`);
  } else
    throw new Error(
      "usage: limitless catalog list | add <provider>/<id> --model <backend> --origin <country> --base-origin <country> --vendor <vendor> --tier N --price-input N --price-output N [--efforts none,high] [--effort high] [--notes …] | remove <id>",
    );
}
