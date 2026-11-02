import { expect, mock, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrivateStrings } from "../src/gates/private.ts";
import * as b from "../src/util/privacy-boundary.ts";
import * as p from "../src/util/privacy-policy.ts";

test("production policy refuses until loaded, refreshes on edits with one probe, and recovers", () => {
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

test.each(["text", "data"] as const)(
  "%s independently refuses a dangling policy symlink after missing-file provisioning",
  (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "privacy-policy-"));
    const file = join(dir, "private-strings.txt");
    const registry = b.createPrivacyRegistry(undefined, undefined, true);
    const log = mock();
    const check = () => {
      const policy = b.preparePrivacyPolicy(registry.snapshot());
      const provenance = { kind: "complete" } as const;
      return b.consumeBoundaryText(
        kind === "text"
          ? b.protectText({ text: "safe", provenance, policy }, { registry })
          : b.protectData({ json: '{"a":"safe"}', provenance, policy }, { registry }),
      );
    };
    try {
      p.provisionPrivacyPolicy(dir, [], { registry, log });
      expect(check().withheld).toBe(false);
      symlinkSync("absent-target", file);
      expect(check()).toMatchObject({ withheld: true, reason: "unreadable-policy" });
      expect(registry.ready).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      rmSync(file);
      expect(check().withheld).toBe(false);
      expect(registry.ready).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("failure diagnostics survive reprovisioning and reset only after a successful load", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-policy-"));
  const file = join(dir, "private-strings.txt");
  const registry = b.createPrivacyRegistry(undefined, undefined, true);
  const logs: string[] = [];
  const provision = () => p.provisionPrivacyPolicy(dir, [], { registry, log: (line) => logs.push(line) });
  const check = () =>
    b.consumeBoundaryText(
      b.protectText(
        {
          text: "safe",
          provenance: { kind: "complete" },
          policy: b.preparePrivacyPolicy(registry.snapshot()),
        },
        { registry },
      ),
    );
  try {
    for (let episode = 1; episode <= 2; episode++) {
      mkdirSync(file);
      provision();
      provision();
      for (let n = 0; n < 2; n++)
        expect(check()).toMatchObject({ withheld: true, reason: "unreadable-policy" });
      expect(logs).toEqual(Array(episode).fill("Privacy policy unavailable; privacy checks will refuse."));
      rmSync(file, { recursive: true });
      expect(check().withheld).toBe(false);
      expect(registry.ready).toBe(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("symlink retargeting and target edits reload, while unchanged or equivalent policies keep generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-policy-"));
  const file = join(dir, "private-strings.txt");
  const registry = b.createPrivacyRegistry(undefined, undefined, true);
  const inspect = mock(p.inspectPolicyFile),
    load = mock(loadPrivateStrings);
  const check = (text: string) => {
    const before = inspect.mock.calls.length;
    const result = b.consumeBoundaryText(
      b.protectText(
        {
          text,
          provenance: { kind: "complete" },
          policy: b.preparePrivacyPolicy(registry.snapshot()),
        },
        { registry },
      ),
    );
    expect(inspect.mock.calls.length - before).toBe(1);
    return result.reason;
  };
  try {
    writeFileSync(join(dir, "first"), "alpha-entry");
    writeFileSync(join(dir, "second"), "beta-entry");
    symlinkSync("first", file);
    p.provisionPrivacyPolicy(dir, [], { registry, inspect, load });
    expect(check("alpha-entry")).toBe("private-match");
    expect(check("safe")).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
    const generation = registry.generation;
    // A different link to the same file changes only the path metadata.
    symlinkSync("./first", `${file}.new`);
    renameSync(`${file}.new`, file);
    expect(check("alpha-entry")).toBe("private-match");
    expect(load).toHaveBeenCalledTimes(2);
    expect(registry.generation).toEqual(generation);
    writeFileSync(join(dir, "first"), "longer-alpha-entry");
    expect(check("longer-alpha-entry")).toBe("private-match");
    expect(load).toHaveBeenCalledTimes(3);
    expect(registry.generation.policy).toBe(generation.policy + 1);
    symlinkSync("second", `${file}.new`);
    renameSync(`${file}.new`, file);
    expect(check("beta-entry")).toBe("private-match");
    expect(check("safe")).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(4);
    expect(registry.generation.policy).toBe(generation.policy + 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
