import { expect, spyOn } from "bun:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export async function withoutIO(run: () => Promise<void>) {
  const spies: { mockRestore(): void }[] = [];
  const calls: string[] = [];
  function block<T extends object>(target: T, keys: readonly (keyof T)[]) {
    const methods = target as Record<keyof T, (...args: never[]) => unknown>;
    for (const key of keys) {
      spies.push(
        spyOn(methods, key).mockImplementation(() => {
          calls.push(String(key));
          throw new Error("Unexpected IO");
        }),
      );
    }
  }
  try {
    block(console, ["log", "info", "warn", "error", "debug", "trace"]);
    block(process.stdout, ["write"]);
    block(process.stderr, ["write"]);
    block(globalThis, ["fetch"]);
    block(Bun, ["file", "write", "spawn", "spawnSync"]);
    block(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
    block(fs, ["readFile", "readFileSync", "writeFile", "writeFileSync", "open", "openSync", "readdirSync"]);
    block(fsPromises, ["readFile", "writeFile", "open", "readdir"]);
    block(net, ["connect", "createConnection"]);
    block(http, ["request", "get"]);
    block(https, ["request", "get"]);
    await run();
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    expect(calls).toEqual([]);
  }
}

export function fixedFailure(run: () => unknown, message: string, sentinels: string[] = []) {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected failure");
  expect(error.message).toBe(message);
  expect(error.name).toBe("Error");
  expect(error).not.toHaveProperty("cause");
  const runtimeFields = ["message", "stack", "line", "column", "sourceURL", "originalLine", "originalColumn"];
  expect(Reflect.ownKeys(error).filter((key) => !runtimeFields.includes(String(key)))).toEqual([]);
  for (const sentinel of sentinels) {
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(sentinel);
    expect(String(error)).not.toContain(sentinel);
  }
}
