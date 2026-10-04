import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DeployClock } from "../src/cli/deploy-wait.ts";
import { gateSlotCommand, type LeaseClient, localLeaseClient, withGateLease } from "../src/cli/gate-slot.ts";
import { Semaphore } from "../src/gates/slots.ts";
import { waitClock } from "./wait-clock.ts";

function rig(limit = 1) {
  const time = waitClock(),
    slots = new Semaphore(limit);
  const clock: DeployClock = {
    now: time.now,
    sleep: async (ms) => time.advance(ms),
    timeout: (fn, ms) => {
      const id = time.timer.set(fn, ms);
      return () => time.timer.clear(id);
    },
  };
  const calls: Record<string, unknown>[] = [];
  const client: LeaseClient = async (body) => {
    calls.push(body);
    const id =
      typeof body.id === "string"
        ? body.id
        : await slots.lease(String(body.name), body.immediate === true, time.timer.set, time.timer.clear);
    const acquired = slots.heartbeat(id, body.release === true);
    return { id, acquired: acquired ?? false, expired: acquired === undefined };
  };
  return { time, slots, clock, calls, client };
}
const signal = new AbortController().signal;

test("mixed internal and lease waiters share FIFO; queued time does not shorten lease lifetime", async () => {
  const f = rig();
  const first = await f.slots.acquire(signal, undefined, "run-a");
  const lease = await f.slots.lease("deploy", false, f.time.timer.set, f.time.timer.clear);
  const internal = f.slots.acquire(signal, undefined, "run-b");
  expect(f.slots.snapshot()).toEqual({ occupied: 1, limit: 1, holders: ["run-a"] });
  await f.time.advance(29_000);
  expect(f.slots.heartbeat(lease)).toBe(false);
  first();
  await f.time.flush();
  expect(f.slots.snapshot().holders).toEqual(["deploy"]);
  await f.time.advance(29_000);
  expect(f.slots.snapshot().holders).toEqual(["deploy"]);
  await f.time.advance(1000);
  const last = await internal;
  expect(f.slots.snapshot().holders).toEqual(["run-b"]);
  expect(f.slots.heartbeat(lease)).toBeUndefined();
  last();
  expect(f.time.pending).toBe(0);
});

