import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Scripted fake `gh` in `<dir>/bin`. Each subcommand (`create`, `create-draft`, `list`, `edit`,
 * `merge`, `view`) consumes steps from `plan`: "ok", "fail502"/"fail422" (fail without effect) or
 * "ok502" (take effect, then report 502). One PR per fake repo; calls are logged.
 */
export function fakeGh(dir: string, plan: Record<string, string[]>) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "gh-plan.json"), JSON.stringify(plan));
  const url = "https://github.com/test/repo/pull/1";
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
appendFileSync(dir + "/gh-calls", args.join(" ") + "\\n");
const key = args[1] + (args[1] === "create" && args.includes("--draft") ? "-draft" : "");
const plan = JSON.parse(readFileSync(dir + "/gh-plan.json", "utf8"));
const step = (plan[key] ?? []).shift() ?? "ok";
writeFileSync(dir + "/gh-plan.json", JSON.stringify(plan));
const fail = (code) => { console.error(code === 422 ? "HTTP 422: Validation Failed" : "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)"); process.exit(1); };
if (step === "fail502") fail(502);
if (step === "fail422") fail(422);
if (key.startsWith("create") || key === "edit") writeFileSync(dir + "/gh-body", readFileSync(0, "utf8"));
if (key === "list" && existsSync(dir + "/gh-pr")) console.log(readFileSync(dir + "/gh-pr", "utf8"));
if (key.startsWith("create")) { writeFileSync(dir + "/gh-pr", ${JSON.stringify(url)}); if (step !== "ok502") console.log(${JSON.stringify(url)}); }
if (key === "merge") writeFileSync(dir + "/gh-merged", args.includes("--auto") ? "AUTO" : "MERGED");
if (key === "view") { const m = existsSync(dir + "/gh-merged") ? readFileSync(dir + "/gh-merged", "utf8") : ""; console.log(JSON.stringify({ state: m === "MERGED" ? "MERGED" : "OPEN", autoMergeRequest: m === "AUTO" ? {} : null })); }
if (step === "ok502") fail(502);
`,
    { mode: 0o755 },
  );
  return {
    bin,
    url,
    calls: (prefix: string) => {
      let text = "";
      try {
        text = readFileSync(join(dir, "gh-calls"), "utf8");
      } catch {}
      return text.split("\n").filter((line) => line.startsWith(prefix));
    },
  };
}
