import { mock } from "bun:test";

mock.module("../../src/cli/service.ts", () => ({
  install: async (_port: number, opts: unknown) => console.log(JSON.stringify(opts)),
}));
