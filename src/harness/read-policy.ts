import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { privateReadPaths } from "../util/private-reads.ts";
import { redactCredentials } from "../util/proc.ts";

export class ConfinementError extends Error {
  constructor(message?: string) {
    super(message === undefined ? undefined : redactCredentials(message));
  }
}

export interface ReadPolicyOptions {
  readonly home?: string;
  readonly denyRead?: readonly string[];
  readonly toolchains?: readonly string[];
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}
export const readPolicyScope = new AsyncLocalStorage<ReadPolicyOptions | undefined>();
export const READ_PROBE = 'if [ -d "$1" ]; then ls -A "$1"; else head -c 1 "$1"; fi >/dev/null';

/** Called only with the factory's config.toml, never the candidate's configuration. */
export function configureReadPolicy(raw: unknown, configDir: string): ReadPolicyOptions {
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
  return Object.freeze({
    home: homedir(),
    denyRead: Object.freeze([...paths("deny_read"), configDir]),
    toolchains: Object.freeze([...paths("toolchain_paths")]),
    environment: Object.freeze(
      Object.fromEntries<string | undefined>(
        [
          "CODEX_HOME",
          "GH_CONFIG_DIR",
          "XDG_CONFIG_HOME",
          "LIMITLESS_CONFIG_DIR",
          "AWS_SHARED_CREDENTIALS_FILE",
          "AWS_CONFIG_FILE",
          "DOCKER_CONFIG",
          "GNUPGHOME",
          "KUBECONFIG",
          "NETRC",
          "NPM_CONFIG_USERCONFIG",
          "npm_config_userconfig",
          "CARGO_HOME",
          "BUN_INSTALL",
          "RUSTUP_HOME",
        ].map((key) => [key, process.env[key]]),
      ),
    ),
  });
}

export interface PolicyFilesystem {
  lstatSync(path: string, options: { throwIfNoEntry: false }): Stats | undefined;
  realpathSync(path: string): string;
}
const policyFilesystem: PolicyFilesystem = { lstatSync, realpathSync };

