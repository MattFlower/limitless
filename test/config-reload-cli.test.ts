import { expect, test } from "bun:test";
import { configCommand } from "../src/cli/config.ts";
import { ApiError } from "../src/cli/feed.ts";

test("config reload sends one HTTP mutation and prints all result categories", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const lines: string[] = [];
  await configCommand(["reload"], {
    api: async <T>(path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { applied: ["workers.agents"], restartRequired: ["server.port"], unchanged: [] } as T;
    },
    print: (line) => lines.push(line),
  });
  expect(calls).toEqual([{ path: "/api/admin/config/reload", init: { method: "POST", body: "{}" } }]);
  expect(lines).toEqual(["applied: workers.agents", "restartRequired: server.port", "unchanged: (none)"]);
});

test("older daemon errors propagate without a restart or another request", async () => {
  let calls = 0;
  const deps = {
    api: async <T>(): Promise<T> => {
      calls++;
      throw new ApiError("404: Not Found", 404);
    },
    print: () => {
      throw new Error("Unexpected output");
    },
  };
  await expect(configCommand(["reload"], deps)).rejects.toMatchObject({ status: 404 });
  expect(calls).toBe(1);
  for (const args of [[], ["reload", "extra"], ["restart"]])
    await expect(configCommand(args, deps)).rejects.toThrow("Usage: limitless config reload");
  expect(calls).toBe(1);
});
