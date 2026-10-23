import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { version } from "../package.json";

export const BUILD_DEFINES = {
  version: "LIMITLESS_BUILD_VERSION",
  sha: "LIMITLESS_BUILD_SHA",
  packaged: "LIMITLESS_BUILD_PACKAGED",
} as const;
declare const LIMITLESS_BUILD_VERSION: string;
declare const LIMITLESS_BUILD_SHA: string;
declare const LIMITLESS_BUILD_PACKAGED: boolean;

// The release build defines this true; callers guard source-only imports with it so Bun drops them.
export const PACKAGED_BUILD = typeof LIMITLESS_BUILD_PACKAGED !== "undefined" && LIMITLESS_BUILD_PACKAGED;

type BuildIdentity = { version?: string; sha?: string };
export type Release = { version: string; bun: string } & (
  | { kind: "source"; root: string }
  | { kind: "packaged"; sha: string; root?: string }
);

export function resolveRelease({
  standalone,
  build,
  bunVersion,
}: {
  standalone: boolean;
  build?: BuildIdentity;
  bunVersion: string;
}): Release {
  if (!standalone) return { kind: "source", version, root: resolve(import.meta.dir, ".."), bun: bunVersion };
  if (build?.version !== undefined || build?.sha !== undefined) {
    if (typeof build.version !== "string" || !build.version.trim())
      throw new Error("Invalid Limitless build identity: empty version");
    if (typeof build.sha !== "string" || !/^[0-9a-f]{40}$/.test(build.sha))
      throw new Error("Invalid Limitless build identity: SHA must be 40 lowercase hex characters");
    return { kind: "packaged", version: build.version, sha: build.sha, bun: bunVersion };
  }
  throw new Error("Missing Limitless build identity in standalone executable");
}

export const release = resolveRelease({
  standalone: Bun.isStandaloneExecutable,
  build: Bun.isStandaloneExecutable
    ? {
        version: typeof LIMITLESS_BUILD_VERSION !== "undefined" ? LIMITLESS_BUILD_VERSION : undefined,
        sha: typeof LIMITLESS_BUILD_SHA !== "undefined" ? LIMITLESS_BUILD_SHA : undefined,
      }
    : undefined,
  bunVersion: Bun.version,
});

export async function resolveReleaseBootSha(
  resolveGit: (root: string) => Promise<string | undefined>,
  info: Release = release,
): Promise<string | undefined> {
  return info.kind === "packaged" ? info.sha : resolveGit(info.root);
}

// Bun embeds each `--asset` under its basename at the bundle root (`/$bunfs/root`), which every bundled
// module, including this one, sees as `import.meta.dir`. `root` on a packaged release only exists for tests.
export function resourcePath(relative: string, info: Release = release): string {
  return info.kind === "source"
    ? join(info.root, relative)
    : join(info.root ?? import.meta.dir, basename(relative));
}

export function policyOverlayPath(info: Release = release): string {
  const path = resourcePath("routing/policy.json", info);
  if (info.kind === "packaged" && !existsSync(path))
    throw new Error(`Packaged Limitless is missing its embedded routing overlay: ${path}`);
  return path;
}
