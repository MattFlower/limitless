import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { startDaemon } from "../src/cli/daemon.ts";
import { evalCommand } from "../src/cli/eval.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import * as b from "../src/util/privacy-boundary.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import { runWorker } from "../src/workers/client.ts";

test.each(["daemon", "worker", "eval"])("%s provisions before exposing work and cleans up", async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-startup-"));
  const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "config"), raw: {}, port: 0 });
  mkdirSync(cfg.paths.configDir);
  writeFileSync(join(cfg.paths.configDir, "private-strings.txt"), "startup-entry");
  try {
    for (const failed of [false, true]) {
      const calls: string[] = [],
        registry = b.createPrivacyRegistry(undefined, undefined, true);
      const disposing = Promise.withResolvers<void>(),
        disposed = Promise.withResolvers<void>();
      const privacy = {
        provision(configDir: string, roots: string[]) {
          expect([configDir, roots]).toEqual([cfg.paths.configDir, [cfg.paths.repos, cfg.paths.work]]);
          provisionPrivacyPolicy(configDir, roots, { registry });
          calls.push("provision");
        },
        async dispose() {
          calls.push("dispose");
          disposing.resolve();
          await disposed.promise;
          calls.push("disposed");
        },
      };
      const exposed = (name: string) => {
        expect(registry.ready).toBe(true);
        expect(registry.entries[0]?.value).toBe("startup-entry");
        calls.push(name);
        if (failed) throw new Error("startup failed");
      };
      const store = new Store(":memory:");
      const factory = new Factory(cfg, { store, models: [], providers: [] });
      const start = spyOn(factory, "start").mockImplementation(() => exposed("scheduler"));
      try {
        const running = (async () => {
          if (kind === "daemon") {
            const serve = (() => {
              exposed("listener");
              return { url: new URL("http://127.0.0.1:7400"), port: 7400, stop() {} };
            }) as unknown as typeof Bun.serve<undefined>;
            const daemon = await startDaemon(
              factory,
              {},
              async () => {
                exposed("integrations");
                return { routes: {}, notes: [], stop: async () => {} };
              },
              serve,
              async () => {},
              privacy,
            );
            await daemon.server.stop();
          } else if (kind === "worker") {
            const home = join(cfg.paths.home, "worker");
            mkdirSync(home, { recursive: true });
            for (const name of ["token", "coordinator-fingerprint"])
              writeFileSync(join(home, name), "synthetic-worker-value");
            const stop = new AbortController();
            await runWorker("https://example.com", cfg, "release", stop.signal, {
              privacy,
              platform: "darwin",
              probeAgents: async () => {
                if (failed) exposed("request");
                const cli = { version: null, loggedIn: false };
                return { claude: cli, codex: cli };
              },
              machineState: async () => ({ onAC: true, idleSeconds: 0 }),
              request: async () => {
                exposed("request");
                stop.abort();
                return {
                  status: 200,
                  data: Buffer.alloc(0),
                  fingerprint: "",
                  json: () => ({ cancelled: [] }),
                };
              },
            });
          } else
            await evalCommand(
              ["run", "triage"],
              { models: "candidate-a" },
              {
                config: () => cfg,
                provisionPrivacy: privacy.provision,
                print() {},
                wait: async () => {},
                api: async <T>() => {
                  exposed("submission");
                  return { id: "eval" } as T;
                },
              },
            );
        })();
        const observed = running.catch((error: unknown) => error);
        if (kind !== "eval") {
          await Promise.race([disposing.promise, observed]);
          expect(calls).toContain("dispose");
          expect(calls).not.toContain("disposed");
          disposed.resolve();
        }
        const result = await observed;
        expect(result instanceof Error).toBe(failed);
        const expected = [
          "provision",
          kind === "daemon" ? "integrations" : kind === "worker" ? "request" : "submission",
        ];
        if (kind === "daemon" && !failed) expected.push("listener", "scheduler");
        if (kind !== "eval") expected.push("dispose", "disposed");
        expect(calls).toEqual(expected);
      } finally {
        start.mockRestore();
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
