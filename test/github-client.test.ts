import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghClient, startGitHubPoller } from "../src/integrations/github-poller.ts";
import { githubToken } from "../src/integrations/github-token.ts";
import * as proc from "../src/util/proc.ts";
import { junit, reportZip } from "./ci-evidence-support.ts";
import { pollerHarness } from "./github-poller-support.ts";

let dir: string;
let originalPath: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "github-client-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
});
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
});

function fakeGh(token: string, exitCode: number, stderr = "") {
  writeFileSync(
    join(dir, "gh"),
    `#!${process.execPath}
if (process.argv.slice(2).join(" ") !== "auth token") process.exit(2);
console.log(${JSON.stringify(token)});
console.error(${JSON.stringify(stderr)});
process.exit(${exitCode});
`,
    { mode: 0o755 },
  );
}

test.each(["non-zero exit", "timeout", "signal", "empty output", "process error"])(
  "token lookup hides output from errors and poller logs on %s",
  async (failure) => {
    const token = `fake-token-${randomUUID()}`;
    const diagnostic = `private-stderr-${randomUUID()}`;
    fakeGh(
      failure === "empty output" ? "  " : token,
      failure === "non-zero exit" ? 1 : 0,
      failure === "non-zero exit" || failure === "timeout" ? "" : diagnostic,
    );
    const realProcess = proc.runProcess;
    const lookup = spyOn(proc, "runProcess").mockImplementation((opts) => {
      if (failure === "process error") throw new Error(`${token} ${diagnostic}`);
      return realProcess(opts).then((result) => {
        if (failure === "timeout") return { ...result, timedOut: true };
        if (failure === "signal") return { ...result, exitCode: null, signal: "SIGTERM" };
        return result;
      });
    });
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unexpected fetch after failed token lookup"),
    );
    const h = pollerHarness();
    let stop = () => {};
    try {
      const message = `gh auth token failed: ${failure}`;
      const error = await ghClient("user").catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe(`Error: ${message}`);
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(diagnostic);

      h.factoryPr("o/r", 1);
      const logged = Promise.withResolvers<string>();
      stop = startGitHubPoller(h.store, {
        client: ghClient,
        gh: async () => {
          throw new Error("Unexpected conflict lookup");
        },
        clock: {
          now: h.clock.now,
          set: h.clock.timer.set as unknown as typeof setTimeout,
          clear: h.clock.timer.clear,
        },
        log: logged.resolve,
      });
      await h.advance(0);
      const line = await logged.promise;
      expect(line).toBe(`GitHub poll of o/r failed: Error: ${message}`);
      expect(line).not.toContain(token);
      expect(line).not.toContain(diagnostic);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      stop();
      h.close();
      lookup.mockRestore();
      fetch.mockRestore();
    }
  },
);

test.each(["json", "zip"])("authenticated %s downloads preserve their response bodies", async (kind) => {
  const token = `fake-token-${randomUUID()}`;
  fakeGh(` ${token} `, 0);
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`bearer ${token}`);
    expect(proc.redactCredentials(`credential: ${token}`)).toBe("credential: [redacted]");
    return kind === "zip"
      ? new Response(new Uint8Array(reportZip(junit())))
      : Response.json({ login: "test" });
  }) as typeof globalThis.fetch);
  try {
    expect((await ghClient(kind === "zip" ? "repos/o/r/actions/artifacts/1/zip" : "user")).body).toEqual(
      kind === "zip" ? reportZip(junit()) : { login: "test" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(proc.redactCredentials(token)).toBe("[redacted]");
  } finally {
    fetch.mockRestore();
  }
});

test.each(["cancelled", "truncated output"])("shared token lookup safely rejects %s", async (failure) => {
  const token = `fake-token-${randomUUID()}`;
  fakeGh(token, 0, token);
  await expect(
    githubToken(undefined, async (opts) => {
      const result = await proc.runProcess(opts);
      return { ...result, cancelled: failure === "cancelled", truncated: failure === "truncated output" };
    }),
  ).rejects.toThrow(`gh auth token failed: ${failure}`);
  expect(proc.redactCredentials(token)).toBe("[redacted]");
});
