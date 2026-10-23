import { basename } from "node:path";
import { worktreeGit } from "../git/command.ts";
import { globToRegex } from "./audit.ts";
import type { GateConfig } from "./detect.ts";
import { validRetryFiles } from "./junit.ts";
import type { GateRun } from "./run.ts";

export interface DocsSelection {
  mode: "full" | "targeted" | "skipped";
  changedPaths: string[];
  files: string[];
  reason: string;
}

/** Inspect committed data only; a rename contributes both its old and new paths. */
export async function docsOnlyGates(cwd: string, cfg: GateConfig, base: string, head: string) {
  const selection: DocsSelection = {
    mode: "full",
    changedPaths: [],
    files: [],
    reason: "full configured checks",
  };
  const tests = cfg.checks.filter((c) => c.run.includes("LIMITLESS_GATE_REPORT"));
  const check = tests.length === 1 ? tests[0] : undefined;
  let gates = cfg;
  if (cfg.docs?.length && cfg.retryFiles?.split("{files}").length === 2 && check) {
    const git = (args: string[]) => worktreeGit(["git", ...args], { cwd });
    selection.changedPaths = (
      await git(["diff", "--name-only", "--no-renames", "-z", base, head, "--"])
    ).stdout
      .split("\0")
      .filter(Boolean);
    const patterns = cfg.docs.map(globToRegex);
    if (
      selection.changedPaths.length &&
      selection.changedPaths.every((p) => patterns.some((r) => r.test(p)))
    ) {
      if (![check.run, cfg.retryFiles].every((command) => /^bun test(?:\s|$)/.test(command.trim()))) {
        selection.reason = `docs-only change; unrecognized test runner: ${check.run}; retry_files: ${cfg.retryFiles}`;
        return { gates, selection, annotate: (run: GateRun) => run };
      }
      const isTest = (p: string) => /[._](?:test|spec)\.(?:[jt]sx?|[cm][jt]s)$/.test(basename(p));
      const tracked = (await git(["ls-tree", "-r", "--name-only", "-z", head])).stdout
        .split("\0")
        .filter(isTest);
      selection.reason = "docs-only change; no recognized test files";
      if (tracked.length) {
        const needles = [...new Set(selection.changedPaths.flatMap((p) => [p, basename(p)]))];
        const matches = await worktreeGit(
          [
            "git",
            "grep",
            "--no-textconv",
            "-a",
            "-l",
            "-z",
            "-F",
            ...needles.flatMap((p) => ["-e", p]),
            head,
            "--",
            ...tracked.map((p) => `:(literal)${p}`),
          ],
          { cwd, allowFail: true },
        );
        if (matches.timedOut || (matches.exitCode !== 0 && matches.exitCode !== 1))
          throw new Error("Cannot inspect committed test sources for docs-only gates");
        const files = matches.stdout
          .split("\0")
          .filter(Boolean)
          .map((p) => p.slice(head.length + 1))
          .filter(isTest);
        selection.reason = "docs-only change; reference list exceeds 50 files or is invalid";
        if (!files.length || validRetryFiles(files, cwd)) {
          selection.files = files;
          selection.mode = files.length ? "targeted" : "skipped";
          selection.reason = files.length
            ? "docs-only change; test source references a changed path or basename"
            : "docs-only change; no test reads the changed files";
          gates = {
            ...cfg,
            checks: cfg.checks.flatMap((c) =>
              c !== check
                ? [c]
                : files.length
                  ? [{ ...c, run: cfg.retryFiles?.replace("{files}", () => quoteRetryFiles(files)) ?? c.run }]
                  : [],
            ),
          };
        }
      }
    }
  }
  return {
    gates,
    selection,
    annotate(run: GateRun): GateRun {
      if (selection.mode === "full" || !check || !run.setupOk) return run;
      const checks = run.checks.map((r) => (r.name === check.name ? { ...r, docsOnly: selection } : r));
      if (selection.mode === "skipped")
        checks.splice(cfg.checks.indexOf(check), 0, {
          name: check.name,
          command: check.run,
          ok: false,
          exitCode: null,
          durationMs: 0,
          output: selection.reason,
          docsOnly: selection,
        });
      return { ...run, checks };
    },
  };
}

export const quoteRetryFiles = (files: string[]): string =>
  files.map((file) => `'./${file.replaceAll("'", "'\\''")}'`).join(" ");
