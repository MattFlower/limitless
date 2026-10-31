import { afterEach, expect, spyOn, test } from "bun:test";
import * as subprocess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { cacheGit, worktreeGit, worktreeGitScope } from "../src/git/command.ts";
import * as hardening from "../src/git/hardening.ts";
import { githubRetry, pushBranch, remoteBranchSha } from "../src/git/repos.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimScope } from "../src/integrations/claim-guard.ts";
import { runGh } from "../src/integrations/github.ts";
import * as identity from "../src/integrations/github-identity.ts";
import type { LeaseHandle } from "../src/integrations/leases.ts";
import {
  CommandError,
  processBootInspection,
  processRecoveryInspection,
  processScope,
  runProcess,
  sh,
} from "../src/util/proc.ts";

const handle: LeaseHandle = {
  repo: "owner/project",
  ref: "refs/limitless/claims/1",
  run: "r",
  member: "m",
  generation: 1,
};
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function authority() {
  let closed = false;
  const error = new ClaimWaitError("lease");
  const claim = bindClaim(
    {
      windowOpen: () => {
        if (closed) throw error;
        return true;
      },
    },
    handle,
    () => false,
  );
  return {
    claim,
    error,
    close: () => {
      closed = true;
    },
  };
}
function noSpawn() {
  const spawn = spyOn(subprocess, "spawn").mockImplementation(() => {
    throw new Error("unexpected spawn");
  });
  restores.push(() => spawn.mockRestore());
  return spawn;
}

for (const app of [false, true])
  for (const allowFail of [false, true]) {
    test(`github identity await carries final authorization (app=${app}, allowFail=${allowFail})`, async () => {
      const pending = Promise.withResolvers<identity.GitHubIdentity>();
      const resolver = spyOn(identity, "githubIdentity").mockImplementation(() => pending.promise);
      restores.push(() => resolver.mockRestore());
      const spawn = noSpawn();
      const a = authority();
      const outcome = claimScope
        .run([a.claim], () =>
          identity.githubSh(["gh", "api", "repos/owner/project"], { cwd: process.cwd(), allowFail }),
        )
        .catch((e) => e);
      a.close();
      pending.resolve(app ? { kind: "app", token: "test-token", botLogin: "test[bot]" } : { kind: "owner" });
      expect(await outcome).toBe(a.error);
      expect(spawn).not.toHaveBeenCalled();
    });
  }

test("runGh forwards an explicit observer guard through inner identity resolution without a scope", async () => {
  const pending = Promise.withResolvers<identity.GitHubIdentity>();
  const resolver = spyOn(identity, "githubIdentity").mockImplementation(() => pending.promise);
  restores.push(() => resolver.mockRestore());
  const spawn = noSpawn();
  const error = new Error("observer suppressed");
  let closed = false;
  const outcome = runGh(["api", "repos/owner/project"], undefined, undefined, undefined, () => {
    if (closed) throw error;
  }).catch((e) => e);
  closed = true;
  pending.resolve({ kind: "owner" });
  expect(await outcome).toBe(error);
  expect(spawn).not.toHaveBeenCalled();
});

async function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "claim-dispatch-"));
  restores.push(() => rmSync(cwd, { recursive: true, force: true }));
  await sh(["git", "init", "-qb", "main"], { cwd });
  writeFileSync(join(cwd, "file"), "base\n");
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-qm", "base"], { cwd });
  return {
    cwd,
    repo: {
      id: "r",
      slug: handle.repo,
      kind: "github" as const,
      url: "https://example.com/owner/project.git",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr" as const,
      createdAt: 0,
    },
  };
}

test.each(["ls-remote", "push"])(
  "remote %s rechecks claims after real cacheGit preparation",
  async (command) => {
    const { cwd, repo } = await repository();
    const a = authority();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const harden = hardening.harden;
    const preparation = spyOn(hardening, "harden").mockImplementation(async (...args) => {
      const result = await harden(...args);
      // Only transport repositories have this name; local Git remains unselected.
      if (args[1].cwd.includes("transport")) {
        entered.resolve();
        await resume.promise;
      }
      return result;
    });
    restores.push(() => preparation.mockRestore());
    const spawnReal = subprocess.spawn;
    const spawn = spyOn(subprocess, "spawn").mockImplementation(((
      bin: string,
      args: readonly string[],
      opts: subprocess.SpawnOptions,
    ) => {
      if (args.includes(command)) throw new Error("unexpected transport");
      return spawnReal(bin, args, opts);
    }) as typeof subprocess.spawn);
    restores.push(() => spawn.mockRestore());
    const work = claimScope
      .run([a.claim], () =>
        command === "push" ? pushBranch(repo, cwd, "new") : remoteBranchSha(repo, cwd, "main"),
      )
      .catch((e) => e);
    await entered.promise;
    a.close();
    resume.resolve();
    expect(await work).toBe(a.error);
    expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes(command))).toHaveLength(
      0,
    );
  },
);

