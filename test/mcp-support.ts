import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { createMcpServer, type McpBackend } from "../src/integrations/mcp.ts";
import type { Policy } from "../src/router/catalog.ts";
import { sh } from "../src/util/proc.ts";

export async function fixture(bootSha?: string | ((repo: string) => Promise<string | undefined>)) {
  const home = mkdtempSync(join(tmpdir(), "limitless-mcp-"));
  const repo = join(home, "local repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  await sh(["git", "init", "-q", "-b", "main"], { cwd: repo });
  await sh(["git", "add", "."], { cwd: repo });
  await sh(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init"],
    { cwd: repo },
  );
  const resolvedBootSha = typeof bootSha === "function" ? await bootSha(repo) : bootSha;
  const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "config"), port: 7400 });
  cfg.secrets = {};
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
