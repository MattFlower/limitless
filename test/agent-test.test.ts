import { afterEach, expect, spyOn, test } from "bun:test";
import {
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
import { delimiter, join } from "node:path";
import {
  agentTestCommand,
  enterCallerDirectory,
  realExecutable,
  testLane,
  type WrapperConfig,
  wrapperLeaseClient,
  wrapperMain,
} from "../src/cli/agent-test.ts";
import { type LeaseClient, LeaseRejected, withGateLease } from "../src/cli/gate-slot.ts";
import { AgentTestSession, agentTestLease, type TestWait } from "../src/gates/agent-tests.ts";
import { agentTestSlots, gateSlots } from "../src/gates/slots.ts";
import { SCRATCH_NAME } from "../src/harness/scratch.ts";
import { withSlottedCommands } from "../src/harness/slotted.ts";
import { readSlottedCommands } from "../src/harness/slotted-config.ts";
import { sh } from "../src/util/proc.ts";

import { waitClock } from "./wait-clock.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-tests-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "wrappers"),
    real = join(root, "real"),
    marker = join(root, "marker");
  mkdirSync(directory);
  mkdirSync(real);
  const fake = join(real, "bun");
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_MARKER"\nexit 3\n', { mode: 0o755 });
  const path = process.env.PATH,
    previousMarker = process.env.TEST_MARKER;
  cleanup.push(() => {
    process.env.PATH = path;
    if (previousMarker === undefined) delete process.env.TEST_MARKER;
    else process.env.TEST_MARKER = previousMarker;
  });
  process.env.PATH = [directory, real, "/usr/bin", "/bin"].join(delimiter);
  process.env.TEST_MARKER = marker;
  const config: WrapperConfig = {
    directory,
    commands: [["bun", "test"]],
    port: 1,
    unix: join(root, "unused.sock"),
    token: "test-token",
  };
  return { root, directory, real, marker, config, fake };
}

test("matched command waits, passes exit code and releases its lease", async () => {
  const f = fixture(),
    queued = Promise.withResolvers<void>(),
    acquire = Promise.withResolvers<void>();
  const requests: Record<string, unknown>[] = [];
  let first = true;
  const client: LeaseClient = async (body) => {
    requests.push(body);
    if (body.release) return { id: "lease", acquired: false };
    if (first) {
      first = false;
      queued.resolve();
      return { id: "lease", acquired: false };
    }
    await acquire.promise;
    return { id: "lease", acquired: true };
  };
  const work = agentTestCommand(f.config, ["bun", "test"], client);
  await queued.promise;
  expect(existsSync(f.marker)).toBe(false);
  acquire.resolve();
  expect(await work).toBe(3);
  expect(readFileSync(f.marker, "utf8")).toBe("test\n");
  expect(requests[0]).toMatchObject({ name: "bun test", lane: "gate", token: "test-token" });
  expect(requests.at(-1)).toMatchObject({ id: "lease", release: true });
});

test("unslotted argv executes immediately without requesting a lease", async () => {
  const f = fixture();
  let requests = 0;
  const client: LeaseClient = async () => {
    requests++;
    throw new Error("must not request");
  };
  for (const args of [["install"], ["run", "lint"], ["testing"]])
    expect(await agentTestCommand(f.config, ["bun", ...args], client)).toBe(3);
  expect(requests).toBe(0);
  expect(readFileSync(f.marker, "utf8")).toBe("install\nrun lint\ntesting\n");
});

test("coordination outage runs with a warning, but rejected leases never run the binary", async () => {
  const f = fixture();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(
      agentTestCommand(f.config, ["bun", "test"], async () => {
        throw new LeaseRejected("rejected");
      }),
    ).rejects.toThrow("rejected");
    expect(existsSync(f.marker)).toBe(false);
    expect(warning).not.toHaveBeenCalled();
    expect(
      await agentTestCommand(f.config, ["bun", "test"], async () => {
        throw new Error("offline");
      }),
    ).toBe(3);
    expect(warning.mock.calls.flat().join()).toContain("coordination unavailable");
    expect(readFileSync(f.marker, "utf8")).toBe("test\n");
  } finally {
    warning.mockRestore();
  }
});