test("remote retry checks authority after the injected retry pause", async () => {
  const { cwd, repo } = await repository();
  const a = authority();
  const spawnReal = subprocess.spawn;
  let transports = 0;
  const spawn = spyOn(subprocess, "spawn").mockImplementation(((
    bin: string,
    args: readonly string[],
    opts: subprocess.SpawnOptions,
  ) => {
    if (args.includes("ls-remote")) {
      transports++;
      throw new CommandError("transient", 1, "", "HTTP 502", false);
    }
    return spawnReal(bin, args, opts);
  }) as typeof subprocess.spawn);
  const setTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
    if (ms === githubRetry.baseDelayMs) {
      a.close();
      queueMicrotask(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return setTimer(callback, ms);
  }) as typeof setTimeout);
  restores.push(
    () => spawn.mockRestore(),
    () => timer.mockRestore(),
  );
  expect(await claimScope.run([a.claim], () => remoteBranchSha(repo, cwd, "main")).catch((e) => e)).toBe(
    a.error,
  );
  expect(transports).toBe(1);
});

test.each(["loss", "cancelled", "unguarded"])(
  "final dispatch follows recorded recovery: %s",
  async (kind) => {
    const store = new Store(":memory:");
    restores.push(() => store.close());
    store.recordProcessDiscovery({
      runId: "r",
      invocation: "prior",
      directory: process.cwd(),
      boot: "test",
      createdAt: 0,
      discovery: { group: 0, started: 0, directories: [], leader: null, spawnedAt: "0" },
    });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<number[]>();
    const error = kind === "loss" ? new ClaimLostError() : new ClaimWaitError("cancelled");
    let closed = false;
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    restores.push(() => sleep.mockRestore());
    const spawn = spyOn(subprocess, "spawn");
    restores.push(() => spawn.mockRestore());
    const work = processBootInspection.run(
      () => "test",
      () =>
        processRecoveryInspection.run(
          {
            stopped: () => true,
            timeoutMs: 10_000,
            discover: async () => {
              entered.resolve();
              return resume.promise;
            },
          },
          () =>
            processScope.run(
              {
                signal: new AbortController().signal,
                killGraceMs: 10,
                children: new Map(),
                scratchDirs: new Set(),
                runId: "r",
                cleanups: store,
              },
              () =>
                runProcess({
                  cmd: ["/bin/echo", "ok"],
                  cwd: process.cwd(),
                  env: process.env as Record<string, string>,
                  dispatchGuard:
                    kind === "unguarded"
                      ? undefined
                      : () => {
                          if (closed) throw error;
                        },
                }),
            ),
        ),
    );
    const outcome = work.catch((e) => e);
    await entered.promise;
    closed = true;
    resume.resolve([]);
    if (kind === "unguarded") {
      expect(await outcome).toMatchObject({ exitCode: 0, stdout: "ok\n" });
      expect(spawn).toHaveBeenCalledTimes(1);
    } else {
      expect(await outcome).toBe(error);
      expect(spawn).not.toHaveBeenCalled();
    }
  },
);

test("a synchronous dispatch refusal is a rejected runProcess promise", async () => {
  const spawn = noSpawn();
  const error = new ClaimLostError();
  let work: Promise<unknown> | undefined;
  expect(() => {
    work = runProcess({
      cmd: ["unused"],
      cwd: process.cwd(),
      env: {},
      dispatchGuard: () => {
        throw error;
      },
    });
  }).not.toThrow();
  expect(await work?.catch((e) => e)).toBe(error);
  expect(spawn).not.toHaveBeenCalled();
});

test.each(["caller", "transport"])(
  "cacheGit composes the existing dispatch guard with its selected callback: %s",
  async (refusing) => {
    const spawn = noSpawn();
    const error = new Error("guard refused");
    let caller = 0;
    let transport = 0;
    const work = worktreeGitScope
      .run(false, () =>
        cacheGit(
          ["git", "--version"],
          {
            cwd: process.cwd(),
            dispatchGuard: () => {
              caller++;
              if (refusing === "caller") throw error;
            },
          },
          () => {
            transport++;
            if (refusing === "transport") throw error;
          },
        ),
      )
      .catch((e) => e);
    expect(await work).toBe(error);
    expect(caller).toBe(1);
    expect(transport).toBe(refusing === "caller" ? 0 : 1);
    expect(spawn).not.toHaveBeenCalled();
  },
);

test("unselected local commands stay unguarded even inside a closed claim scope", async () => {
  const a = authority();
  a.close();
  await claimScope.run([a.claim], async () => {
    expect((await sh(["/bin/echo", "local"], { cwd: process.cwd() })).stdout).toBe("local\n");
    expect(
      (await worktreeGitScope.run(false, () => worktreeGit(["git", "--version"], { cwd: process.cwd() })))
        .stdout,
    ).toStartWith("git version");
  });
});

test.each(["window", "loss"])(
  "github final dispatch refuses a bound claim after %s closes without signal abortion",
  async (kind) => {
    const pending = Promise.withResolvers<identity.GitHubIdentity>();
    const resolver = spyOn(identity, "githubIdentity").mockImplementation(() => pending.promise);
    restores.push(() => resolver.mockRestore());
    const spawn = noSpawn();
    let open = true;
    const claim = bindClaim({ windowOpen: () => open }, handle, () => false);
    const controller = new AbortController();
    const work = claimScope
      .run([claim], () =>
        identity.githubSh(["gh", "api", "repos/owner/project"], {
          cwd: process.cwd(),
          signal: controller.signal,
          allowFail: true,
        }),
      )
      .catch((e) => e);
    if (kind === "loss") claim.onLost(handle, null);
    else open = false;
    pending.resolve({ kind: "owner" });
    expect(await work).toBeInstanceOf(kind === "loss" ? ClaimLostError : ClaimWaitError);
    expect(controller.signal.aborted).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  },
);
