import { type Config, repoSettings } from "../config.ts";
import type { Repo } from "../core/types.ts";

export const sharedRepository = (cfg: Pick<Config, "repos">, repo: Pick<Repo, "kind">, slug: string) =>
  repoSettings(cfg, slug).shared === true && repo.kind === "github";
