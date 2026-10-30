import { afterEach, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Store } from "../src/db/store.ts";
import {
  ClaimControlError,
  ClaimLostError,
  ClaimWaitError,
  rethrowClaimControl,
  selectClaimControl,
} from "../src/integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope, type ScopedClaim } from "../src/integrations/claim-guard.ts";
import { type ClaimRecord, createClaimClient } from "../src/integrations/claim-ref.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { createLeaseManager, type LeaseHandle } from "../src/integrations/leases.ts";
import { GitHub } from "./claim-github-fake.ts";

const handle: LeaseHandle = {
  repo: "owner/project",
  ref: "refs/limitless/claims/12",
  run: "run-a",
  member: "m-0123456789abcdef",
  generation: 1,
};
const record: ClaimRecord = {
  kind: "issue",
  number: 12,
  run: handle.run,
  holder: handle.member,
  generation: 1,
  state: "held",
  status: "running",
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
class CustomControl extends ClaimControlError {
  constructor() {
    super("Custom control");
  }
}
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error");
}
function wait(fn: () => unknown, reason: ClaimWaitError["reason"]) {
  const error = caught(fn);
  expect(error).toBeInstanceOf(ClaimWaitError);
  expect(error).toMatchObject({ reason });
  expect((error as Error).message).not.toContain("probe detail");
}
function stub(windowOpen: () => unknown = () => true, cancelled: () => unknown = () => false) {
  return bindClaim({ windowOpen: windowOpen as () => boolean }, handle, cancelled as () => boolean);
}
function guard(claims: readonly ScopedClaim[]) {
  return () => claimScope.run(claims, claimGuard);
}
async function managerFixture() {
  const gh = new GitHub();
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  let inclusive = 1_000;
  let exclusive = 1_000;
  const clock = { sample: () => ({ inclusive, exclusive }) };
  const manager = await createLeaseManager({
    client: createClaimClient({ gh: gh.gh, sample: clock.sample }),
    store,
    clock,
    gh: async () => `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`,
    member: handle.member,
  });
  return {
    manager,
    store,
    clock,
    advance(ms: number, suspend = false) {
      inclusive += ms;
      if (!suspend) exclusive += ms;
    },
    acquire: () => manager.acquire(handle.repo, handle.ref, record, { takeover: false }),
  };
}

test("control errors have fixed diagnostics and rethrow only instances by identity", async () => {
  const source = await Bun.file(new URL("../src/integrations/claim-errors.ts", import.meta.url)).text();
  expect(source).not.toMatch(/^\s*import\b/m);
  for (const reason of ["cancelled", "lease", "unavailable"] as const) {
    expect(new ClaimWaitError(reason)).toMatchObject({ name: "ClaimWaitError", reason });
    expect(new ClaimWaitError(reason).message).toBe(`Claim wait: ${reason}`);
  }
  expect(new ClaimLostError().name).toBe("ClaimLostError");
  expect(new ClaimLostError().message).toBe("Claim lost");
  for (const error of [new ClaimWaitError("lease"), new ClaimLostError(), new CustomControl()]) {
    expect(error).not.toHaveProperty("cause");
    expect(() => rethrowClaimControl(error)).toThrow();
    expect(caught(() => rethrowClaimControl(error))).toBe(error);
  }
  for (const value of [
    new Error("Claim lost"),
    { name: "ClaimLostError" },
    Object.assign(new Error("Claim lost"), { name: "ClaimLostError" }),
    new Error("wrapped", { cause: new ClaimLostError() }),
    null,
  ])
    expect(() => rethrowClaimControl(value)).not.toThrow();
});

