import { expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { version } from "../package.json";
import { resolveRelease, resolveReleaseBootSha } from "../src/release.ts";

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