test("renewal, idempotent release, queued cancellation and admission/cancel race conserve capacity", async () => {
  const f = rig();
  let id = await f.slots.lease("deploy", false, f.time.timer.set, f.time.timer.clear);
  await f.time.advance(20_000);
  expect(f.slots.heartbeat(id)).toBe(true);
  await f.time.advance(20_000);
  expect(f.slots.snapshot().occupied).toBe(1);
  f.slots.heartbeat(id, true);
  f.slots.heartbeat(id, true);
  expect(f.slots.heartbeat(id)).toBeUndefined();
  for (const race of [false, true]) {
    const release = await f.slots.acquire(signal);
    id = await f.slots.lease("queued", false, f.time.timer.set, f.time.timer.clear);
    if (race) release();
    f.slots.heartbeat(id, true);
    release();
    await f.time.flush();
    expect(f.slots.snapshot().occupied).toBe(0);
    (await f.slots.acquire(signal))();
  }
  const release = await f.slots.acquire(signal);
  id = await f.slots.lease("abandoned", false, f.time.timer.set, f.time.timer.clear);
  await f.time.advance(30_000);
  release();
  expect(f.slots.heartbeat(id)).toBeUndefined();
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("wrapper holds and heartbeats throughout work and releases on success and failure", async () => {
  for (const fails of [false, true]) {
    const f = rig();
    const operation = withGateLease(
      "deploy",
      async () => {
        for (let i = 0; i < 4; i++) {
          await f.time.advance(10_000);
          expect(f.slots.snapshot().holders).toEqual(["deploy"]);
        }
        if (fails) throw new Error("check failed");
        return 7;
      },
      f,
    );
    if (fails) await expect(operation).rejects.toThrow("check failed");
    else expect(await operation).toBe(7);
    expect(f.calls.filter((c) => c.id && !c.release).length).toBe(4);
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
});

test("deadline and zero budget cancel before executing once; default budget is 1800 seconds", async () => {
  for (const maxWaitMs of [0, 500, undefined]) {
    const f = rig();
    const release = await f.slots.acquire(signal);
    let executions = 0;
    const warnings: string[] = [];
    const start = f.clock.now();
    expect(
      await withGateLease("land", async () => ++executions, {
        ...f,
        maxWaitMs,
        warn: (s) => warnings.push(s),
      }),
    ).toBe(1);
    expect(executions).toBe(1);
    expect(f.clock.now() - start).toBe(maxWaitMs ?? 1_800_000);
    expect(warnings.join()).toContain("deadline");
    release();
    await f.time.flush();
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(f.time.pending).toBe(0);
  }
  const f = rig();
  await withGateLease(
    "immediate",
    async () => {
      expect(f.slots.snapshot().occupied).toBe(1);
    },
    { ...f, maxWaitMs: 0 },
  );
});

test("late acquisition responses are retired after bounded fallback", async () => {
  const f = rig();
  const late = Promise.withResolvers<Awaited<ReturnType<LeaseClient>>>();
  const warnings: string[] = [];
  let executions = 0;
  const work = withGateLease("late", async () => ++executions, {
    ...f,
    client: (body, signal) => (body.name ? late.promise : f.client(body, signal)),
    warn: (s) => warnings.push(s),
  });
  await f.time.advance(2000);
  expect(await work).toBe(1);
  const id = await f.slots.lease("late", false, f.time.timer.set, f.time.timer.clear);
  late.resolve({ id, acquired: true });
  await f.time.flush();
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(warnings.join()).toContain("timed out");
});

test("CLI preserves arguments, environment, cwd and statuses; rejects invalid options and spawn errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-slot-"));
  try {
    for (const code of [0, 7]) {
      const f = rig(),
        file = join(dir, "args");
      const args = ["space here", "$(false); 'quoted'", "--max-wait", "-h"];
      expect(
        await gateSlotCommand(
          [
            "--name",
            "test",
            "--",
            process.execPath,
            "-e",
            'require("fs").writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH })); process.exit(0)',
            file,
            ...args,
          ],
          async (body, signal) => {
            // Exit status is tested separately below without modifying the shared environment.
            return f.client(body, signal);
          },
        ),
      ).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        args,
        cwd: process.cwd(),
        path: process.env.PATH,
      });
      expect(await gateSlotCommand(["--", process.execPath, "-e", `process.exit(${code})`], f.client)).toBe(
        code,
      );
      expect(f.slots.snapshot().occupied).toBe(0);
    }
    for (const args of [
      [],
      ["--"],
      ["true"],
      ["--max-wait", "-1", "--", "true"],
      ["--max-wait", "1.5", "--", "true"],
      ["--bad", "--", "true"],
    ]) {
      const f = rig();
      await expect(gateSlotCommand(args, f.client)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
    const f = rig();
    await expect(gateSlotCommand(["--", join(dir, "missing")], f.client)).rejects.toThrow();
    expect(f.slots.snapshot().occupied).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreachable and unsupported daemons warn; authorization and validation failures never bypass", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = spyOn(globalThis, "fetch");
  try {
    fetcher.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await gateSlotCommand(["--", "true"], localLeaseClient())).toBe(0);
    expect(warn.mock.calls.flat().join()).toContain("ECONNREFUSED");
    for (const payload of [
      "not json",
      "null",
      "{}",
      '{"id":"","acquired":true}',
      '{"id":"lease","acquired":true,"expired":true}',
      '{"id":"lease","acquired":true,"expired":"false"}',
    ]) {
      fetcher.mockResolvedValue(new Response(payload));
      let ran = false;
      await expect(
        withGateLease("check", async () => {
          ran = true;
        }),
      ).rejects.toThrow("invalid gate-slot");
      expect(ran).toBe(false);
    }
    for (const status of [404, 405, 501, 400, 401, 403, 415, 500]) {
      fetcher.mockResolvedValue(new Response(null, { status }));
      let ran = 0;
      const work = withGateLease("check", async () => ++ran);
      if ([404, 405, 501].includes(status)) expect(await work).toBe(1);
      else {
        await expect(work).rejects.toThrow(`HTTP ${status}`);
        expect(ran).toBe(0);
      }
    }
  } finally {
    fetcher.mockRestore();
    warn.mockRestore();
  }
});

