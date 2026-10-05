import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Seen = { method: string; path: string; type: string | null; body: unknown };

async function cli(args: string[], respond: (path: string) => Response, command = "resolve") {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const path = new URL(req.url).pathname;
      const body = text ? JSON.parse(text) : null;
      seen.push({ method: req.method, path, type: req.headers.get("content-type"), body });
      return respond(path);
    },
  });
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli/main.ts"), command, ...args],
      {
        env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${server.port}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { seen, stdout, stderr, exit };
  } finally {
    server.stop();
  }
}

test("resolve posts the kind, ref and note once and reports the outcome or the daemon's error", async () => {
  const ok = await cli(
    ["run 1", "--as", "done_elsewhere", "--ref", "https://github.com/o/r/pull/9", "--note", "landed by hand"],
    () => Response.json({ id: "run 1", resolution: { kind: "done_elsewhere" } }),
  );
  expect(ok.exit).toBe(0);
  expect(ok.stdout).toContain("Resolved run 1 as done_elsewhere");
  expect(ok.seen).toEqual([
    {
      method: "POST",
      path: "/api/runs/run%201/resolve",
      type: "application/json",
      body: { kind: "done_elsewhere", ref: "https://github.com/o/r/pull/9", note: "landed by hand" },
    },
  ]);

  const conflict = await cli(["r1", "--as", "wont_do"], () =>
    Response.json(
      { error: "run is running; only needs_human and failed runs can be resolved" },
      { status: 409 },
    ),
  );
  expect(conflict.exit).not.toBe(0);
  expect(conflict.stderr).toContain("409: run is running");
  expect(conflict.seen).toEqual([
    { method: "POST", path: "/api/runs/r1/resolve", type: "application/json", body: { kind: "wont_do" } },
  ]);

  const usage = await cli(["r1"], () => Response.json({}));
  expect(usage.exit).not.toBe(0);
  expect(usage.stderr).toContain("usage: limitless resolve");
  expect(usage.seen).toEqual([]);
});

test("review posts findings as a changes verdict, or approves the head the factory last delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-cli-"));
  try {
    const findings = [{ severity: "major", title: "Handle empty input", detail: "It crashes." }];
    const file = join(dir, "findings.json");
    writeFileSync(file, JSON.stringify(findings));
    const sha = "a".repeat(40);
    const round = await cli(
      ["r1", "--changes", file, "--sha", sha],
      () => Response.json({ round: { id: "r2", title: "Review round 1: Add" } }, { status: 201 }),
      "review",
    );
    expect(round.exit).toBe(0);
    expect(round.stdout).toContain("Review round queued: r2");
    expect(round.seen).toEqual([
      {
        method: "POST",
        path: "/api/runs/r1/review",
        type: "application/json",
        body: { verdict: "changes", reviewedSha: sha, findings, reviewer: expect.any(String) },
      },
    ]);

    const delivered = "c".repeat(40);
    const detail = {
      run: { headSha: "b".repeat(40) },
      review: { rounds: [{ deliveredSha: delivered }, {}] },
    };
    const approve = await cli(
      ["r1", "--approve"],
      (path) =>
        Response.json(path.endsWith("/review") ? { approval: { sha: delivered, stale: false } } : detail),
      "review",
    );
    expect(approve.exit).toBe(0);
    expect(approve.stdout).toContain(`Approved ${delivered}`);
    expect(
      approve.seen.map((s) => [s.method, s.path, (s.body as { reviewedSha?: string } | null)?.reviewedSha]),
    ).toEqual([
      ["GET", "/api/runs/r1", undefined],
      ["POST", "/api/runs/r1/review", delivered],
    ]);

    for (const args of [["r1"], ["r1", "--approve", "--changes", file]]) {
      const usage = await cli(args, () => Response.json({}), "review");
      expect(usage.exit).not.toBe(0);
      expect(usage.stderr).toContain("limitless review <run> --changes <findings.json> | --approve");
      expect(usage.seen).toEqual([]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
