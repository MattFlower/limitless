import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GateCommand {
  name: string;
  run: string;
  timeoutSec?: number;
}

export interface GateConfig {
  setup: string[];
  checks: GateCommand[];
  source: ".limitless.toml" | "detected" | "none";
  /** Globs the implementer must not touch (audit blocks edits to them). */
  protectedPaths: string[];
  /** Repo-level merge policy override. */
  merge?: "auto" | "pr" | "none";
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read `.limitless.toml` from the repo root, or infer gates from the toolchain. */
export function detectGates(cwd: string): GateConfig {
  const tomlPath = join(cwd, ".limitless.toml");
  if (existsSync(tomlPath)) {
    const raw = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>;
    const gates = (raw.gates ?? {}) as Record<string, unknown>;
    const policy = (raw.policy ?? {}) as Record<string, unknown>;
    const checks = Array.isArray(gates.checks) ? (gates.checks as GateCommand[]) : [];
    const cfg: GateConfig = {
      setup: Array.isArray(gates.setup) ? (gates.setup as string[]) : [],
      checks: checks.filter((c) => c && typeof c.name === "string" && typeof c.run === "string"),
      source: ".limitless.toml",
      protectedPaths: Array.isArray(policy.protected_paths) ? (policy.protected_paths as string[]) : [],
    };
    if (policy.merge === "auto" || policy.merge === "pr" || policy.merge === "none") cfg.merge = policy.merge;
    return cfg;
  }

  const setup: string[] = [];
  const checks: GateCommand[] = [];
  const has = (f: string) => existsSync(join(cwd, f));

  const pkg = has("package.json") ? readJson(join(cwd, "package.json")) : null;
  if (pkg) {
    let runner = "npm run";
    if (has("bun.lock") || has("bun.lockb")) {
      setup.push("bun install --frozen-lockfile");
      runner = "bun run";
    } else if (has("pnpm-lock.yaml")) {
      setup.push("pnpm install --frozen-lockfile");
      runner = "pnpm run";
    } else if (has("yarn.lock")) {
      setup.push("yarn install --frozen-lockfile");
      runner = "yarn";
    } else if (has("package-lock.json")) {
      setup.push("npm ci");
    } else {
      setup.push("npm install");
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const pick = (names: string[]) => names.find((n) => typeof scripts[n] === "string");
    const lint = pick(["lint", "check:lint"]);
    const types = pick(["typecheck", "type-check", "check:types", "tsc"]);
    const test = pick(["test", "test:unit"]);
    if (lint) checks.push({ name: "lint", run: `${runner} ${lint}` });
    if (types) checks.push({ name: "typecheck", run: `${runner} ${types}` });
    if (test && !/no test specified/.test(scripts[test] ?? ""))
      checks.push({ name: "test", run: `${runner} ${test}` });
    else if (runner === "bun run") checks.push({ name: "test", run: "bun test" });
    if (!types && scripts.build) checks.push({ name: "build", run: `${runner} build` });
  } else if (has("Cargo.toml")) {
    checks.push({ name: "check", run: "cargo check --all-targets" });
    checks.push({ name: "test", run: "cargo test" });
  } else if (has("go.mod")) {
    checks.push({ name: "vet", run: "go vet ./..." });
    checks.push({ name: "test", run: "go test ./..." });
  } else if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const pyproject = has("pyproject.toml") ? readFileSync(join(cwd, "pyproject.toml"), "utf8") : "";
    if (has("uv.lock")) setup.push("uv sync");
    const run = has("uv.lock") ? "uv run " : "";
    if (/\[tool\.ruff/.test(pyproject)) checks.push({ name: "lint", run: `${run}ruff check .` });
    if (/pytest/.test(pyproject) || has("pytest.ini") || has("tests"))
      checks.push({ name: "test", run: `${run}pytest -q` });
  } else if (has("Makefile")) {
    const mk = readFileSync(join(cwd, "Makefile"), "utf8");
    for (const target of ["lint", "test"]) {
      if (new RegExp(`^${target}:`, "m").test(mk)) checks.push({ name: target, run: `make ${target}` });
    }
  }

  return { setup, checks, source: checks.length || setup.length ? "detected" : "none", protectedPaths: [] };
}