test("interruption forwards only to the wrapper's child and releases the lease", async () => {
  const f = rig();
  const started = Promise.withResolvers<void>();
  const file = join(mkdtempSync(join(tmpdir(), "gate-slot-signal-")), "ready");
  const poll = setInterval(() => {
    try {
      readFileSync(file);
      started.resolve();
    } catch {}
  }, 10);
  const before = process.listenerCount("SIGTERM");
  try {
    const work = gateSlotCommand(
      [
        "--",
        process.execPath,
        "-e",
        `const child = require("child_process").spawn(process.execPath, ["-e", process.argv[2], process.argv[1]], { stdio: "inherit" });
         process.on("SIGTERM", () => {});
         child.on("exit", () => process.exit(143));`,
        file,
        `const fs = require("fs"), file = process.argv[1];
         process.on("SIGTERM", () => { fs.writeFileSync(file, "terminated"); process.exit(0); });
         fs.writeFileSync(file, "ready"); setTimeout(() => process.exit(7), 3000);`,
      ],
      f.client,
    );
    await started.promise;
    process.emit("SIGTERM");
    expect(await work).toBe(143);
    expect(readFileSync(file, "utf8")).toBe("terminated");
    expect(f.slots.snapshot().occupied).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  } finally {
    clearInterval(poll);
    rmSync(dirname(file), { recursive: true, force: true });
  }
});

test("CLI command waits behind a pipeline holder and starts once admitted", async () => {
  const f = rig();
  const release = await f.slots.acquire(signal, undefined, "run-pipeline");
  const waiting = Promise.withResolvers<void>();
  const dir = mkdtempSync(join(tmpdir(), "gate-slot-command-"));
  const output = join(dir, "started");
  try {
    const work = gateSlotCommand(
      ["--", process.execPath, "-e", 'require("fs").writeFileSync(process.argv[1], "ran")', output],
      async (body, signal) => {
        const reply = await f.client(body, signal);
        if (!reply.acquired) waiting.resolve();
        return reply;
      },
    );
    await waiting.promise;
    expect(() => readFileSync(output)).toThrow();
    expect(f.slots.snapshot().holders).toEqual(["run-pipeline"]);
    release();
    expect(await work).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("ran");
    expect(f.slots.snapshot().occupied).toBe(0);
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coordination loss after startup warns without interrupting or restarting work", async () => {
  const f = rig();
  let runs = 0;
  const warnings: string[] = [];
  await withGateLease(
    "deploy",
    async () => {
      runs++;
      await f.time.advance(10_000);
      expect(warnings.join()).toContain("disconnected");
    },
    {
      ...f,
      warn: (s) => warnings.push(s),
      client: (body, signal) => {
        if (body.id && !body.release) throw new Error("disconnected");
        return f.client(body, signal);
      },
    },
  );
  expect(runs).toBe(1);
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("cancellation while waiting retires the reservation before rejecting", async () => {
  const f = rig(),
    controller = new AbortController();
  const release = await f.slots.acquire(signal);
  try {
    await expect(
      withGateLease(
        "cancelled",
        async () => {
          throw new Error("must not run");
        },
        {
          ...f,
          signal: controller.signal,
          client: async (body, signal) => {
            const reply = await f.client(body, signal);
            if (body.name) controller.abort(new Error("interrupted while waiting"));
            return reply;
          },
        },
      ),
    ).rejects.toThrow("interrupted while waiting");
  } finally {
    release();
  }
  expect(f.slots.snapshot().occupied).toBe(0);
  expect(f.time.pending).toBe(0);
});

test("main dispatches gate-slot and warns on an injected connection refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-slot-main-"));
  try {
    const preload = join(dir, "offline.ts");
    await Bun.write(preload, 'globalThis.fetch = async () => { throw new Error("ECONNREFUSED-test"); };');
    const child = Bun.spawn(
      [process.execPath, "--preload", preload, "src/cli/main.ts", "gate-slot", "--", "true"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toContain("warning: gate-slot");
    const streams = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(process.cwd(), "src/cli/main.ts"),
        "gate-slot",
        "--",
        process.execPath,
        "-e",
        'process.stdout.write(require("fs").readFileSync(0)); process.stderr.write("child-stderr"); process.exit(7)',
      ],
      { cwd: dir, stdin: new Blob(["literal stdin $()"]), stdout: "pipe", stderr: "pipe" },
    );
    expect(await streams.exited).toBe(7);
    expect(await new Response(streams.stdout).text()).toBe("literal stdin $()");
    expect(await new Response(streams.stderr).text()).toContain("child-stderr");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
