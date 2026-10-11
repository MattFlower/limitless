import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { privateReadPaths } from "../util/private-reads.ts";
import { redactCredentials } from "../util/proc.ts";

export class ConfinementError extends Error {
  constructor(message?: string) {
    super(message === undefined ? undefined : redactCredentials(message));
  }
}

interface ReadPolicyOptions {
  home?: string;
  denyRead?: string[];
  toolchains?: string[];
}
export const readPolicyScope = new AsyncLocalStorage<ReadPolicyOptions>();
export const READ_PROBE = 'if [ -d "$1" ]; then ls -A "$1"; else head -c 1 "$1"; fi >/dev/null';
let configured: ReadPolicyOptions = {};

/** Called only with the factory's config.toml, never the candidate's configuration. */
export function configureReadPolicy(raw: unknown, configDir: string): void {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw)))
    throw new ConfinementError("sandbox must be a table");
  const table = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(table))
    if (!["deny_read", "toolchain_paths"].includes(key))
      throw new ConfinementError(`sandbox.${key}: unknown key`);
  const paths = (key: string): string[] => {
    const value = table[key] ?? [];
    if (
      !Array.isArray(value) ||
      !value.every((p) => typeof p === "string" && (isAbsolute(p) || p === "~" || p.startsWith("~/")))
    )
      throw new ConfinementError(`sandbox.${key} must be an array of paths`);
    return value;
  };
  configured = { denyRead: [...paths("deny_read"), configDir], toolchains: paths("toolchain_paths") };
}

/** Resolve existing ancestors too: an absent child of a symlink still aliases the target. */
export function policySpellings(paths: string[]): string[] {
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || lstatSync(path, { throwIfNoEntry: false }))
        throw new ConfinementError(`Cannot resolve read policy path ${path}`);
      return join(canonical(dirname(path)), relative(dirname(path), path));
    }
  };
  return [...new Set(paths.flatMap((p) => [resolve(p), canonical(resolve(p))]))];
}

export function resolvedHome(): string {
  let home = "<unknown>";
  try {
    home = readPolicyScope.getStore()?.home ?? homedir();
    if (!isAbsolute(home) || !lstatSync(realpathSync(home)).isDirectory()) throw new Error();
    return realpathSync(home);
  } catch {
    throw new ConfinementError(`Cannot resolve home directory for read confinement: ${home}`);
  }
}

/** One credential list for editors and gates; Claude's own login remains readable (#369). */
export function homeReadPolicy(allowed: string[], gate = false, extra: string[] = []) {
  const options = readPolicyScope.getStore() ?? configured;
  const home = resolvedHome();
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  const credentials = policySpellings([
    ...[
      ".ssh",
      ".config/limitless",
      ".config/gh",
      ".codex",
      ".aws",
      ".netrc",
      ".npmrc",
      ".docker",
      ".gnupg",
      ".kube",
    ].map((p) => join(home, p)),
    ...(options.denyRead ?? []).map(expand),
    ...extra.filter((p) => !privateReadPaths().includes(p)),
  ]);
  const denyRead = policySpellings([...credentials, ...privateReadPaths()]);
  const allowRead = policySpellings([
    ...allowed,
    ...(gate
      ? [
          process.env.BUN_INSTALL ?? join(home, ".bun"),
          process.env.CARGO_HOME ?? join(home, ".cargo"),
          process.env.RUSTUP_HOME ?? join(home, ".rustup"),
          ...(options.toolchains ?? []).map(expand),
        ]
      : []),
  ]);
  const within = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  for (const allow of allowRead)
    for (const deny of credentials)
      if (within(allow, deny) || within(deny, allow))
        throw new ConfinementError(`Read allowance ${allow} overlaps denied credential path ${deny}`);
  return {
    denyRead: gate ? [...policySpellings([options.home ?? homedir()]), ...denyRead] : denyRead,
    ...(gate ? { allowRead } : {}),
  };
}