test("abort while queued releases the lease, reports SIGTERM and never starts the binary", async () => {
  const f = fixture(),
    waiting = Promise.withResolvers<void>();
  const requests: Record<string, unknown>[] = [];
  const before = process.listenerCount("SIGTERM");
  const work = agentTestCommand(f.config, ["bun", "test"], async (body) => {
    requests.push(body);
    waiting.resolve();
    return { id: "lease", acquired: false };
  });
  await waiting.promise;
  process.emit("SIGTERM");
  expect(await work).toBe(143);
  expect(existsSync(f.marker)).toBe(false);
  expect(requests.at(-1)).toMatchObject({ release: true });
  expect(process.listenerCount("SIGTERM")).toBe(before);
});

test("resolution excludes wrapper aliases, runs once, and returns 127 when missing", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, "bun"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const alias = join(f.root, "alias");
  symlinkSync(f.directory, alias);
  process.env.PATH = [alias, f.directory, f.real].join(delimiter);
  expect(realExecutable("bun", process.env.PATH, f.directory)).toBe(f.fake);
  expect(await agentTestCommand(f.config, ["bun", "install"])).toBe(3);
  expect(readFileSync(f.marker, "utf8")).toBe("install\n");
  rmSync(f.fake);
  writeFileSync(join(f.directory, "other-wrapper"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  symlinkSync(join(f.directory, "other-wrapper"), f.fake);
  expect(realExecutable("bun", process.env.PATH, f.directory)).toBeNull();
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await agentTestCommand(f.config, ["bun", "install"])).toBe(127);
    expect(stderr).toHaveBeenCalledWith("agent-test: real executable not found: bun");
  } finally {
    stderr.mockRestore();
  }
});

test.each([
  ['slotted_commands = "bun test"'],
  ['slotted_commands = [""]'],
  ['slotted_commands = ["   "]'],
  ['slotted_commands = ["/bin/bun test"]'],
  ["slotted_commands = [\"'bin\\\\bun' test\"]"],
  ['slotted_commands = ["bun test", 2]'],
  ['slotted_commands = ["bun \\"test"]'],
])("invalid commands warn once and disable the complete feature: %s", (value) => {
  const warnings: string[] = [];
  expect(readSlottedCommands(`[limits]\n${value}`, (s) => warnings.push(s))).toEqual([]);
  expect(warnings).toHaveLength(1);
});

test("valid argv prefixes include quoting and unset/empty configuration stays off", () => {
  const warn = () => {
    throw new Error("unexpected warning");
  };
  expect(readSlottedCommands('[limits]\nslotted_commands = ["bun test", "npm test"]', warn)).toEqual([
    ["bun", "test"],
    ["npm", "test"],
  ]);
  expect(readSlottedCommands(`[limits]\nslotted_commands = ["bun test 'some file'"]`, warn)).toEqual([
    ["bun", "test", "some file"],
  ]);
  for (const contents of [null, "[gates]", "[limits]\nslotted_commands = []"])
    expect(readSlottedCommands(contents, warn)).toEqual([]);
});

test.each([
  [[], "gate"],
  [["test/a.test.ts"], "small"],
  [["--coverage"], "gate"],
  [["--timeout", "5000"], "gate"],
  [["--preload", "setup.ts"], "gate"],
  [["-r", "setup.ts"], "gate"],
  [["--timeout=1000", "test/a.test.ts"], "small"],
  [["--timeout", "5000", "test/a.test.ts"], "small"],
  [["-t", "some test"], "gate"],
  [["--test-name-pattern=x"], "gate"],
  [["--cwd", "test"], "gate"],
  [["--cwd=test", "test/a.test.ts"], "gate"],
  [["--unknown-flag", "test/a.test.ts"], "gate"],
  [["test"], "gate"],
  [["missing.test.ts"], "gate"],
  [["--bail", "test/a.test.ts"], "small"],
  [["--bail=2", "test/a.test.ts"], "small"],
  [["--", "test/a.test.ts"], "small"],
  [["--config", "test/a.test.ts"], "gate"],
  [["--env-file=test/a.test.ts"], "gate"],
] as const)("lane classification: %j => %s", (extra, lane) => {
  const f = fixture();
  mkdirSync(join(f.root, "test"));
  writeFileSync(join(f.root, "test/a.test.ts"), "");
  expect(testLane(["bun", "test", ...extra], ["bun", "test"], f.root)).toBe(lane);
});

