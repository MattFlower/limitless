import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { cachePath } from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { createMcpServer, type McpBackend } from "../src/integrations/mcp.ts";
import type { Policy } from "../src/router/catalog.ts";
import { sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

const seedRepo = seeded(async (repo) => {
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  await sh(["git", "init", "-q", "-b", "main"], { cwd: repo });
  await sh(["git", "add", "."], { cwd: repo });
  await sh(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init"],
    { cwd: repo },
  );
});

export async function fixture(
  bootSha?: string | ((repo: string) => Promise<string | undefined>),
  excludeOrigins?: string[],
) {
  const home = mkdtempSync(join(tmpdir(), "limitless-mcp-"));
  const repo = join(home, "local repo");
  await seedRepo(repo);
  const resolvedBootSha = typeof bootSha === "function" ? await bootSha(repo) : bootSha;
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "config"), port: 7400 });
  mkdirSync(cfg.paths.configDir);
  writeFileSync(join(cfg.paths.configDir, "private-strings.txt"), "");
  const previousConfigDir = process.env.LIMITLESS_CONFIG_DIR;
  process.env.LIMITLESS_CONFIG_DIR = cfg.paths.configDir;
  cfg.secrets = {};
  if (excludeOrigins !== undefined) cfg.raw.routing = { exclude_origins: excludeOrigins };
  const factory = new Factory(cfg, {
    ...(resolvedBootSha ? { bootSha: resolvedBootSha } : {}),
    harnesses: { fake: fakeHarness(() => ({ delayMs: 30_000 })) },
    providers: [{ id: "fake", label: "Fake", harness: "fake", billing: "subscription", maxConcurrent: 2 }],
    models: [
      {
        id: "fake/m",
        provider: "fake",
        model: "test",
        vendor: "other",
        origin: "unknown",
        baseOrigin: "unknown",
        supportedEfforts: [],
        tier: 4,
        price: { input: 1, output: 1 },
      },
    ],
    policy: { triage: { default: ["fake/m"] } } as Policy,
  });
  return {
    home,
    repo,
    factory,
    async close() {
      await factory.stop();
      factory.store.close();
      if (previousConfigDir === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
      else process.env.LIMITLESS_CONFIG_DIR = previousConfigDir;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function connect(backend: McpBackend) {
  const server = createMcpServer(backend);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export function resultValue<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const content = result.content;
  if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("Expected text content");
  return JSON.parse(content[0].text as string) as T;
}

export type Route = (
  req: Request & { params: Record<string, string> },
  server: import("bun").Server<undefined>,
) => Promise<Response>;

export function requestWithParams(url: string, init?: RequestInit, params: Record<string, string> = {}) {
  return Object.assign(new Request(url, init), { params });
}

export const localServer = {
  timeout: () => {},
  requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 40000 }),
} as unknown as import("bun").Server<undefined>;

/** Local history and saved PR observation; never invokes GitHub or a model. */
export async function changeFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  contents?: Record<string, string>,
  github = false,
) {
  const run = github
    ? f.factory.store.createRun(
        f.factory.store.upsertRepo({
          slug: "test/repo",
          kind: "github",
          url: "https://github.com/test/repo.git",
          localPath: null,
          defaultBranch: "main",
          mergePolicy: "pr",
        }),
        { repo: "test/repo", prompt: "Review this change" },
      )
    : await f.factory.createRun({ repo: f.repo, prompt: "Review this change" });
  const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.repo })).stdout.trim();
  for (const [path, text] of Object.entries(
    contents ?? {
      "hello.txt": "hello\nnew greeting\n",
      "large.txt": Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join(""),
      "image.bin": "\0binary sentinel\0",
      ...Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`extra-${i}.txt`, "extra\n"])),
    },
  )) {
    mkdirSync(dirname(join(f.repo, path)), { recursive: true });
    writeFileSync(join(f.repo, path), text);
  }
  await sh(["git", "add", "."], { cwd: f.repo });
  await sh(["git", "commit", "-qm", "change"], { cwd: f.repo });
  const headSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.repo })).stdout.trim();
  const repo = f.factory.store.getRepo(run.repoId);
  if (!repo) throw new Error("Missing fixture repo");
  mkdirSync(f.factory.cfg.paths.repos, { recursive: true });
  await sh(["git", "clone", "--bare", f.repo, cachePath(f.factory.cfg.paths, repo)], { cwd: f.home });
  const prUrl = "https://github.com/test/repo/pull/1";
  f.factory.store.updateRun(run.id, {
    prUrl,
    status: "succeeded",
    baseSha,
    baseBranch: "main",
    branch: "limitless/feature",
  });
  const observe = (head: string) =>
    f.factory.store.saveGithubPr({
      url: prUrl,
      repo: repo.slug,
      runId: run.id,
      delivered: 1,
      nodeId: "PR_fixture",
      data: JSON.stringify({ state: "OPEN", headRefOid: head, baseRefName: "main" }),
    });
  observe(headSha);
  const report = `Factory report\n${"Reviewed locally.\n".repeat(400)}`;
  f.factory.store.putArtifact(run.id, "report.md", "report", report);
  return { run, repo, prUrl, baseSha, headSha, report, observe };
}

export interface ChangePage {
  available: boolean;
  headSha: string;
  baseSha: string;
  comparisonSha: string;
  baseBranch: string;
  files: {
    index: number;
    path: string;
    additions: number | null;
    deletions: number | null;
    binary: boolean;
  }[];
  nextFilesOffset: number | null;
  diff: { text: string; total: number; truncated: boolean; nextOffset: number | null; binary: boolean };
  reports: { run: string; available: boolean; text: string; truncated: boolean; nextOffset: number | null }[];
}
