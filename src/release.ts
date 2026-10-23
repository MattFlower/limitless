import { resolve } from "node:path";
import { version } from "../package.json";

export const BUILD_DEFINES = {
  version: "LIMITLESS_BUILD_VERSION",
  sha: "LIMITLESS_BUILD_SHA",
} as const;
declare const LIMITLESS_BUILD_VERSION: string;
declare const LIMITLESS_BUILD_SHA: string;

type BuildIdentity = { version?: string; sha?: string };
export type Release = { version: string; bun: string } & (
  | { kind: "source"; root: string }
  | { kind: "packaged"; sha: string }
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