test("two lanes, authenticated invocation leases, wait duration, and invocation cleanup", async () => {
  const old = gateSlots.limit;
  gateSlots.setLimit(1);
  const release = await gateSlots.acquire(new AbortController().signal);
  const events: TestWait[] = [];
  const acquired = Promise.withResolvers<void>();
  const session = new AgentTestSession((data) => {
    events.push(data);
    if (data.phase === "acquired") acquired.resolve();
  });
  const other = new AgentTestSession(() => {});
  try {
    const full = await agentTestLease({ token: session.token, name: "bun test", lane: "gate" });
    const targeted = await agentTestLease({
      token: session.token,
      name: "bun test a.test.ts",
      lane: "small",
    });
    expect(full.acquired).toBe(false);
    expect(targeted.acquired).toBe(true);
    expect(agentTestSlots.snapshot().limit).toBe(2);
    expect(events).toEqual([{ kind: "agent-test", phase: "wait", command: "bun test", lane: "gate" }]);
    await expect(agentTestLease({ token: "forged", name: "bun test", lane: "gate" })).rejects.toThrow(
      "capability",
    );
    await expect(other.request({ token: other.token, id: full.id, release: true })).rejects.toThrow("belong");
    release();
    await acquired.promise;
    expect(events[1]).toMatchObject({
      kind: "agent-test",
      phase: "acquired",
      command: "bun test",
      lane: "gate",
      waitMs: expect.any(Number),
    });
    await session.request({ token: session.token, id: full.id });
    expect(events).toHaveLength(2);
    session.close();
    expect(gateSlots.snapshot().occupied).toBe(0);
    expect(agentTestSlots.snapshot().occupied).toBe(0);
  } finally {
    release();
    session.close();
    other.close();
    gateSlots.setLimit(old);
  }
});

test("installed wrappers catch cd/env and nested scripts, use scratch transport and clean up", async () => {
  const f = fixture(),
    scratch = join(f.root, SCRATCH_NAME),
    sub = join(f.root, "sub");
  mkdirSync(scratch);
  mkdirSync(sub);
  writeFileSync(join(sub, "a.test.ts"), "");
  writeFileSync(join(f.root, "nested.test.ts"), "");
  writeFileSync(
    f.fake,
    '#!/bin/sh\nif [ "$1" = run ]; then bun test nested.test.ts; else printf "%s\\n" "$*" >> "$TEST_MARKER"; exit 3; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(join(f.real, "bash"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_MARKER"\nexit 3\n', {
    mode: 0o755,
  });
  const held: (() => void)[] = [];
  let wrapper = "";
  const events: TestWait[] = [];
  // Occupy the small lane so the real wrappers must wait and report their lease requests.
  for (let i = 0; i < 2; i++) held.push(await agentTestSlots.acquire(new AbortController().signal));
  const waiting = Promise.withResolvers<void>();
  try {
    await withSlottedCommands(
      [...f.config.commands, ["bash", "test"]],
      f.root,
      scratch,
      1,
      (data) => {
        events.push(data);
        if (data.phase === "wait") waiting.resolve();
      },
      async (path) => {
        wrapper = path?.split(delimiter)[0] ?? "";
        expect(wrapper.startsWith(scratch)).toBe(false);
        const command = sh(["/bin/sh", "-c", "cd sub && FOO=1 bun test a.test.ts"], {
          cwd: f.root,
          env: { PATH: path ?? "", TEST_MARKER: f.marker },
          allowFail: true,
        });
        await waiting.promise;
        expect(existsSync(f.marker)).toBe(false);
        for (const release of held) release();
        expect((await command).exitCode).toBe(3);
        expect(
          (
            await sh(["bun", "run", "nested"], {
              cwd: f.root,
              env: { PATH: path ?? "", TEST_MARKER: f.marker },
              allowFail: true,
            })
          ).exitCode,
        ).toBe(3);
        expect(
          (
            await sh(["bash", "install"], {
              cwd: f.root,
              env: { PATH: path ?? "", TEST_MARKER: f.marker },
              allowFail: true,
              timeoutMs: 5000,
            })
          ).exitCode,
        ).toBe(3);
      },
    );
    expect(readFileSync(f.marker, "utf8")).toBe("test a.test.ts\ntest nested.test.ts\ninstall\n");
    expect(events[0]).toMatchObject({ command: "bun test a.test.ts", lane: "small" });
    expect(events[1]).toMatchObject({ phase: "acquired", waitMs: expect.any(Number) });
    expect(existsSync(wrapper)).toBe(false);
  } finally {
    for (const release of held) release();
  }
});

