import { globToRegex } from "../gates/audit.ts";
import { worktreeGit } from "../git/command.ts";
import type { StatedBudget } from "./budget.ts";

type Range = { base: string; head: string; mode: "two-dot" | "merge-base" };
export type SizeReport =
  | { unavailable: string }
  | (Range & { error: string })
  | (Awaited<ReturnType<typeof measureSize>> & { stated: StatedBudget });
export async function measureSize(
  cwd: string,
  base: string,
  head: string,
  mode: Range["mode"],
  docsGlobs: string[] = [],
) {
  const result = {
    base,
    head,
    mode,
    source: { added: 0, removed: 0 },
    tests: { added: 0, removed: 0 },
    docs: { added: 0, removed: 0 },
    binary: 0,
    renamesAcross: [] as { from: string; to: string }[],
  };
  const docs = docsGlobs.map(globToRegex);
  const test =
    /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.(?:test|spec)|_test)\.[^/]*$|(?:^|\/)test_[^/]*\.[^/]*$/;
  const category = (path: string) =>
    test.test(path) ? "tests" : docs.some((re) => re.test(path)) ? "docs" : "source";
  const diff = await worktreeGit(
    ["git", "diff", "--numstat", "-z", "-M", `${base}${mode === "merge-base" ? "..." : ".."}${head}`],
    { cwd },
  );
  const entries = diff.stdout.split("\0");
  for (let i = 0; i < entries.length - 1; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entries[i] ?? "");
    if (!match) throw new Error("Invalid size numstat entry");
    const [, added, removed, path] = match;
    const from = path || entries[++i],
      to = path || entries[++i];
    if (!from || !to) throw new Error("Missing size numstat path");
    if (category(from) !== category(to)) result.renamesAcross.push({ from, to });
    if (added === "-" && removed === "-") result.binary++;
    else {
      result[category(to)].added += Number(added);
      result[category(to)].removed += Number(removed);
    }
  }
  return result;
}
