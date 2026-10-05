import { mock } from "bun:test";
import { setupDeps } from "../../src/cli/setup.ts";

const create = setupDeps;
mock.module("../../src/cli/setup.ts", () => ({
  setupDeps: () => {
    const d = create();
    d.run = async (args) => ({
      exitCode: 0,
      stdout: args[1] === "--version" ? "git version 2.45" : "installed",
      stderr: "",
    });
    return d;
  },
}));
const original = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/api/runs") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.repo !== "acme/app") throw new Error("repo must be scalar");
      return Response.json({ id: "scalar repo accepted", profile: "standard" });
    }
    return original(input, init);
  },
  { preconnect: original.preconnect },
);
