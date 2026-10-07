import { z } from "zod";
import type { ModelDef } from "./catalog.ts";

export function parseExcludeOrigins(raw: Record<string, unknown>): string[] | undefined {
  return z.object({ exclude_origins: z.array(z.string().min(1)).optional() }).parse(raw.routing ?? {})
    .exclude_origins;
}

export function originExclusion(
  model: Pick<ModelDef, "origin" | "baseOrigin">,
  excludeOrigins: readonly string[] | undefined,
): string | null {
  return excludeOrigins !== undefined &&
    (excludeOrigins.includes(model.origin) ||
      excludeOrigins.includes(model.baseOrigin) ||
      model.baseOrigin === "unknown")
    ? `origin excluded (${model.origin}; baseOrigin=${model.baseOrigin})`
    : null;
}
