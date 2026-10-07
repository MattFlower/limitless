import { mock } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { Store } from "../../src/db/store.ts";

mock.module("../../src/util/proc.ts", () => ({
  sh: async (args: string[]) => {
    if (args[0] !== "gh" || args[1] !== "repo") throw new Error("unexpected command");
    return {
      stdout: JSON.stringify({ defaultBranchRef: { name: "main" }, sshUrl: `git@github.com:${args[3]}.git` }),
    };
  },
}));
const { resolveRepo } = await import("../../src/git/repos.ts");
const config = loadConfig({ configDir: Bun.argv[2], readOnly: true });
const store = new Store(":memory:");
try {
  const first = await resolveRepo(store, "acme/app", config.githubMerge);
  const existing = await resolveRepo(store, "acme/app", "none");
  const fallback = await resolveRepo(store, "acme/other");
  console.log(JSON.stringify([first.mergePolicy, existing.mergePolicy, fallback.mergePolicy]));
} finally {
  store.close();
}
