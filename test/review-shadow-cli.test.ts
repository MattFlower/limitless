import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShadowRow } from "../src/pipeline/shadow-report.ts";

const CUTOFF = Date.parse("2026-09-01T00:00:00Z");
const row = (runId: string, createdAt: number): ShadowRow => ({
  runId,
  repo: "owner/a",
  pr: `https://github.com/owner/a/pull/${runId.length}`,
  createdAt,
  round: "0",
  status: "completed",
  history: true,
  single: ["src/a.ts: Shared bug"],
  panel: ["src/a.ts: Shared bug", "src/b.ts: Race"],
  shared: ["src/a.ts: Shared bug"],
  panelOnly: [
    {
      finding: "src/b.ts: Race",
      outcome: "fixed",
      evidence: [
        {
          kind: "commit",
          source: "commit abc123",
          at: "2026-09-02T00:00:00Z",
          basis: "names the file and title and changes the file",
        },
      ],
    },
  ],
});
const ROWS = [row("run-before", CUTOFF - 1), row("run-at", CUTOFF), row("run-after", CUTOFF + 1)];

let dir: string;
let preload: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-shadow-cli-"));
  preload = join(dir, "fetch.ts");
  writeFileSync(
    preload,
    `globalThis.fetch = async (input) => {
      console.log("REQUEST " + new URL(String(input)).pathname);
      return Response.json(${JSON.stringify(ROWS)});
    };`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--preload", preload, join(import.meta.dir, "../src/cli/main.ts"), "review", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

test("shadow-report prints every retained comparison without --since", async () => {
  const { stdout, stderr, exit } = await cli("shadow-report");
  expect([exit, stderr]).toEqual([0, ""]);
  expect(stdout).toContain("REQUEST /api/review/shadow-report");
  for (const id of ["run-before", "run-at", "run-after"]) expect(stdout).toContain(`${id} owner/a`);
  expect(stdout).toContain("  single blocking: src/a.ts: Shared bug");
  expect(stdout).toContain("  panel blocking: src/a.ts: Shared bug; src/b.ts: Race");
  expect(stdout).toContain("  shared: src/a.ts: Shared bug");
  expect(stdout).toContain("  panel-only src/b.ts: Race: fixed");
  expect(stdout).toContain(
    "    commit abc123 @ 2026-09-02T00:00:00Z (names the file and title and changes the file)",
  );
});

test.each(["2026-09-01T00:00:00Z", "2026-09-01", "2026-09-01T02:00:00+02:00"])(
  "--since %s keeps runs created at or after the cutoff",
  async (since) => {
    const { stdout, exit } = await cli("shadow-report", "--since", since);
    expect(exit).toBe(0);
    expect(stdout).not.toContain("run-before");
    expect(stdout).toContain("run-at owner/a");
    expect(stdout).toContain("run-after owner/a");
  },
);

test("an empty selection says so", async () => {
  const { stdout, exit } = await cli("shadow-report", "--since", "2030-01-01T00:00:00Z");
  expect(exit).toBe(0);
  expect(stdout).toContain("No shadow review comparisons.");
});

test.each([
  [["shadow-report", "--since", "yesterday"], "--since: invalid ISO-8601 timestamp yesterday"],
  [["shadow-report", "--since", "2026-13-45T00:00:00Z"], "--since: invalid ISO-8601 timestamp"],
  // Date.parse would silently read these as March 2.
  [["shadow-report", "--since", "2026-02-30T00:00:00Z"], "--since: invalid ISO-8601 timestamp 2026-02-30"],
  [["shadow-report", "--since", "2026-02-30"], "--since: invalid ISO-8601 timestamp 2026-02-30"],
  [["shadow-report", "--since", "2026-09-01T25:00:00Z"], "--since: invalid ISO-8601 timestamp"],
  [["shadow-report", "--since", "1756684800000"], "--since: invalid ISO-8601 timestamp"],
  [["shadow-report", "--since"], "--since"],
  [["shadow-report", "--since", ""], "--since: invalid ISO-8601 timestamp"],
  [["report"], "usage: limitless review shadow-report"],
])("rejects %j", async (args, message) => {
  const { stdout, stderr, exit } = await cli(...args);
  expect(exit).toBe(1);
  expect(stderr).toContain(message);
  expect(stdout).not.toContain("REQUEST");
});