test("empty commands install no wrappers and pass no PATH override", async () => {
  const f = fixture();
  await withSlottedCommands(
    [],
    f.root,
    "unused scratch",
    1,
    () => {
      throw new Error("unexpected event");
    },
    async (path) => {
      expect(path).toBeUndefined();
    },
  );
  expect(existsSync(join(f.root, "config.json"))).toBe(false);
});

test.each(["development", "production"])(
  "wrapper startup preserves cwd and inherited env without loading repository configuration (%s)",
  async (mode) => {
    const f = fixture(),
      scratch = join(f.root, SCRATCH_NAME),
      cwd = join(f.root, "checkout with 'quotes'");
    mkdirSync(scratch);
    mkdirSync(cwd);
    writeFileSync(join(cwd, ".env"), "TEST_WRAPPER_ENV=dotenv\n");
    writeFileSync(join(cwd, ".env.local"), "TEST_WRAPPER_LOCAL=local\n");
    writeFileSync(join(cwd, `.env.${mode}`), "TEST_WRAPPER_MODE=mode\n");
    writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    writeFileSync(join(cwd, "preload.js"), 'process.env.TEST_WRAPPER_PRELOAD = "loaded";\n');
    const binary = `#!/bin/sh\nprintf "%s\\n" "$PWD" "$*" "\${TEST_WRAPPER_ENV-unset}" "\${TEST_WRAPPER_LOCAL-unset}" "\${TEST_WRAPPER_MODE-unset}" "\${TEST_WRAPPER_PRELOAD-unset}" "$TEST_INHERITED"\nexit 3\n`;
    writeFileSync(f.fake, binary, { mode: 0o755 });
    writeFileSync(join(f.real, "npm"), binary, { mode: 0o755 });
    await withSlottedCommands(
      [
        ["bun", "test"],
        ["npm", "test"],
      ],
      cwd,
      scratch,
      1,
      () => {},
      async (path) => {
        for (const argv of [
          ["bun", "install"],
          ["bun", "test"],
          ["npm", "test"],
        ]) {
          const result = await sh(argv, {
            cwd,
            env: { PATH: path ?? "", NODE_ENV: mode, TEST_INHERITED: "preserved" },
            allowFail: true,
          });
          expect(result.exitCode).toBe(3);
          expect(result.stdout).toBe(
            `${cwd}\n${argv.slice(1).join(" ")}\nunset\nunset\nunset\nunset\npreserved\n`,
          );
        }
      },
    );
  },
);

