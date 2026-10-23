import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../package.json";
import { MIGRATION_DIR } from "../src/db/migration-runner.ts";
import { policyOverlayPath, resolveRelease, resolveReleaseBootSha, resourcePath } from "../src/release.ts";

const sha = "a".repeat(40);
const bunVersion = "test-bun";

test("source identity uses the package version and checkout root", () => {
  expect(resolveRelease({ standalone: false, bunVersion })).toEqual({
    kind: "source",
    version,
    root: resolve(import.meta.dir, ".."),
    bun: bunVersion,
  });
});

test("valid build defines select packaged only in standalone mode", () => {
  expect(resolveRelease({ standalone: true, build: { version: "2.0.0", sha }, bunVersion })).toEqual({
    kind: "packaged",
    version: "2.0.0",
    sha,
    bun: bunVersion,
  });
});

test("standalone requires build identity", () => {
  expect(() => resolveRelease({ standalone: true, bunVersion })).toThrow("Missing Limitless build identity");
});

test.each([
  {},
  { version: "1", sha: "A".repeat(40) },
  { version: "1", sha: "abc" },
  { version: "1", sha: "" },
  { version: "", sha },
  { version: "  ", sha },
  { version: "1" },
  { sha },
])("malformed or partial identity refuses: %j", (build) => {
  expect(() => resolveRelease({ standalone: true, build, bunVersion })).toThrow("Limitless build identity");
  expect(resolveRelease({ standalone: false, build, bunVersion }).kind).toBe("source");
});

test.each([undefined, { version: "2.0.0", sha }])("source ignores supplied identity: %j", (build) => {
  expect(resolveRelease({ standalone: false, build, bunVersion })).toEqual(
    resolveRelease({ standalone: false, bunVersion }),
  );
});

test("source never accesses build identity properties", () => {
  const build = {
    get version(): string {
      throw new Error("version accessed");
    },
    get sha(): string {
      throw new Error("SHA accessed");
    },
  };
  expect(resolveRelease({ standalone: false, build, bunVersion }).kind).toBe("source");
});

test("packaged boot SHA never invokes git", async () => {
  const git = mock(async () => undefined);
  const info = resolveRelease({ standalone: true, build: { version, sha }, bunVersion });
  expect(await resolveReleaseBootSha(git, info)).toBe(sha);
  expect(git).not.toHaveBeenCalled();
});

test.each([sha, undefined])("source boot SHA preserves git result %s", async (result) => {
  const git = mock(async () => result);
  const info = resolveRelease({ standalone: false, bunVersion });
  expect(await resolveReleaseBootSha(git, info)).toBe(result);
  expect(git).toHaveBeenCalledTimes(1);
  expect(git).toHaveBeenCalledWith(resolve(import.meta.dir, ".."));
});

const resources = {
  "src/db/migrations": "migrations",
  "routing/policy.json": "policy.json",
  "integrations/codex/.agents/skills/limitless/SKILL.md": "SKILL.md",
};

test("source resources resolve to today's checkout paths", () => {
  const checkout = join(import.meta.dir, "..");
  const info = resolveRelease({ standalone: false, bunVersion });
  for (const relative of Object.keys(resources))
    expect(resourcePath(relative, info)).toBe(join(checkout, relative));
  expect(resourcePath("src/db/migrations")).toBe(join(checkout, "src/db/migrations"));
  expect(MIGRATION_DIR).toBe(join(checkout, "src/db/migrations"));
});

describe("packaged resources", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "limitless-embedded-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const packaged = () => ({ kind: "packaged", version: "2.0.0", sha, bun: bunVersion, root }) as const;

  test("resolve to their basenames under the embedded root", () => {
    for (const [relative, name] of Object.entries(resources))
      expect(resourcePath(relative, packaged())).toBe(join(root, name));
  });

  test("a missing embedded overlay refuses; a present one is returned", () => {
    expect(() => policyOverlayPath(packaged())).toThrow(
      `Packaged Limitless is missing its embedded routing overlay: ${join(root, "policy.json")}`,
    );
    writeFileSync(join(root, "policy.json"), "{}");
    expect(policyOverlayPath(packaged())).toBe(join(root, "policy.json"));
  });

  test("a source checkout without an overlay still starts on defaults", () => {
    const info = { kind: "source", version, root, bun: bunVersion } as const;
    expect(policyOverlayPath(info)).toBe(join(root, "routing/policy.json"));
  });
});