test("publication requires live manager authority for the captured identity", async () => {
  const f = await managerFixture();
  const publish = mock(() => {});
  const send = (h = handle) =>
    claimScope.run([bindClaim(f.manager, h, () => false)], () => {
      claimGuard();
      publish();
    });
  wait(() => send(), "lease");
  // A pending acquisition grants no authority.
  f.store.beginLeaseIntent(handle.repo, handle.ref, handle.run, {
    op: "acquire",
    before: "0".repeat(40),
    record,
    commit: null,
  });
  wait(() => send(), "lease");
  expect(publish).not.toHaveBeenCalled();
  expect((await f.acquire()).kind).toBe("held");
  send();
  expect(publish).toHaveBeenCalledTimes(1);
  for (const h of [
    { ...handle, run: "other-run" },
    { ...handle, member: "m-fedcba9876543210" },
    { ...handle, generation: 2 },
    { ...handle, ref: "refs/limitless/claims/13" },
  ])
    wait(() => send(h), "lease");
  const claim = bindClaim(f.manager, handle, () => false);
  f.store.markLeaseLost(handle.repo, handle.ref);
  expect(claim.lost).toBe(false);
  wait(guard([claim]), "lease");
  expect(publish).toHaveBeenCalledTimes(1);
});

test("release without notification blocks the original binding", async () => {
  const f = await managerFixture();
  await f.acquire();
  const claim = bindClaim(f.manager, handle, () => false);
  guard([claim])();
  expect(await f.manager.release(handle)).toBe("released");
  expect(claim.lost).toBe(false);
  wait(guard([claim]), "lease");
});

test("live cancellation after an await blocks the next publication", async () => {
  const f = await managerFixture();
  await f.acquire();
  let cancelled = false;
  const claim = bindClaim(f.manager, handle, () => cancelled);
  const ready = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const publish = mock(() => {});
  const work = claimScope.run([claim], async () => {
    claimGuard();
    ready.resolve();
    await resume.promise;
    wait(() => {
      claimGuard();
      publish();
    }, "cancelled");
  });
  await ready.promise;
  cancelled = true;
  resume.resolve();
  await work;
  expect(publish).not.toHaveBeenCalled();
});

test("all claims and additive nested scopes remain live", () => {
  let open = true;
  const first = stub();
  const second = stub(() => open);
  const claims = [first, second];
  claimScope.run(claims, () => {
    claimGuard();
    claims.pop(); // The scope owns a snapshot.
    open = false;
    wait(claimGuard, "lease");
    wait(() => claimScope.run([], claimGuard), "lease");
    wait(() => claimScope.run([stub()], claimGuard), "lease");
  });
  claimGuard();
});

test("async scopes isolate interleaved branches and retain delayed descendants", async () => {
  const resume = Promise.withResolvers<void>();
  const closedReady = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<void>();
  const open = claimScope.run([stub()], async () => {
    await closedReady.promise;
    claimGuard();
    resume.resolve();
  });
  const closed = claimScope.run([stub(() => false)], async () => {
    closedReady.resolve();
    await resume.promise;
    wait(claimGuard, "lease");
    setTimeout(() => {
      try {
        wait(claimGuard, "lease");
        delayed.resolve();
      } catch (error) {
        delayed.reject(error);
      }
    }, 0);
  });
  await Promise.all([open, closed]);
  claimGuard();
  await delayed.promise;
});