test("a leased full suite lets nested slotted commands reuse its slot", async () => {
  const f = fixture(),
    scratch = join(f.root, SCRATCH_NAME),
    old = gateSlots.limit;
  mkdirSync(scratch);
  writeFileSync(
    f.fake,
    '#!/bin/sh\nif [ "$TEST_INNER" = 1 ]; then printf "inner\\n" >> "$TEST_MARKER"; exit 3; fi\nprintf "outer\\n" >> "$TEST_MARKER"\nTEST_INNER=1 bun test inner.test.ts\n',
    { mode: 0o755 },
  );
  writeFileSync(join(f.root, "inner.test.ts"), "");
  gateSlots.setLimit(1);
  const requests = spyOn(gateSlots, "lease");
  const confirmations = spyOn(AgentTestSession.prototype, "request");
  try {
    await withSlottedCommands(
      f.config.commands,
      f.root,
      scratch,
      1,
      () => {},
      async (path) => {
        const result = await sh(["bun", "test"], {
          cwd: f.root,
          env: { PATH: path ?? "", TEST_MARKER: f.marker },
          allowFail: true,
          timeoutMs: 10000,
        });
        expect(result.exitCode).toBe(3);
        expect(readFileSync(f.marker, "utf8")).toBe("outer\ninner\n");
        expect(requests).toHaveBeenCalledTimes(1);
        expect(confirmations.mock.calls.filter(([body]) => body.reuse)).toHaveLength(1);
        expect(gateSlots.snapshot().occupied).toBe(0);
      },
    );
  } finally {
    requests.mockRestore();
    confirmations.mockRestore();
    gateSlots.setLimit(old);
  }
}, 15000);

