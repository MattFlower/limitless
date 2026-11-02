import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { startDaemon } from "../src/cli/daemon.ts";
import { evalCommand } from "../src/cli/eval.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { runWorker } from "../src/workers/client.ts";

test.each(["daemon", "worker", "eval"])("%s provisions privacy before exposing work", async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-startup-"));
  const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "config"), raw: {}, port: 0 });
  mkdirSync(join(cfg.paths.home, "worker"), { recursive: true });
  for (const name of ["token", "coordinator-fingerprint"])
    writeFileSync(join(cfg.paths.home, "worker", name), "x");
  for (const failed of [false, true]) {
    const calls: string[] = [];
    const exposed = <T>(name: string, value?: T) => {
      calls.push(name);
      if (failed) throw new Error("startup failed");
      return value as T;
    };
    const privacy = {
      provision: (configDir: string, roots: string[]) => {
        expect([configDir, roots]).toEqual([cfg.paths.configDir, [cfg.paths.repos, cfg.paths.work]]);
        calls.push("provision");
      },
      dispose: async () => void calls.push(await Promise.resolve("disposed")),
    };
    const store = new Store(":memory:");
    const factory = new Factory(cfg, { store, models: [], providers: [] });
    spyOn(factory, "start").mockImplementation(() => exposed("scheduler"));
    const [stop, cli] = [new AbortController(), { version: null, loggedIn: false }];
    const agents = { claude: cli, codex: cli };
    const reply = { status: 200, data: Buffer.alloc(0), fingerprint: "", json: () => ({ cancelled: [] }) };
    const serve = (() => ({ url: new URL("http://127.0.0.1:7400"), stop() {} })) as never;
    const mount = async () => exposed("integrations", { routes: {}, notes: [], stop: async () => {} });
    const running = {
      daemon: () =>
        startDaemon(factory, {}, mount, serve, async () => {}, privacy).then((d) => d.server.stop()),
      worker: () =>
        runWorker("https://example.com", cfg, "release", stop.signal, {
          privacy,
          platform: "darwin",
          probeAgents: async () => (failed ? exposed("request", agents) : agents),
          machineState: async () => ({ onAC: true, idleSeconds: 0 }),
          request: async () => {
            stop.abort();
            return exposed("request", reply);
          },
        }),
      eval: () =>
        evalCommand(
          ["run", "triage"],
          { models: "candidate-a" },
          {
            config: () => cfg,
            provisionPrivacy: privacy.provision,
            print() {},
            wait: async () => {},
            api: async <T>() => exposed("submission", { id: "eval" } as T),
          },
        ),
    }[kind];
    const result = await running?.().catch((error: unknown) => error);
    expect(result instanceof Error).toBe(failed);
    const exposure = { daemon: "integrations", worker: "request", eval: "submission" }[kind] ?? "";
    const expected = ["provision", exposure, ...(kind === "daemon" && !failed ? ["scheduler"] : [])];
    expect(calls).toEqual(kind === "eval" ? expected : [...expected, "disposed"]);
    store.close();
  }
  rmSync(dir, { recursive: true, force: true });
});