test("scope return, throw, rejection and native exit restore only the claim context", async () => {
  const sentinel = new AsyncLocalStorage<string>();
  const probe = mock(() => {
    throw new Error("probe detail");
  });
  const claim = stub(probe, probe);
  const value = {};
  expect(claimScope.run([], () => value)).toBe(value);
  const failure = new Error("callback");
  expect(
    caught(() =>
      claimScope.run([claim], () => {
        throw failure;
      }),
    ),
  ).toBe(failure);
  const rejected = Promise.reject(failure);
  expect(claimScope.run([claim], () => rejected)).toBe(rejected);
  await expect(rejected).rejects.toBe(failure);
  claimGuard();
  expect(probe).not.toHaveBeenCalled();
  await sentinel.run("sentinel", () =>
    claimScope.run([stub(() => false)], async () => {
      expect(claimScope.run([], () => 17)).toBe(17);
      expect(
        caught(() =>
          claimScope.run([stub()], () => {
            throw failure;
          }),
        ),
      ).toBe(failure);
      await expect(
        claimScope.run([], async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      wait(claimGuard, "lease");
      await claimScope.exit(async () => {
        claimGuard();
        expect(sentinel.getStore()).toBe("sentinel");
        await Promise.resolve();
        claimGuard();
        expect(sentinel.getStore()).toBe("sentinel");
      });
      expect(
        caught(() =>
          claimScope.exit(() => {
            throw failure;
          }),
        ),
      ).toBe(failure);
      wait(claimGuard, "lease");
    }),
  );
  claimScope.run([], claimGuard);
});

test("bindings freeze a copy and loss matches every identity field permanently", () => {
  const original = { ...handle };
  const seen = mock(() => true);
  const claim = bindClaim({ windowOpen: seen }, original, () => false);
  original.generation = 99;
  expect(Object.isFrozen(claim)).toBe(true);
  expect(Object.isFrozen(claim.handle)).toBe(true);
  expect(claim.handle).toEqual(handle);
  expect(claim.handle).not.toBe(original);
  guard([claim])();
  expect(seen).toHaveBeenCalledWith(claim.handle);
  for (const h of [
    { ...handle, repo: "owner/other" },
    { ...handle, ref: "other-ref" },
    { ...handle, run: "other-run" },
    { ...handle, member: "other-member" },
    { ...handle, generation: 2 },
  ]) {
    expect(() => claim.onLost(h, null)).not.toThrow();
    expect(claim.lost).toBe(false);
  }
  expect(() => claim.onLost({ ...handle, repo: "OWNER/PROJECT" }, null)).not.toThrow();
  expect(claim.lost).toBe(true);
  claim.onLost(handle, null);
  claim.onLost({ ...handle, generation: 2 }, null);
  expect(caught(guard([claim]))).toBeInstanceOf(ClaimLostError);
  const successor = bindClaim({ windowOpen: () => true }, { ...handle, generation: 2 }, () => false);
  successor.onLost(handle, null);
  guard([successor])();
  expect(caught(guard([claim]))).toBeInstanceOf(ClaimLostError);
});

const throwing = () => {
  throw new Error("probe detail");
};
test.each([() => true, throwing, () => "invalid", () => false])(
  "a later loss beats cancellation and window probes (%#)",
  (cancelled) => {
    const probe = mock(cancelled);
    const lost = stub();
    lost.onLost(handle, null);
    expect(caught(guard([stub(throwing, probe), lost]))).toBeInstanceOf(ClaimLostError);
    expect(probe).not.toHaveBeenCalled();
  },
);

test.each([false, true])("probe precedence is independent of order (reverse: %s)", (reverse) => {
  const ordered = (...claims: ScopedClaim[]) => (reverse ? claims.reverse() : claims);
  for (const failure of [throwing, () => undefined, () => 0, () => "false"]) {
    const window = mock(() => true);
    wait(
      guard(
        ordered(
          stub(window, () => true),
          stub(window, failure),
        ),
      ),
      "cancelled",
    );
    expect(window).not.toHaveBeenCalled();
    wait(guard(ordered(stub(window), stub(window, failure))), "unavailable");
    expect(window).not.toHaveBeenCalled();
    wait(
      guard(
        ordered(
          stub(() => false),
          stub(failure),
        ),
      ),
      "unavailable",
    );
  }
  for (const stage of ["cancelled", "window"] as const) {
    for (const error of [new CustomControl(), new ClaimWaitError("lease"), new ClaimLostError()]) {
      const control = () => {
        throw error;
      };
      const claims =
        stage === "cancelled"
          ? ordered(
              stub(
                () => true,
                () => true,
              ),
              stub(() => true, throwing),
              stub(() => true, control),
            )
          : ordered(
              stub(() => false),
              stub(throwing),
              stub(control),
            );
      expect(caught(guard(claims))).toBe(error);
    }
  }
});

test.each(["age", "suspend", "throw"] as const)("manager clock boundary: %s", async (mode) => {
  const f = await managerFixture();
  await f.acquire();
  const claim = bindClaim(f.manager, handle, () => false);
  guard([claim])();
  if (mode === "age") {
    f.advance(419_999);
    guard([claim])();
    f.advance(1);
    wait(guard([claim]), "lease");
  } else if (mode === "suspend") {
    f.advance(1_000, true);
    guard([claim])();
    f.advance(1, true);
    wait(guard([claim]), "lease");
  } else {
    f.clock.sample = throwing;
    wait(guard([claim]), "unavailable");
  }
});

test("client IO clears scope through awaits and ambiguous-result readback", async () => {
  const gh = new GitHub();
  const sentinel = new AsyncLocalStorage<string>();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let calls = 0;
  const runner: GhRunner = async (...args) => {
    claimGuard();
    expect(sentinel.getStore()).toBe("sentinel");
    calls++;
    if (calls === 1) {
      entered.resolve();
      await resume.promise;
    } else await Promise.resolve();
    claimGuard();
    expect(sentinel.getStore()).toBe("sentinel");
    return (await gh.gh(...args)) ?? "";
  };
  gh.fault = (request) => {
    if (request.step === "update") {
      gh.apply(request);
      throw new Error("Ambiguous response");
    }
  };
  const client = createClaimClient({ gh: runner, sample: () => ({ inclusive: 1, exclusive: 1 }) });
  const work = sentinel.run("sentinel", () =>
    claimScope.run([stub(() => false)], async () => {
      expect(await client.read(handle.repo, handle.ref)).toEqual({ kind: "absent" });
      const result = await client.write(handle.repo, handle.ref, null, record);
      expect(result.kind).toBe("applied");
      expect(await client.read(handle.repo, handle.ref)).toMatchObject({ kind: "tip" });
      wait(claimGuard, "lease");
    }),
  );
  await entered.promise;
  resume.resolve();
  await work;
  expect(calls).toBe(8);
  expect(gh.requests.map((r) => r.step)).toEqual([
    "ref",
    "tree",
    "repository",
    "commit",
    "update",
    "ref",
    "commitRead",
    "ref",
  ]);
});

test("source boundaries permit guarded control IO without production claim bindings", async () => {
  const allowed = new Set(["src/integrations/claim-ref.ts", "src/integrations/leases.ts"]);
  const references: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.ts").scan({
    cwd: new URL("..", import.meta.url).pathname,
  })) {
    const source = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
    if (path === "src/integrations/claim-guard.ts") {
      const imports = source.split("\n").filter((line) => /^import (?!type\b)/.test(line));
      expect(imports).toEqual([
        'import { AsyncLocalStorage } from "node:async_hooks";',
        'import { ClaimLostError, ClaimWaitError, rethrowClaimControl } from "./claim-errors.ts";',
      ]);
      continue;
    }
    expect(source).not.toMatch(/\bbindClaim\b|claimScope\.run\b/);
    if (/\bclaimGuard\b/.test(source))
      expect([
        "src/integrations/control-ref.ts",
        "src/integrations/github-identity.ts",
        "src/git/repos.ts",
        "src/pipeline/context.ts",
      ]).toContain(path);
    if (/\bclaimScope\b/.test(source)) {
      expect(allowed.has(path)).toBe(true);
      expect(source.replace(/import .*claimScope.*\n/, "").replaceAll("claimScope.exit", "")).not.toMatch(
        /\bclaimScope\b/,
      );
      references.push(path);
    }
  }
  expect(references.sort()).toEqual([...allowed].sort());
});

test("claim rejection selection preserves identity, priority and input-order ties", () => {
  const ordinary = new Error("ordinary");
  const wait = new ClaimWaitError("lease");
  const loss = new ClaimLostError();
  for (const pair of [
    [ordinary, wait],
    [ordinary, loss],
    [wait, loss],
  ]) {
    const selected = pair.includes(loss) ? loss : wait;
    expect(selectClaimControl(pair)).toBe(selected);
    expect(selectClaimControl([...pair].reverse())).toBe(selected);
  }
  expect(selectClaimControl([ordinary, null, undefined])).toBeUndefined();
  expect(selectClaimControl([wait, new ClaimWaitError("cancelled")])).toBe(wait);
  expect(selectClaimControl([loss, new ClaimLostError()])).toBe(loss);
});