test("an unresolvable caller directory falls back instead of throwing", () => {
  const f = fixture(),
    previous = { cwd: process.cwd(), pwd: process.env.PWD };
  cleanup.push(() => {
    process.chdir(previous.cwd);
    if (previous.pwd === undefined) delete process.env.PWD;
    else process.env.PWD = previous.pwd;
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanup.push(() => warn.mockRestore());
  process.env.PWD = f.real;
  enterCallerDirectory("");
  expect(process.cwd()).toBe(f.real);
  enterCallerDirectory(join(f.root, "deleted"));
  expect(process.cwd()).toBe(f.real);
  delete process.env.PWD;
  process.chdir(f.root);
  expect(() => enterCallerDirectory(join(f.root, "deleted"))).not.toThrow();
  expect(process.cwd()).toBe(f.root);
  expect(warn).toHaveBeenCalledTimes(1);
});

function fakeClock() {
  const time = waitClock();
  const clock = {
    now: time.now,
    sleep: (ms: number) => time.advance(ms),
    timeout: (fn: () => void, ms: number) => {
      const id = time.timer.set(fn, ms);
      return () => time.timer.clear(id);
    },
  };
  return { time, clock };
}

test.each([false, true])("healthy busy queue exits 75 without executing (lane busy=%s)", async (busy) => {
  const f = fixture(),
    { clock, time } = fakeClock();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  cleanup.push(() => warning.mockRestore());
  const requests: Record<string, unknown>[] = [];
  const start = clock.now();
  const code = await agentTestCommand(
    f.config,
    ["bun", "test"],
    async (body) => {
      requests.push(body);
      return busy
        ? { id: "", acquired: false, busy: true, holder: "other command" }
        : { id: "lease", acquired: false, ...(body.name ? { holder: "full suite" } : {}) };
    },
    { clock, maxWaitMs: 500 },
  );
  expect(code).toBe(75);
  expect(existsSync(f.marker)).toBe(false);
  expect(clock.now() - start).toBe(500);
  const stderr = warning.mock.calls.flat().join();
  expect(stderr).toMatch(/waited.*targeted/i);
  expect(stderr).toContain("gate lane");
  expect(stderr).toContain(busy ? "other command" : "full suite");
  if (busy) expect(requests.every((body) => !body.id)).toBe(true);
  else expect(requests.at(-1)).toMatchObject({ release: true });
  expect(time.pending).toBe(0);
});

test("a lane-busy reply is retried as admission and never renews another command's lease", async () => {
  const f = fixture(),
    { clock } = fakeClock();
  let creates = 0;
  const requests: Record<string, unknown>[] = [];
  expect(
    await agentTestCommand(
      f.config,
      ["bun", "test"],
      async (body) => {
        requests.push(body);
        if (body.name && ++creates === 1) return { id: "", acquired: false, busy: true };
        return { id: "own", acquired: !body.release };
      },
      { clock },
    ),
  ).toBe(3);
  expect(requests.filter((body) => body.name)).toHaveLength(2);
  expect(requests.at(-1)).toMatchObject({ id: "own", release: true });
});

test.each(["small-parent", "forged", "legacy-nonce", "gate-parent"])(
  "nested admission confirms the lease (%s)",
  async (scenario) => {
    const f = fixture();
    const previousId = process.env.LIMITLESS_AGENT_TEST_LEASE,
      previousNonce = process.env.LIMITLESS_AGENT_TEST_SLOT;
    cleanup.push(() => {
      if (previousId === undefined) delete process.env.LIMITLESS_AGENT_TEST_LEASE;
      else process.env.LIMITLESS_AGENT_TEST_LEASE = previousId;
      if (previousNonce === undefined) delete process.env.LIMITLESS_AGENT_TEST_SLOT;
      else process.env.LIMITLESS_AGENT_TEST_SLOT = previousNonce;
    });
    const targeted = scenario === "gate-parent";
    const file = join(f.root, "child.test.ts");
    writeFileSync(file, "");
    if (scenario === "legacy-nonce") {
      delete process.env.LIMITLESS_AGENT_TEST_LEASE;
      process.env.LIMITLESS_AGENT_TEST_SLOT = "test-nested";
    } else process.env.LIMITLESS_AGENT_TEST_LEASE = scenario;
    const requests: Record<string, unknown>[] = [];
    expect(
      await agentTestCommand(f.config, ["bun", "test", ...(targeted ? [file] : [])], async (body) => {
        requests.push(body);
        if (body.reuse) return { id: String(body.reuse), acquired: targeted, reused: targeted };
        return { id: "own", acquired: !body.release };
      }),
    ).toBe(3);
    expect(requests.filter((body) => body.reuse)).toHaveLength(scenario === "legacy-nonce" ? 0 : 1);
    expect(requests.filter((body) => body.name)).toHaveLength(targeted ? 0 : 1);
    if (!targeted) expect(requests.find((body) => body.name)).toMatchObject({ lane: "gate" });
    else expect(requests).toEqual([{ token: f.config.token, lane: "small", reuse: "gate-parent" }]);
  },
);

test("installed targeted parent takes a gate lease for its nested full suite", async () => {
  const f = fixture(),
    scratch = join(f.root, SCRATCH_NAME);
  mkdirSync(scratch);
  writeFileSync(join(f.root, "outer.test.ts"), "");
  writeFileSync(
    f.fake,
    '#!/bin/sh\nif [ "$TEST_INNER" = 1 ]; then printf "inner\\n" >> "$TEST_MARKER"; exit 3; fi\nTEST_INNER=1 bun test\n',
    { mode: 0o755 },
  );
  const gate = spyOn(gateSlots, "lease"),
    small = spyOn(agentTestSlots, "lease");
  cleanup.push(() => {
    gate.mockRestore();
    small.mockRestore();
  });
  await withSlottedCommands(
    f.config.commands,
    f.root,
    scratch,
    1,
    () => {},
    async (path) => {
      const result = await sh(["bun", "test", "outer.test.ts"], {
        cwd: f.root,
        env: { PATH: path ?? "", TEST_MARKER: f.marker },
        allowFail: true,
        timeoutMs: 10000,
      });
      expect(result.exitCode).toBe(3);
      expect(gate).toHaveBeenCalledTimes(1);
      expect(small).toHaveBeenCalledTimes(1);
      expect(readFileSync(f.marker, "utf8")).toBe("inner\n");
    },
  );
});

test("wrapper warns on a cap, never recovers it, and lets running work finish", async () => {
  const { time, clock } = fakeClock();
  const calls: Record<string, unknown>[] = [],
    warnings: string[] = [];
  const session = new AgentTestSession(() => {}, {
    now: time.now,
    timer: time.timer.set,
    clear: time.timer.clear,
    caps: { gate: 20_000, small: 20_000 },
  });
  cleanup.push(() => session.close());
  await withGateLease(
    "bun test",
    async () => {
      await time.advance(10_000);
      await time.advance(10_000);
      await time.advance(10_000);
      expect(warnings.join()).toMatch(/bun test.*20000ms duration cap/);
      expect(calls.some((body) => body.running)).toBe(false);
    },
    {
      clock,
      agentTest: { lane: "gate", onLease: () => {} },
      warn: (message) => warnings.push(message),
      client: async (body) => {
        calls.push(body);
        return session.request({ ...body, token: session.token, lane: "gate" });
      },
    },
  );
  expect(calls.filter((body) => body.name)).toHaveLength(1);
  expect(gateSlots.snapshot().occupied).toBe(0);
  expect(time.pending).toBe(0);
});

test("wrapper registers the capability before warnings and rejected-client stderr", async () => {
  const f = fixture();
  f.config.token = crypto.randomUUID();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanup.push(() => warn.mockRestore());
  expect(
    await agentTestCommand(f.config, ["bun", "test"], async () => {
      throw new Error(`offline ${f.config.token}`);
    }),
  ).toBe(3);
  expect(warn.mock.calls.flat().join()).not.toContain(f.config.token);
  expect(warn.mock.calls.flat().join()).toContain("[redacted]");
  const file = join(f.root, "config.json");
  writeFileSync(file, JSON.stringify(f.config));
  const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new LeaseRejected(`denied ${f.config.token}`));
  const error = spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => {
    fetcher.mockRestore();
    error.mockRestore();
  });
  expect(await wrapperMain([file, "bun", "test"])).toBe(1);
  expect(error.mock.calls.flat().join()).not.toContain(f.config.token);
  expect(error.mock.calls.flat().join()).toContain("[redacted]");
});

