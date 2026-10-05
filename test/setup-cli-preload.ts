import { mock } from "bun:test";
import { setupDeps } from "../src/cli/setup.ts";
import { assertReadOnlyCommand } from "./fixtures/setup-commands.ts";

const commands: string[] = [],
  requests: string[] = [],
  violations: string[] = [];
function unexpected(message: string): never {
  violations.push(message);
  throw new Error(message);
}
// Doctor catches probe errors; fail the child even if it would otherwise exit successfully.
process.once("exit", () => {
  if (process.env.LIMITLESS_TEST_SETUP_TRACE)
    console.error(JSON.stringify({ commands, requests, violations }));
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
});

const create = setupDeps;
mock.module("../src/cli/setup.ts", () => ({
  setupDeps: () => {
    const d = create();
    d.run = async (args) => {
      if (process.env.LIMITLESS_TEST_SETUP_MUTATION && args.join(" ") === "git rev-parse HEAD")
        args = ["bun", "main.ts", "service", "install"];
      commands.push(args.join(" "));
      try {
        assertReadOnlyCommand(args);
      } catch (error) {
        unexpected(String(error));
      }
      return { exitCode: 0, stdout: args[1] === "--version" ? "git version 2.45" : "installed", stderr: "" };
    };
    d.smoke = async () => [{ name: "fake live", status: "pass", durationMs: 0 }];
    d.mcp = async () => "already set";
    return d;
  },
}));
const original = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push(`${method} ${url}`);
    if (url === `${process.env.LIMITLESS_URL ?? "http://127.0.0.1:7400"}/api/runs` && method === "POST") {
      const body = JSON.parse(String(init?.body));
      if (body.repo !== "acme/app") throw new Error("repo must be scalar");
      return Response.json({ id: "scalar repo accepted", profile: "standard" });
    }
    if (method === "GET") {
      if (url === "https://openrouter.ai/api/v1/key") return Response.json({ data: {} });
      if ([1234, 8000, 8080, 8989, 11434, 10240].some((port) => url === `http://127.0.0.1:${port}/v1/models`))
        return Response.json({ data: url.includes(":1234/") ? [{ id: "local-model" }] : [] });
      if (["http://twilight:8080/v1/models", "http://192.0.2.10:8080/v1/models"].includes(url))
        return Response.json({ data: [{ id: "lan-model" }] });
      const daemon = process.env.LIMITLESS_URL;
      if (
        daemon &&
        new URL(daemon).hostname === "127.0.0.1" &&
        ["/api/health", "/api/github/access"].some((path) => url === `${daemon}${path}`)
      )
        return original(input, init);
    }
    return unexpected(`Unexpected fetch: ${method} ${url}`);
  },
  { preconnect: original.preconnect },
);
