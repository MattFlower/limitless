import { expect, test } from "bun:test";
import { auditDiff } from "../src/gates/audit.ts";
import type { DiffInfo } from "../src/git/repos.ts";

function protectedFindings(files: DiffInfo["files"]): string[] {
  return auditDiff(
    { patch: "", files, stat: "", added: 0, removed: 0 },
    { taskClass: "feature", protectedPaths: ["test/fixtures/**"] },
  )
    .filter((finding) => finding.rule === "protected-path")
    .map((finding) => `${finding.file}:${finding.severity}`);
}

test("adding a file under a protected path warns instead of blocking", () => {
  expect(protectedFindings([{ status: "A", path: "test/fixtures/new.json" }])).toEqual([
    "test/fixtures/new.json:warn",
  ]);
});

test("editing or deleting a protected file still blocks", () => {
  expect(
    protectedFindings([
      { status: "A", path: "test/fixtures/new.json" },
      { status: "M", path: "test/fixtures/old.json" },
      { status: "D", path: "test/fixtures/gone.json" },
    ]),
  ).toEqual(["test/fixtures/new.json:warn", "test/fixtures/old.json:block", "test/fixtures/gone.json:block"]);
});

test("renames into or out of a protected path still block", () => {
  expect(protectedFindings([{ status: "R100", from: "test/fixtures/a.json", path: "data/a.json" }])).toEqual([
    "test/fixtures/a.json:block",
  ]);
  expect(protectedFindings([{ status: "R100", from: "data/b.json", path: "test/fixtures/b.json" }])).toEqual([
    "test/fixtures/b.json:block",
  ]);
});

test("files outside protected paths produce no protected-path finding", () => {
  expect(protectedFindings([{ status: "A", path: "src/new.ts" }])).toEqual([]);
});

test("an added protected file does not block the audit", () => {
  const findings = auditDiff(
    {
      patch: "",
      files: [
        { status: "A", path: "test/fixtures/payload.json" },
        { status: "M", path: "src/app.ts" },
      ],
      stat: "",
      added: 0,
      removed: 0,
    },
    { taskClass: "feature", protectedPaths: ["test/fixtures/**"] },
  );
  expect(findings.some((finding) => finding.severity === "block")).toBe(false);
});