test("only failure of both transports permits the installed client's outage fallback", async () => {
  const f = fixture();
  const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanup.push(() => {
    fetcher.mockRestore();
    warn.mockRestore();
  });
  expect(await agentTestCommand(f.config, ["bun", "test"], wrapperLeaseClient(f.config))).toBe(3);
  expect(fetcher.mock.calls.map(([_url, init]) => (init && "unix" in init ? "unix" : "http"))).toEqual([
    "http",
    "unix",
  ]);
  expect(warn.mock.calls.flat().join()).toContain("unavailable");
  expect(existsSync(f.marker)).toBe(true);
});

test("a supported endpoint rejection never falls back, and socket failure rechecks HTTP", async () => {
  const f = fixture();
  const fetcher = spyOn(globalThis, "fetch");
  cleanup.push(() => fetcher.mockRestore());
  fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(
    wrapperLeaseClient(f.config)({ name: "bun test" }, new AbortController().signal),
  ).rejects.toThrow("HTTP 403");
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockClear();
  fetcher.mockRejectedValueOnce(new Error("HTTP offline"));
  fetcher.mockResolvedValueOnce(Response.json({ id: "socket", acquired: true }));
  fetcher.mockRejectedValueOnce(new Error("socket offline"));
  fetcher.mockResolvedValueOnce(Response.json({ id: "http", acquired: true }));
  const client = wrapperLeaseClient(f.config);
  expect((await client({ name: "bun test" }, new AbortController().signal)).id).toBe("socket");
  expect((await client({ name: "bun test" }, new AbortController().signal)).id).toBe("http");
  expect(fetcher.mock.calls.map(([_url, init]) => (init && "unix" in init ? "unix" : "http"))).toEqual([
    "http",
    "unix",
    "unix",
    "http",
  ]);
});

test("an HTTP transport timeout still tries the reachable invocation socket", async () => {
  const f = fixture(),
    { time, clock } = fakeClock();
  const fetcher = spyOn(globalThis, "fetch");
  cleanup.push(() => fetcher.mockRestore());
  fetcher.mockReturnValueOnce(new Promise(() => {}));
  fetcher.mockResolvedValueOnce(Response.json({ id: "socket", acquired: true }));
  const reply = wrapperLeaseClient(f.config, clock)({ name: "bun test" }, new AbortController().signal);
  await time.advance(1000);
  expect(await reply).toMatchObject({ id: "socket", acquired: true });
  expect(fetcher.mock.calls.map(([_url, init]) => (init && "unix" in init ? "unix" : "http"))).toEqual([
    "http",
    "unix",
  ]);
  expect(time.pending).toBe(0);
});