/** Resolve existing ancestors; retain denied or hidden optional descendants lexically for overlap checks. */
function policyPath(path: string, denied: boolean, fs: PolicyFilesystem, optional = false) {
  let current = isAbsolute(path) ? sep : fs.realpathSync(process.cwd());
  let available = true;
  try {
    // Resolve each symlink before a later '..'; realpathSync normalizes its input in Bun.
    const components = path.split(sep);
    for (const [index, component] of components.entries()) {
      if (!component || component === ".") continue;
      const next = join(current, component);
      try {
        const entry = fs.lstatSync(next, { throwIfNoEntry: false });
        if (!entry) available = false;
        try {
          current = entry ? fs.realpathSync(next) : next;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // A non-symlink name below a canonical parent needs no further resolution.
          if (entry && !entry.isSymbolicLink() && (code === "EPERM" || code === "EACCES")) current = next;
          else if (denied && entry?.isSymbolicLink())
            throw new ConfinementError(`Cannot resolve read policy path ${path}`);
          else throw error;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((denied || optional) && (code === "EPERM" || code === "EACCES"))
          return {
            spellings: [...new Set([resolve(path), join(next, ...components.slice(index + 1))])],
            available: false,
          };
        throw error;
      }
    }
    return { spellings: [...new Set([resolve(path), current])], available };
  } catch {
    throw new ConfinementError(`Cannot resolve read policy path ${path}`);
  }
}

export function policySpellings(paths: string[], denied = false, fs = policyFilesystem): string[] {
  const spellings = paths.flatMap((p) => policyPath(p, denied, fs).spellings);
  // Seatbelt does not equate the APFS Data-volume firmlink spelling when resolution is blocked.
  return [
    ...new Set(
      spellings.flatMap((p) =>
        denied && (p === "/System/Volumes/Data" || p.startsWith("/System/Volumes/Data/"))
          ? [p, p.slice("/System/Volumes/Data".length) || "/"]
          : [p],
      ),
    ),
  ];
}

export function resolvedHome(fs = policyFilesystem): string {
  let home = "<unknown>";
  try {
    home = readPolicyScope.getStore()?.home ?? homedir();
    if (!isAbsolute(home)) throw new Error();
    const resolved = fs.realpathSync(home);
    if (!fs.lstatSync(resolved, { throwIfNoEntry: false })?.isDirectory()) throw new Error();
    return resolved;
  } catch {
    throw new ConfinementError(`Cannot resolve home directory for read confinement: ${home}`);
  }
}

export const keychainReadPaths = () =>
  process.platform === "darwin" ? policySpellings([join(resolvedHome(), "Library/Keychains")], true) : [];

/** One credential list for tool-enabled sessions and gates; Claude's file-backed login stays readable (#369). */
export function homeReadPolicy(allowed: string[], gate = false, extra: string[] = [], fs = policyFilesystem) {
  const options = readPolicyScope.getStore();
  if (!options) throw new ConfinementError("Missing factory read policy");
  const env = options.environment ?? process.env;
  const home = resolvedHome(fs);
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);
  const cargo = expand(env.CARGO_HOME ?? join(home, ".cargo"));
  const credentials = policySpellings(
    [
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
        ...(process.platform === "darwin" ? ["Library/Keychains"] : []),
      ].map((p) => join(home, p)),
      ...[
        env.CODEX_HOME,
        env.GH_CONFIG_DIR,
        ...(env.XDG_CONFIG_HOME
          ? [join(env.XDG_CONFIG_HOME, "gh"), join(env.XDG_CONFIG_HOME, "limitless")]
          : []),
        env.LIMITLESS_CONFIG_DIR,
        env.AWS_SHARED_CREDENTIALS_FILE,
        env.AWS_CONFIG_FILE,
        env.DOCKER_CONFIG,
        env.GNUPGHOME,
        ...(env.KUBECONFIG?.split(sep === "/" ? ":" : ";") ?? []),
        env.NETRC,
        env.NPM_CONFIG_USERCONFIG,
        env.npm_config_userconfig,
        ...[join(home, ".cargo"), cargo].flatMap((p) => [
          join(p, "credentials"),
          join(p, "credentials.toml"),
        ]),
      ]
        .filter((p): p is string => !!p)
        .map(expand),
      ...(options.denyRead ?? []).map(expand),
      ...extra.filter((p) => !privateReadPaths().includes(p)),
    ],
    true,
    fs,
  );
  const denyRead = policySpellings([...credentials, ...privateReadPaths()], true, fs);
  const required = allowed.map((p) => {
    const path = policyPath(p, false, fs);
    if (!path.available) throw new ConfinementError(`Cannot resolve read policy path ${p}`);
    return path;
  });
  const optional = (
    gate
      ? [
          ...["bin", "install/cache"].map((p) => join(expand(env.BUN_INSTALL ?? join(home, ".bun")), p)),
          ...["bin", "registry", "git", "config", "config.toml"].map((p) => join(cargo, p)),
          ...["toolchains", "settings.toml", "update-hashes"].map((p) =>
            join(expand(env.RUSTUP_HOME ?? join(home, ".rustup")), p),
          ),
          ...(options.toolchains ?? []).map(expand),
        ]
      : []
  ).map((p) => policyPath(p, false, fs, true));
  // Check even omitted candidates: an absent credential descendant must never be allowlisted.
  for (const allow of [...required, ...optional].flatMap((p) => p.spellings))
    for (const deny of credentials)
      if (within(allow, deny) || within(deny, allow))
        throw new ConfinementError(`Read allowance ${allow} overlaps denied credential path ${deny}`);
  const allowRead = [
    ...new Set([...required, ...optional.filter((p) => p.available)].flatMap((p) => p.spellings)),
  ];
  return {
    denyRead: gate ? [...policySpellings([options.home ?? homedir()], true, fs), ...denyRead] : denyRead,
    ...(gate ? { allowRead } : {}),
  };
}

const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Keep the home-wide deny ahead of exceptions; all specific denies follow them. */
export const specificReadDenies = (allowed: string[], denied: string[]) =>
  denied.filter((deny) => !allowed.some((allow) => allow !== deny && within(deny, allow)));

/** Toolchain discovery may inspect these exact ancestor names, never list their parents. */
export function ancestorReadPolicy(allowed: string[], denied: string[]) {
  const ancestors = new Set<string>();
  for (const allow of allowed)
    for (let parent = dirname(allow); ; parent = dirname(parent)) {
      ancestors.add(parent);
      if (parent === dirname(parent)) break;
    }
  const specific = specificReadDenies(allowed, denied);
  const safe = (path: string) => !specific.some((deny) => within(deny, path));
  return {
    literals: [...ancestors]
      .flatMap((p) =>
        ["package.json", "bunfig.toml", "tsconfig.json", "jsconfig.json"].map((name) => join(p, name)),
      )
      .filter(safe),
    metadata: [...ancestors, ...[...ancestors].map((p) => join(p, "node_modules"))].filter(safe),
  };
}
