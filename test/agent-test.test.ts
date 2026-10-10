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
} from "../src/cli/agent-test.ts";
import { type LeaseClient, LeaseRejected } from "../src/cli/gate-slot.ts";
import { AgentTestSession, agentTestLease, type TestWait } from "../src/gates/agent-tests.ts";
import { agentTestSlots, gateSlots } from "../src/gates/slots.ts";
import { SCRATCH_NAME } from "../src/harness/scratch.ts";
import { withSlottedCommands } from "../src/harness/slotted.ts";
import { readSlottedCommands } from "../src/harness/slotted-config.ts";
import { sh } from "../src/util/proc.ts";

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
    nested: "test-nested",
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
  [["test/x.test.ts"], "small"],
  [["--coverage"], "gate"],
  [["--timeout", "1000"], "gate"],
  [["--preload", "setup.ts"], "gate"],
  [["--timeout=1000", "test/x.test.ts"], "small"],
  [["-t", "some test"], "small"],
  [["--test-name-pattern=x"], "small"],
  [["--", "a.test.ts"], "small"],
] as const)("lane classification: %j => %s", (extra, lane) => {
  expect(testLane(["bun", "test", ...extra], ["bun", "test"])).toBe(lane);
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
    '#!/bin/sh\nif [ "$TEST_INNER" = 1 ]; then printf "inner\\n" >> "$TEST_MARKER"; exit 3; fi\nprintf "outer\\n" >> "$TEST_MARKER"\nTEST_INNER=1 bun test\n',
    { mode: 0o755 },
  );
  gateSlots.setLimit(1);
  const requests = spyOn(gateSlots, "lease");
  try {
    await withSlottedCommands(
      f.config.commands,
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
        expect(gateSlots.snapshot().occupied).toBe(0);
      },
    );
  } finally {
    requests.mockRestore();
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
