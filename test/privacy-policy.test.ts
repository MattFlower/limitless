import { expect, mock, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrivateStrings } from "../src/gates/private.ts";
import * as b from "../src/util/privacy-boundary.ts";
import * as p from "../src/util/privacy-policy.ts";

test("production policy refuses until loaded, refreshes on edits with one stat, and recovers", () => {
  const [dir, logs] = [mkdtempSync(join(tmpdir(), "privacy-policy-")), [] as string[]];
  const [file, registry] = [
    join(dir, "private-strings.txt"),
    b.createPrivacyRegistry(undefined, undefined, true),
  ];
  const [inspect, load] = [mock(p.inspectPolicyFile), mock(loadPrivateStrings)];
  const [stats, loads] = [() => inspect.mock.calls.length, () => load.mock.calls.length];
  const check = (text = "safe", data = false, policy = b.preparePrivacyPolicy(registry.snapshot())) => {
    const [before, provenance] = [stats(), { kind: "complete" } as const];
    const receipt = data
      ? b.protectData({ json: text, provenance, policy }, { registry })
      : b.protectText({ text, provenance, policy }, { registry });
    expect(stats() - before).toBeLessThanOrEqual(1);
    return b.consumeBoundaryText(receipt).reason;
  };
  expect([check(), check("{}", true)]).toEqual(["unreadable-policy", "unreadable-policy"]);
  p.provisionPrivacyPolicy(dir, [], { registry, inspect, load, log: (line) => logs.push(line) });
  expect([check(), check('{"a":["safe"]}', true), loads()]).toEqual([undefined, undefined, 1]);
  writeFileSync(file, "alpha-entry");
  expect([check("alpha-entry"), check('{"a":"alpha-entry"}', true), loads()]).toEqual([
    "private-match",
    "private-match",
    2,
  ]);
  const generation = registry.generation;
  writeFileSync(file, "# comment\nalpha-entry\nalpha-entry\n");
  expect([check(), loads(), registry.generation]).toEqual([undefined, 3, generation]);
  writeFileSync(`${file}.new`, "beta-entry");
  renameSync(`${file}.new`, file);
  expect(check("beta-entry")).toBe("private-match");
  rmSync(file);
  expect(check("beta-entry")).toBeUndefined();
  for (const broken of ["directory", "hardlinks"]) {
    const prepared = b.preparePrivacyPolicy(registry.snapshot());
    if (broken === "directory") mkdirSync(file);
    else writeFileSync(file, "entry");
    if (broken === "hardlinks") linkSync(file, `${file}.link`);
    expect([check("safe", false, prepared), check("{}", true)]).toEqual([
      "unreadable-policy",
      "unreadable-policy",
    ]);
    rmSync(file, { recursive: true });
    rmSync(`${file}.link`, { force: true });
    expect(check()).toBeUndefined();
  }
  expect(logs).toEqual([p.privacyPolicyDiagnostic, p.privacyPolicyDiagnostic]);
  rmSync(dir, { recursive: true, force: true });
});
