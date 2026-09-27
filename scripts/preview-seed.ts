import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";

const home = process.env.LIMITLESS_HOME;
const configDir = process.env.LIMITLESS_CONFIG_DIR;
if (!home || !configDir) throw new Error("Preview seed requires LIMITLESS_HOME and LIMITLESS_CONFIG_DIR");
mkdirSync(home, { recursive: true });
const store = new Store(join(home, "limitless.db"));
try {
  const repo = store.upsertRepo({
    slug: "local/preview",
    kind: "local",
    url: null,
    localPath: process.cwd(),
    defaultBranch: "main",
    mergePolicy: "none",
  });
  for (const [title, prompt] of [
    [
      "Long prompt",
      `Build a compact dashboard with readable run summaries. ${"Include detailed acceptance criteria and representative content. ".repeat(20)}`,
    ],
    ["Short prompt", "Fix spacing"],
    ["Whitespace prompt", " \n\t  "],
  ] as [string, string][])
    store.createRun(repo, { title, prompt, source: "ui", repo: repo.slug });
} finally {
  store.close();
}
