import { mock, spyOn } from "bun:test";
import * as fs from "node:fs";

spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
spyOn(fs, "existsSync").mockImplementation((path) => String(path).endsWith("config.toml"));
spyOn(fs, "readFileSync").mockImplementation(
  (() => "[server]\nport = 9000\n") as unknown as typeof fs.readFileSync,
);

mock.module("../../src/cli/service.ts", () => ({
  install: async (port: number, opts: unknown) => console.log(JSON.stringify({ port, opts })),
  status: async (port: number) => console.log(JSON.stringify({ port })),
  deploy: async (port: number) => console.log(JSON.stringify({ port })),
}));
