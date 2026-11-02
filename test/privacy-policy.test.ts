import { expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrivateStrings } from "../src/gates/private.ts";
import * as b from "../src/util/privacy-boundary.ts";
import {
  inspectPolicyFile,
  privacyPolicyDiagnostic,
  provisionPrivacyPolicy,
} from "../src/util/privacy-policy.ts";

test("policy freshness loads changes once, preserves equivalent authority, refuses failures and recovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-policy-")),
    file = join(dir, "private-strings.txt");
  const registry = b.createPrivacyRegistry(undefined, undefined, true),
    logs: string[] = [];
  let stats = 0,
    loads = 0,
    statFailed = false;
  const check = (text = "safe", data = false) => {
    const before = stats;
    const input = {
      policy: b.preparePrivacyPolicy(registry.snapshot()),
      provenance: { kind: "complete" } as const,
    };
    const receipt = data
      ? b.protectData({ ...input, json: text }, { registry })
      : b.protectText({ ...input, text }, { registry });
    expect(stats - before).toBe(1);
    return b.consumeBoundaryText(receipt);
  };
  try {
    provisionPrivacyPolicy(dir, [], {
      registry,
      log: (line) => logs.push(line),
      inspect: (path) => {
        stats++;
        if (statFailed) throw new Error("private-entry");
        return inspectPolicyFile(path);
      },
      load: (...args) => {
        loads++;
        return loadPrivateStrings(...args);
      },
    });
    expect(registry.generation.policy).toBe(0);
    expect(check().withheld).toBe(false);
    expect(check('{"key":["safe","fine"]}', true).withheld).toBe(false);
    expect(loads).toBe(1);
    writeFileSync(file, "alpha-entry");
    expect(check("alpha-entry")).toMatchObject({ withheld: true, reason: "private-match" });
    const generation = registry.generation;
    check();
    expect(loads).toBe(2);
    writeFileSync(file, "# comment\nalpha-entry\nalpha-entry\n");
    check();
    expect(registry.generation).toEqual(generation);
    writeFileSync(`${file}.new`, "beta-entry");
    renameSync(`${file}.new`, file);
    expect(check("beta-entry").reason).toBe("private-match");
    rmSync(file);
    expect(check("beta-entry").withheld).toBe(false);
    check();
    expect(loads).toBe(5);
    writeFileSync(join(dir, "target"), "gamma-entry");
    symlinkSync(join(dir, "target"), file);
    expect(check("gamma-entry").reason).toBe("private-match");
    writeFileSync(join(dir, "target"), "delta-entry");
    utimesSync(join(dir, "target"), 1, 1);
    expect(check("delta-entry").reason).toBe("private-match");
    rmSync(file);
    rmSync(join(dir, "target"));
    expect(check("delta-entry").withheld).toBe(false);
    for (const kind of ["directory", "hardlinks", "stat"] as const) {
      if (kind === "directory") mkdirSync(file);
      else if (kind === "hardlinks") {
        writeFileSync(file, "private-entry");
        linkSync(file, `${file}.link`);
      }
      statFailed = kind === "stat";
      expect(check().reason).toBe("unreadable-policy");
      expect(check("{}", true).reason).toBe("unreadable-policy");
      expect(logs).toEqual(
        Array(kind === "directory" ? 1 : kind === "hardlinks" ? 2 : 3).fill(privacyPolicyDiagnostic),
      );
      statFailed = false;
      rmSync(file, { recursive: true, force: true });
      rmSync(`${file}.link`, { force: true });
      expect(check().withheld).toBe(false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
