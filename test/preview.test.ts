import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffInfo } from "../src/git/repos.ts";
import { readPolicyScope } from "../src/harness/read-policy.ts";
import { type ConfinementBackend, ConfinementError, confinementScope } from "../src/harness/sandbox.ts";
import {
  startPreview as launchPreview,
  needsPreview,
  type PreviewConfig,
  readPreviewConfig,
} from "../src/pipeline/preview.ts";
import { fakeConfinement, recordingConfinement, seatbeltSkip } from "./confinement.ts";

const startPreview: typeof launchPreview = (...args) => confinedPreview(fakeConfinement, ...args);

function confinedPreview(backend: ConfinementBackend, ...args: Parameters<typeof launchPreview>) {
  const home = mkdtempSync(join(tmpdir(), "preview-home-"));
  dirs.push(home);
  return readPolicyScope.run(readPolicyScope.getStore() ?? { home, environment: {} }, () =>
    confinementScope.run(backend, () => launchPreview(...args)),
  );
}

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "preview-test-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "serve.ts"),
    `await Bun.write("server-pid", String(process.pid)); await Bun.write("scratch", process.env.HOME ?? ""); await Bun.write("port", process.env.LIMITLESS_PORT ?? ""); Bun.serve({hostname:"127.0.0.1",port:Number(process.env.LIMITLESS_PORT),async fetch(req){return new Response(new URL(req.url).pathname === "/health" ? "ok:" + await Bun.file(process.env.LIMITLESS_HOME + "/seed.txt").text() : "missing", {status: new URL(req.url).pathname === "/health" ? 200 : 404})}});`,
  );
  return dir;
}
const config: PreviewConfig = {
  paths: ["ui/"],
  build: "true",
  seed: 'mkdir -p "$LIMITLESS_HOME" && echo seeded > "$LIMITLESS_HOME/seed.txt"',
  serve: 'test "$LIMITLESS_NO_SCHEDULER" = 1 && bun serve.ts',
  ready: "/health",
  env: {
    LIMITLESS_HOME: "{scratch}/home",
    LIMITLESS_CONFIG_DIR: "{scratch}/config",
    LIMITLESS_PORT: "{port}",
  },
};
const diff = (path: string, from?: string): DiffInfo => ({
  files: [{ status: from ? "R100" : "M", path, from }],
  patch: "",
  stat: "",
  added: 1,
  removed: 1,
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("config and committed path selection include both rename paths", () => {
  const dir = fixture();
  expect(readPreviewConfig(null)).toBeNull();
  writeFileSync(
    join(dir, ".limitless.toml"),
    `[preview]\npaths=["ui/"]\nbuild="true"\nserve="bun serve.ts"\nready="/health"\nenv={LIMITLESS_PORT="{port}"}\n`,
  );
  const parsed = readPreviewConfig(readFileSync(join(dir, ".limitless.toml"), "utf8"));
  expect(needsPreview(parsed, diff("src/main.ts"))).toBe(false);
  expect(needsPreview(parsed, diff("ui/main.ts"))).toBe(true);
  expect(needsPreview(parsed, diff("src/main.ts", "ui/main.ts"))).toBe(true);
  expect(needsPreview(parsed, diff("ui/main.ts", "src/main.ts"))).toBe(true);
  writeFileSync(join(dir, ".limitless.toml"), "[preview]\npaths=[]");
  expect(() => readPreviewConfig(readFileSync(join(dir, ".limitless.toml"), "utf8"))).toThrow(
    "[preview].paths",
  );
});

test("builds, seeds, serves during verification, and removes the process and scratch", async () => {
  const dir = fixture();
  const server = await startPreview(dir, config, new AbortController().signal);
  expect(await (await fetch(`${server.url}/health`)).text()).toBe("ok:seeded\n");
  expect(existsSync(server.scratch)).toBe(true);
  await server.stop();
  expect(existsSync(server.scratch)).toBe(false);
  await expect(fetch(`${server.url}/health`)).rejects.toThrow();
});

test.each([
  ["build", { build: "echo build-broken >&2; exit 7" }, "build-broken"],
  ["seed", { seed: "echo seed-broken >&2; exit 8" }, "seed-broken"],
  ["serve", { serve: "echo serve-broken >&2; exit 9" }, "serve-broken"],
])("reports %s failure before verification", async (_step, change, detail) => {
  const dir = fixture();
  await expect(
    startPreview(
      dir,
      {
        ...config,
        ...change,
        [_step]: `printf '%s' "$HOME" > scratch; echo $$ > server-pid; sleep 60 >/dev/null 2>&1 & echo $! > descendant-pid; ${Object.values(change)[0]}`,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(detail);
  await expectCleaned(dir);
  await until(() => !alive(Number(readFileSync(join(dir, "descendant-pid"), "utf8"))));
});

test("cancellation stops the server and removes scratch", async () => {
  const dir = fixture();
  const controller = new AbortController();
  const server = await startPreview(dir, config, controller.signal);
  controller.abort();
  await until(() => !existsSync(server.scratch));
  expect(existsSync(server.scratch)).toBe(false);
  await expect(fetch(`${server.url}/health`)).rejects.toThrow();
});

test("checked-in seed stays inside the supplied home", async () => {
  const dir = fixture();
  const home = join(dir, "home");
  const proc = Bun.spawn(["bun", "scripts/preview-seed.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, LIMITLESS_HOME: home, LIMITLESS_CONFIG_DIR: join(dir, "config") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(home, "limitless.db"), { readonly: true });
  try {
    const prompts = db.query("SELECT prompt, status FROM runs").all() as { prompt: string; status: string }[];
    expect(prompts.map((row) => row.status).sort()).toEqual(["failed", "needs_human", "succeeded"]);
    expect(prompts).toHaveLength(3);
    expect(prompts.some((row) => row.prompt.length > 500 && row.prompt.includes("\n"))).toBe(true);
    expect(prompts.some((row) => row.prompt === "Fix spacing")).toBe(true);
    expect(prompts.some((row) => row.prompt.trim() === "")).toBe(true);
  } finally {
    db.close();
  }
});

test("readiness timeout reports the configured endpoint and cleans scratch", async () => {
  const dir = fixture();
  await expect(
    startPreview(dir, { ...config, ready: "/never" }, new AbortController().signal, 250),
  ).rejects.toThrow("readiness timed out");
  await expectCleaned(dir);
});

test.each(["ready", "timeout"])(
  "large unterminated serve output preserves health, cleanup and bounded diagnostics (%s)",
  async (state) => {
    const dir = fixture();
    writeFileSync(
      join(dir, "serve.ts"),
      `
await Bun.write("server-pid", String(process.pid));
await Bun.write("scratch", process.env.HOME ?? "");
async function flood() {
  const chunk = "x".repeat(65_536);
  for (let i = 0; i < 64; i++) {
    for (const stream of [process.stdout, process.stderr]) {
      await new Promise((resolve, reject) => stream.write(chunk, error => error ? reject(error) : resolve()));
    }
  }
  await Bun.write("emitted", "done");
}
Bun.serve({hostname: "127.0.0.1", port: Number(process.env.LIMITLESS_PORT), fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/flood") { void flood(); return new Response("emitting"); }
  return new Response("ok", {status: path === "/health" ? 200 : 404});
}});
await Bun.write("port", process.env.LIMITLESS_PORT ?? "");
`,
    );
    const controller = new AbortController();
    const starting = startPreview(
      dir,
      { ...config, ready: state === "ready" ? "/health" : "/never" },
      controller.signal,
      3_000,
    ).then(
      (server) => ({ server, error: null }),
      (error: unknown) => ({ server: null, error }),
    );
    try {
      // Begin the flood after readiness in the healthy case, while polling in the timeout case.
      if (state === "ready") expect((await starting).error).toBeNull();
      await until(() => existsSync(join(dir, "port")));
      const url = `http://127.0.0.1:${readFileSync(join(dir, "port"), "utf8")}`;
      expect(await (await fetch(`${url}/flood`)).text()).toBe("emitting");
      await until(() => existsSync(join(dir, "emitted")));
      expect(await (await fetch(`${url}/health`)).text()).toBe("ok");
      if (state === "timeout") {
        const { error } = await starting;
        expect(error).toBeInstanceOf(Error);
        const message = String(error);
        expect(message).toContain("Preview readiness timed out");
        expect(message).toContain("[truncated]");
        expect(message.length).toBeLessThan(4_200);
      }
    } finally {
      controller.abort();
      const { server } = await starting;
      await server?.stop();
    }
    await expectCleaned(dir);
  },
  10_000,
);

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectCleaned(dir: string): Promise<void> {
  const scratch = readFileSync(join(dir, "scratch"), "utf8");
  expect(scratch).not.toBe("");
  expect(existsSync(scratch)).toBe(false);
  const pid = Number(readFileSync(join(dir, "server-pid"), "utf8"));
  await until(() => !alive(pid));
  if (existsSync(join(dir, "port"))) {
    const port = readFileSync(join(dir, "port"), "utf8");
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  }
}

test.each(["build", "readiness"])("abort during %s kills the process and removes scratch", async (step) => {
  const dir = fixture();
  const controller = new AbortController();
  const starting = startPreview(
    dir,
    {
      ...config,
      ...(step === "build"
        ? { build: "printf '%s' \"$HOME\" > scratch; echo $$ > server-pid; exec sleep 60" }
        : { ready: "/never" }),
    },
    controller.signal,
  );
  const rejected = starting.then(
    () => new Error("Unexpected preview success"),
    (error: unknown) => error,
  );
  const pidFile = join(dir, "server-pid");
  await until(
    () =>
      existsSync(pidFile) &&
      /^[1-9]\d*$/.test(readFileSync(pidFile, "utf8").trim()) &&
      existsSync(join(dir, "scratch")),
  );
  controller.abort();
  expect(String(await rejected)).toContain("Preview cancelled");
  await expectCleaned(dir);
});

test("build timeout kills the process and removes scratch", async () => {
  const dir = fixture();
  await expect(
    startPreview(
      dir,
      {
        ...config,
        build: "printf '%s' \"$HOME\" > scratch; echo $$ > server-pid; exec sleep 60",
      },
      new AbortController().signal,
      20_000,
      250,
    ),
  ).rejects.toThrow("build timed out");
  await expectCleaned(dir);
});

test("reserved environment is enforced after expansion for build, seed and serve", async () => {
  const dir = fixture();
  writeFileSync(
    join(dir, "env.ts"),
    'await Bun.write(process.argv[2] + ".json", JSON.stringify(process.env));',
  );
  const server = await startPreview(
    dir,
    {
      ...config,
      build: "bun env.ts build",
      seed: `bun env.ts seed; ${config.seed}`,
      serve: "bun env.ts serve; bun serve.ts",
      env: {
        ...config.env,
        HOME: "/override",
        TMPDIR: "/override",
        TMP: "/override",
        TEMP: "/override",
        GH_TOKEN: "override",
        GIT_SSH_COMMAND: "override",
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_KEY_0: "override",
        GIT_CONFIG_VALUE_0: "override",
        GIT_TERMINAL_PROMPT: "1",
        GIT_CONFIG_KEY_99: "override",
        LIMITLESS_NO_SCHEDULER: "0",
      },
    },
    new AbortController().signal,
  );
  try {
    for (const step of ["build", "seed", "serve"]) {
      const env = JSON.parse(readFileSync(join(dir, `${step}.json`), "utf8")) as Record<string, string>;
      for (const key of ["HOME", "TMPDIR", "TMP", "TEMP"]) expect(env[key]).toBe(server.scratch);
      expect(env.GH_TOKEN).toBe("limitless-agents-have-no-github-access");
      expect(env.GIT_SSH_COMMAND).toContain("agents cannot use git over ssh");
      expect(env.GIT_CONFIG_COUNT).toBe("2");
      expect(env.GIT_CONFIG_KEY_1).toBe("diff.autoRefreshIndex");
      expect(env.GIT_CONFIG_VALUE_1).toBe("false");
      expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
      expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
      expect(env.GIT_CONFIG_VALUE_0).toBe("");
      expect(env.GIT_CONFIG_KEY_99).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.LIMITLESS_NO_SCHEDULER).toBe("1");
      expect(env.LIMITLESS_HOME).toBe(`${server.scratch}/home`);
      expect(env.LIMITLESS_PORT).toBe(new URL(server.url).port);
    }
  } finally {
    await server.stop();
  }
});

test.each(["{scratch}/../escape", "prefix..suffix"])("rejects env value %s", async (value) => {
  const text = `[preview]\npaths=["ui/"]\nbuild="true"\nserve="true"\nready="/health"\nenv={HOME="${value}"}`;
  expect(() => readPreviewConfig(text)).toThrow("[preview].env");
  await expect(
    startPreview(fixture(), { ...config, env: { HOME: value } }, new AbortController().signal),
  ).rejects.toThrow("[preview].env");
});

test.each(["/\\evil.example/x", "//evil.example/x", "/\t/evil.example/x"])(
  "rejects escaping readiness URL %s",
  async (ready) => {
    const text = `[preview]\npaths=["ui/"]\nbuild="true"\nserve="true"\nready=${JSON.stringify(ready)}\nenv={}`;
    expect(() => readPreviewConfig(text)).toThrow("[preview].ready");
    await expect(startPreview(fixture(), { ...config, ready }, new AbortController().signal)).rejects.toThrow(
      "[preview].ready",
    );
  },
);

test("teardown stops a detached grandchild holding stdout open", async () => {
  const dir = fixture();
  writeFileSync(
    join(dir, "detached.ts"),
    `
import { spawn } from "node:child_process";
const child = spawn("sleep", ["60"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
await Bun.write("detached-pid", String(child.pid));
child.unref();
await import("./serve.ts");
`,
  );
  const server = await startPreview(
    dir,
    { ...config, serve: "exec bun detached.ts" },
    new AbortController().signal,
  );
  const pid = Number(readFileSync(join(dir, "detached-pid"), "utf8"));
  try {
    await server.stop();
    expect(alive(pid)).toBe(false);
    await expectCleaned(dir);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
    await server.stop();
  }
});

function linkedFixture() {
  const root = realpathSync(fixture());
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  cpSync(join(root, "serve.ts"), join(checkout, "serve.ts"));
  const cache = join(root, "cache.git");
  const admin = join(cache, "worktrees", "preview");
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(checkout, ".git"), `gitdir: ${admin}\n`);
  writeFileSync(join(admin, "gitdir"), `${checkout}/.git\n`);
  writeFileSync(join(admin, "commondir"), "../..\n");
  const record = `${checkout}.git-paths`;
  writeFileSync(record, JSON.stringify([checkout, admin, cache]));
  const home = join(root, "real-home");
  mkdirSync(home);
  const targets = [join(admin, "index"), join(cache, "config"), join(home, "sentinel"), record];
  for (const target of targets.slice(0, -1)) writeFileSync(target, "original");
  return { root, checkout, cache, admin, record, home, targets };
}

function writeProbe(checkout: string, targets: string[]) {
  writeFileSync(
    join(checkout, "probe.ts"),
    `
const denied = [];
for (const target of ${JSON.stringify(targets)}) {
  try { await Bun.write(target, "tampered"); throw new Error("write unexpectedly allowed: " + target); }
  catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    denied.push(target);
  }
}
await Bun.write("checkout-write", "allowed");
await Bun.write("denied.json", JSON.stringify(denied));
`,
  );
}

// This fake enforces Bun.write in the probe process using the roots supplied by production.
function enforcingConfinement(policy: string) {
  const recording = recordingConfinement();
  const backend: ConfinementBackend = {
    verify: recording.backend.verify,
    wrap: (cmd, roots) => {
      writeFileSync(
        policy,
        `
import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
const roots = ${JSON.stringify(roots)};
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};
const original = Bun.write;
Bun.write = async (path, ...args) => {
  const target = typeof path === "string" ? realpathSync(resolve(path)) : "";
  if (!roots.write.some(root => within(root, target)) || roots.protect.some(root => within(root, target)))
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  return original(path, ...args);
};
`,
      );
      return cmd.map((part) => (part === "bun probe.ts" ? `bun --preload '${policy}' probe.ts` : part));
    },
  };
  return { ...recording, backend };
}

test("confined build denies admin, cache, real HOME and git-paths writes; all steps share scratch", async () => {
  const f = linkedFixture();
  // Existing files make the fake's canonical path checks independent of creation behavior.
  for (const name of ["checkout-write", "denied.json"]) writeFileSync(join(f.checkout, name), "");
  writeProbe(f.checkout, f.targets);
  const before = f.targets.map((target) => readFileSync(target, "utf8"));
  const { backend, calls } = enforcingConfinement(join(f.root, "policy.ts"));
  const server = await readPolicyScope.run({ home: f.home, environment: {} }, () =>
    confinedPreview(backend, f.checkout, { ...config, build: "bun probe.ts" }, new AbortController().signal),
  );
  try {
    expect(readFileSync(join(f.checkout, "checkout-write"), "utf8")).toBe("allowed");
    expect(JSON.parse(readFileSync(join(f.checkout, "denied.json"), "utf8"))).toEqual(f.targets);
    expect(f.targets.map((target) => readFileSync(target, "utf8"))).toEqual(before);
    expect(calls.map(({ opts }) => opts.cmd)).toEqual([
      ["/bin/sh", "-c", "bun probe.ts"],
      ["/bin/sh", "-c", config.seed ?? ""],
      ["/bin/sh", "-c", config.serve],
    ]);
    for (const { roots, opts } of calls) {
      expect(roots.write).toContain(f.checkout);
      expect(roots.write).toContain(server.scratch);
      expect(roots.protect).toContain(f.admin);
      expect(roots.protect).toContain(f.record);
      for (const path of [f.admin, f.cache, f.home, f.record]) expect(roots.write).not.toContain(path);
      expect(opts.env.HOME).toBe(server.scratch);
      expect(opts.env.LIMITLESS_CONFINED).toBe("1");
    }
    expect(await (await fetch(`${server.url}/health`)).text()).toBe("ok:seeded\n");
  } finally {
    await server.stop();
  }
  expect(existsSync(server.scratch)).toBe(false);
});

test.each(["build", "seed", "serve"] as const)(
  "failed %s confinement verification or launch never starts its candidate",
  async (step) => {
    for (const failure of ["verify", "launch"]) {
      const dir = fixture();
      let scratch = "";
      const wrapped: string[] = [];
      const commands = {
        build: "touch build-started",
        seed: `${config.seed}; touch seed-started`,
        serve: "touch serve-started; bun serve.ts",
      };
      const backend: ConfinementBackend = {
        verify: async (_roots, opts) => {
          scratch = opts.env.HOME ?? "";
          if (opts.cmd.at(-1) === commands[step] && failure === "verify")
            throw new ConfinementError(`injected ${step} verification failure`);
        },
        wrap: (cmd) => {
          const command = cmd.at(-1) ?? "";
          wrapped.push(command);
          return command === commands[step] && failure === "launch"
            ? ["/bin/sh", "-c", "echo launch-refused >&2; exit 71"]
            : cmd;
        },
      };
      await expect(
        confinedPreview(backend, dir, { ...config, ...commands }, new AbortController().signal),
      ).rejects.toThrow(failure === "verify" ? `${step} verification failure` : "payload did not start");
      expect(existsSync(join(dir, `${step}-started`))).toBe(false);
      expect(scratch).not.toBe("");
      expect(existsSync(scratch)).toBe(false);
      expect(wrapped).toHaveLength(["build", "seed", "serve"].indexOf(step) + (failure === "launch" ? 1 : 0));
    }
  },
);

test.skipIf(seatbeltSkip !== null)(
  `real Seatbelt preview denies protected writes and binds loopback ${seatbeltSkip ?? ""}`,
  async () => {
    const f = linkedFixture();
    writeProbe(f.checkout, f.targets);
    const before = f.targets.map((target) => readFileSync(target, "utf8"));
    const server = await readPolicyScope.run({ home: f.home, environment: {} }, () =>
      launchPreview(f.checkout, { ...config, build: "bun probe.ts" }, new AbortController().signal),
    );
    try {
      expect(readFileSync(join(f.checkout, "checkout-write"), "utf8")).toBe("allowed");
      expect(JSON.parse(readFileSync(join(f.checkout, "denied.json"), "utf8"))).toEqual(f.targets);
      expect(f.targets.map((target) => readFileSync(target, "utf8"))).toEqual(before);
      expect(await (await fetch(`${server.url}/health`)).text()).toBe("ok:seeded\n");
    } finally {
      await server.stop();
    }
    expect(existsSync(server.scratch)).toBe(false);
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  },
);

test("repository preview builds the UI, seeds, serves health and cleans up", async () => {
  const dir = fixture();
  const repo = join(import.meta.dir, "..");
  for (const name of ["src", "scripts", "ui", "package.json", ".limitless.toml"])
    cpSync(join(repo, name), join(dir, name), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  const previewConfig = readPreviewConfig(readFileSync(join(dir, ".limitless.toml"), "utf8"));
  if (!previewConfig) throw new Error("Missing repository preview config");
  const server = await startPreview(dir, previewConfig, new AbortController().signal);
  try {
    expect(existsSync(join(dir, "dist", "index.html"))).toBe(true);
    expect(existsSync(join(server.scratch, "home", "limitless.db"))).toBe(true);
    expect((await fetch(`${server.url}/api/health`)).ok).toBe(true);
    expect((await fetch(server.url)).ok).toBe(true);
  } finally {
    await server.stop();
  }
  expect(existsSync(server.scratch)).toBe(false);
  await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
}, 30_000);
