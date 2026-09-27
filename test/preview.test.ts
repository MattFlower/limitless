import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffInfo } from "../src/git/repos.ts";
import {
  needsPreview,
  type PreviewConfig,
  readPreviewConfig,
  startPreview,
} from "../src/pipeline/preview.ts";

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "preview-test-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "serve.ts"),
    `Bun.serve({hostname:"127.0.0.1",port:Number(process.env.LIMITLESS_PORT),async fetch(req){return new Response(new URL(req.url).pathname === "/health" ? "ok:" + await Bun.file(process.env.LIMITLESS_HOME + "/seed.txt").text() : "missing", {status: new URL(req.url).pathname === "/health" ? 200 : 404})}});`,
  );
  return dir;
}
const config: PreviewConfig = {
  paths: ["ui/"],
  build: "true",
  seed: 'mkdir -p "$LIMITLESS_HOME" && echo seeded > "$LIMITLESS_HOME/seed.txt"',
  serve: 'test "$LIMITLESS_NO_SCHEDULER" = 1 && bun serve.ts',
  ready: "/health",
  env: {
    LIMITLESS_HOME: "{scratch}/home",
    LIMITLESS_CONFIG_DIR: "{scratch}/config",
    LIMITLESS_PORT: "{port}",
  },
};
const diff = (path: string, from?: string): DiffInfo => ({
  files: [{ status: from ? "R100" : "M", path, from }],
  patch: "",
  stat: "",
  added: 1,
  removed: 1,
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("config and committed path selection include both rename paths", () => {
  const dir = fixture();
  expect(readPreviewConfig(dir)).toBeNull();
  writeFileSync(
    join(dir, ".limitless.toml"),
    `[preview]\npaths=["ui/"]\nbuild="true"\nserve="bun serve.ts"\nready="/health"\nenv={LIMITLESS_PORT="{port}"}\n`,
  );
  const parsed = readPreviewConfig(dir);
  expect(needsPreview(parsed, diff("src/main.ts"))).toBe(false);
  expect(needsPreview(parsed, diff("ui/main.ts"))).toBe(true);
  expect(needsPreview(parsed, diff("src/main.ts", "ui/main.ts"))).toBe(true);
  expect(needsPreview(parsed, diff("ui/main.ts", "src/main.ts"))).toBe(true);
  writeFileSync(join(dir, ".limitless.toml"), "[preview]\npaths=[]");
  expect(() => readPreviewConfig(dir)).toThrow("[preview].paths");
});

test("builds, seeds, serves during verification, and removes the process and scratch", async () => {
  const dir = fixture();
  const server = await startPreview(dir, config, new AbortController().signal);
  expect(await (await fetch(`${server.url}/health`)).text()).toBe("ok:seeded\n");
  expect(existsSync(server.scratch)).toBe(true);
  await server.stop();
  expect(existsSync(server.scratch)).toBe(false);
  await expect(fetch(`${server.url}/health`)).rejects.toThrow();
});

test.each([
  ["build", { build: "echo build-broken >&2; exit 7" }, "build-broken"],
  ["seed", { seed: "echo seed-broken >&2; exit 8" }, "seed-broken"],
  ["serve", { serve: "echo serve-broken >&2; exit 9" }, "serve-broken"],
])("reports %s failure before verification", async (_step, change, detail) => {
  const dir = fixture();
  await expect(startPreview(dir, { ...config, ...change }, new AbortController().signal)).rejects.toThrow(
    detail,
  );
});

test("cancellation stops the server and removes scratch", async () => {
  const dir = fixture();
  const controller = new AbortController();
  const server = await startPreview(dir, config, controller.signal);
  controller.abort();
  await server.stop();
  expect(existsSync(server.scratch)).toBe(false);
  await expect(fetch(`${server.url}/health`)).rejects.toThrow();
});

test("checked-in seed stays inside the supplied home", async () => {
  const dir = fixture();
  const home = join(dir, "home");
  const proc = Bun.spawn(["bun", "scripts/preview-seed.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, LIMITLESS_HOME: home, LIMITLESS_CONFIG_DIR: join(dir, "config") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(home, "limitless.db"), { readonly: true });
  try {
    const prompts = db.query("SELECT prompt FROM runs").all() as { prompt: string }[];
    expect(prompts).toHaveLength(3);
    expect(prompts.some((row) => row.prompt.length > 500)).toBe(true);
    expect(prompts.some((row) => row.prompt === "Fix spacing")).toBe(true);
    expect(prompts.some((row) => row.prompt.trim() === "")).toBe(true);
  } finally {
    db.close();
  }
});

test("readiness timeout reports the configured endpoint and cleans scratch", async () => {
  const dir = fixture();
  await expect(
    startPreview(dir, { ...config, ready: "/never" }, new AbortController().signal, 250),
  ).rejects.toThrow("readiness timed out");
});
