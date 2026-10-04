import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { installationUnits } from "../src/cli/service.ts";

test("installation selects only explicitly requested rollback and tunnel agents", () => {
  for (const mtplx of [undefined, false, true])
    for (const tunnel of [null, "/tunnel.yml"]) {
      const units = installationUnits({ mtplx }, tunnel);
      expect(units.map(([label]) => label)).toEqual([
        "dev.limitless.daemon",
        ...(mtplx ? ["dev.limitless.mtplx"] : []),
        ...(tunnel ? ["dev.limitless.tunnel"] : []),
      ]);
      for (const [label, content] of units) {
        expect(content).toContain(`<key>Label</key><string>${label}</string>`);
        expect(content).toContain(`<key>LimitlessService</key><string>${label.split(".").at(-1)}</string>`);
        expect(content).toContain(
          `<key>StandardOutPath</key><string>${join(homedir(), ".limitless", "logs", `${label}.log`)}</string>`,
        );
        expect(content).toContain(
          `<key>StandardErrorPath</key><string>${join(homedir(), ".limitless", "logs", `${label}.log`)}</string>`,
        );
      }
      expect(units[0]?.[1]).toContain("serve");
      if (mtplx) expect(units[1]?.[1]).toContain("mtplx-local");
    }
});

test("service CLI dispatches opt-in mtplx and advertises the new flag", async () => {
  // A temporary config, never the user's: --tunnel reads [server] public_url from it.
  const configDir = mkdtempSync(join(tmpdir(), "limitless-service-cli-"));
  writeFileSync(join(configDir, "config.toml"), '[server]\npublic_url = "https://hooks.example.test"\n');
  const env = { ...process.env, LIMITLESS_CONFIG_DIR: configDir, LIMITLESS_HOME: join(configDir, "home") };
  for (const flags of [[], ["--mtplx", "--tunnel"], ["--help"]]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        "./test/fixtures/service-cli-preload.ts",
        "src/cli/main.ts",
        "service",
        "install",
        ...flags,
      ],
      { stdout: "pipe", stderr: "pipe", env },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    if (flags.includes("--help")) {
      expect(output).toContain("[--mtplx]");
      expect(output).not.toContain("--no-mtplx");
    } else {
      const on = flags.length > 0;
      const publicUrl = on ? "https://hooks.example.test" : null;
      expect(output).toContain(JSON.stringify({ tunnel: on, mtplx: on, publicUrl }));
    }
  }
  rmSync(configDir, { recursive: true, force: true });
});

const migrationDirs: string[] = [];
afterEach(() => {
  for (const dir of migrationDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type MigrationResult = {
  error: string;
  backupBeforeStop: boolean;
  contenderError: string;
  contenderCalls: string[];
  lockHeld: boolean;
  recoveryCleaned: boolean;
  backup: string | null;
  state: boolean;
  lock: boolean;
  calls: string[];
  loaded: string[];
  draining: boolean;
  old: string;
  time: number;
  files: Record<string, string>;
  unrelated: string;
};
async function migration(
  scenario: string,
  kind = "daemon",
  dir = mkdtempSync(join(tmpdir(), "limitless-service-migration-")),
) {
  migrationDirs.push(dir);
  const child = Bun.spawn([process.execPath, "test/service-migration-support.ts", scenario, kind], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SERVICE_TEST_HOME: dir },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return { result: JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as MigrationResult, stdout };
}

test("migration drains current work, waits for unload, then replaces and checks health", async () => {
  const { result: r } = await migration("migration");
  expect(r.error).toBe("");
  expect(r.calls).toEqual([
    "drain",
    "health draining",
    "active stage",
    "health draining",
    "bootout arbitrary.installed.daemon",
    "bootstrap dev.limitless.daemon",
    "health fresh",
  ]);
  expect(r.time).toBe(5500);
  expect(r.loaded).toEqual(["other.program", "dev.limitless.daemon"]);
  expect(r.files["original.plist"]).toBeUndefined();
  expect(r.files["dev.limitless.daemon.plist"]).toContain(
    "<key>LimitlessService</key><string>daemon</string>",
  );
  expect(r.files["unrelated.plist"]).toBe(r.unrelated);
  expect(r.files["broken.plist"]).toBe("not a plist");
});

for (const scenario of ["bootstrap", "partial", "health", "wrong-sha"]) {
  test(`migration restores the old agent after ${scenario} failure`, async () => {
    const { result: r } = await migration(scenario);
    expect(r.error).toContain(
      scenario === "wrong-sha"
        ? "expected current"
        : `replacement ${scenario === "partial" ? "bootstrap" : scenario} failed`,
    );
    expect(r.calls.at(-1)).toBe("bootstrap arbitrary.installed.daemon");
    expect(r.files["original.plist"]).toBe(r.old);
    expect(r.files["dev.limitless.daemon.plist"]).toBeUndefined();
    expect(r.loaded).toEqual(["other.program", "arbitrary.installed.daemon"]);
    expect(r.calls).not.toContain("resume");
    expect(r.files["unrelated.plist"]).toBe(r.unrelated);
    if (["partial", "health", "wrong-sha"].includes(scenario))
      expect(r.calls).toContain("bootout dev.limitless.daemon");
  });
}

for (const scenario of [
  "drain",
  "drain-health",
  "unsupported",
  "bootout",
  "stuck",
  "collision",
  "duplicate",
]) {
  test(`${scenario} failure preserves the installed agent and avoids bootstrap`, async () => {
    const { result: r } = await migration(scenario);
    expect(r.error).not.toBe("");
    expect(r.files["original.plist"]).toBe(r.old);
    expect(r.loaded).toContain("arbitrary.installed.daemon");
    expect(r.calls.some((call) => call.startsWith("bootstrap"))).toBe(false);
    expect(r.files["dev.limitless.daemon.plist"]).toBeUndefined();
    if (["drain", "drain-health", "unsupported", "bootout", "stuck"].includes(scenario))
      expect(r.calls.at(-1)).toBe("resume");
    else expect(r.calls).not.toContain("resume");
    expect(r.draining).toBe(false);
    expect(r.files["unrelated.plist"]).toBe(r.unrelated);
  });
}

test("a failed resume reports both the original failure and the cleanup failure", async () => {
  const { result: r } = await migration("resume-failure");
  expect(r.error).toContain("drain failed");
  expect(r.error).toContain("Resume scheduler failed: Error: resume failed");
  expect(r.calls).toEqual(["drain", "resume"]);
  expect(r.draining).toBe(true);
  expect(r.files["original.plist"]).toBe(r.old);
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.files["dev.limitless.daemon.plist"]).toBeUndefined();
});

test("rollback reports both the replacement and restoration failures", async () => {
  const { result: r } = await migration("restore");
  expect(r.error).toContain("replacement bootstrap failed");
  expect(r.error).toContain("Restoration failed:");
  expect(r.error).toContain("old bootstrap failed");
  expect(r.files["original.plist"]).toBe(r.old);
  expect(r.files["dev.limitless.daemon.plist"]).toBeUndefined();
});

for (const kind of ["daemon", "tunnel", "mtplx"]) {
  test(`fresh ${kind} installation writes neutral, marked units`, async () => {
    const { result: r } = await migration("fresh", kind);
    expect(r.error).toBe("");
    expect(r.files[`dev.limitless.${kind}.plist`]).toContain(
      `<key>LimitlessService</key><string>${kind}</string>`,
    );
    expect(r.loaded).toContain(`dev.limitless.${kind}`);
    expect(r.calls).not.toContain("drain");
  });
}

for (const kind of ["tunnel", "mtplx"])
  for (const scenario of ["migration", "bootstrap"]) {
    test(`${kind} ${scenario} replaces or restores only the selected unit without draining`, async () => {
      const { result: r } = await migration(scenario, kind);
      expect(r.calls).not.toContain("drain");
      expect(r.calls).toContain(`bootout arbitrary.installed.${kind}`);
      if (scenario === "migration") {
        expect(r.error).toBe("");
        expect(r.loaded).toContain(`dev.limitless.${kind}`);
        expect(r.files["original.plist"]).toBeUndefined();
      } else {
        expect(r.error).toContain("replacement bootstrap failed");
        expect(r.files["original.plist"]).toBe(r.old);
        expect(r.loaded).toContain(`arbitrary.installed.${kind}`);
        expect(r.files[`dev.limitless.${kind}.plist`]).toBeUndefined();
      }
      expect(r.files["unrelated.plist"]).toBe(r.unrelated);
    });
  }

test("an unloaded daemon is replaced without drain", async () => {
  const { result: r } = await migration("unloaded");
  expect(r.error).toBe("");
  expect(r.calls).toEqual(["bootstrap dev.limitless.daemon", "health fresh"]);
});

test("status and uninstall recognize arbitrary installed labels", async () => {
  const status = await migration("status");
  expect(status.stdout).toContain("arbitrary.installed.daemon: loaded");
  expect(status.result.calls).toEqual([]);
  const { result: r } = await migration("uninstall");
  expect(r.error).toBe("");
  expect(r.calls).toEqual(["bootout arbitrary.installed.daemon"]);
  expect(r.files["original.plist"]).toBeUndefined();
  expect(r.files["unrelated.plist"]).toBe(r.unrelated);
});

test("an already marked neutral unit is discovered and reinstalled with a drained restart", async () => {
  const { result: r } = await migration("marked");
  expect(r.error).toBe("");
  expect(r.calls).toContain("drain");
  expect(r.calls).toContain("bootout dev.limitless.daemon");
  expect(r.calls.at(-2)).toBe("bootstrap dev.limitless.daemon");
  expect(r.calls.at(-1)).toBe("health fresh");
  expect(r.files["original.plist"]).toBeUndefined();
});

test("migration uses deploy's 45-minute drain timeout and then restarts", async () => {
  const { result: r, stdout } = await migration("timeout");
  expect(r.error).toBe("");
  expect(r.time).toBe(45 * 60_000 + 500);
  expect(stdout).toContain("Drain timeout after 2700s; restarting with active runs: active-run (review)");
  expect(r.calls.slice(-3)).toEqual([
    "bootout arbitrary.installed.daemon",
    "bootstrap dev.limitless.daemon",
    "health fresh",
  ]);
});

test("discovery rejects Bun's run command before the entry point", async () => {
  const { result: r } = await migration("bun-run");
  expect(r.error).toBe("");
  expect(r.calls).not.toContain("drain");
  expect(r.calls).not.toContain("bootout arbitrary.installed.daemon");
  expect(r.files["original.plist"]).toBe(r.old);
});

test("an unrelated plist at the neutral path is preserved without draining or stopping", async () => {
  const { result: r } = await migration("path-collision");
  expect(r.error).toContain("unrelated agent:");
  expect(r.calls).toEqual([]);
  expect(r.files["dev.limitless.daemon.plist"]).toBe(r.unrelated);
  expect(r.files["original.plist"]).toBe(r.old);
});

for (const kind of ["tunnel", "mtplx"]) {
  test(`install leaves an unselected older ${kind} agent in place`, async () => {
    const { result: r } = await migration("unselected", kind);
    expect(r.error).toBe("");
    expect(r.calls).toEqual(["bootstrap dev.limitless.daemon", "health fresh"]);
    expect(r.files["original.plist"]).toBe(r.old);
    expect(r.files[`dev.limitless.${kind}.plist`]).toBeUndefined();
    expect(r.loaded).toContain(`arbitrary.installed.${kind}`);
  });
}

for (const kind of ["daemon", "tunnel", "mtplx"]) {
  for (const scenario of ["displaced", "contradictory", "other-install"]) {
    test(`${kind} discovery excludes ${scenario} without touching its plist or load state`, async () => {
      const { result: r } = await migration(scenario, kind);
      expect(r.error).toBe("");
      expect(r.calls).not.toContain("drain");
      expect(r.calls).not.toContain(`bootout arbitrary.installed.${kind}`);
      expect(r.calls).not.toContain(`bootstrap arbitrary.installed.${kind}`);
      expect(r.loaded).toContain(`arbitrary.installed.${kind}`);
      expect(r.files["original.plist"]).toBe(r.old);
    });
  }
  for (const scenario of [
    "trailing",
    "symlink",
    "symlink-reverse",
    ...(kind === "daemon" ? [] : ["aux-path-alias"]),
  ]) {
    test(`${kind} discovery accepts ${scenario} with canonical ownership`, async () => {
      const { result: r } = await migration(scenario, kind);
      expect(r.error).toBe("");
      expect(r.calls).toContain(`bootout arbitrary.installed.${kind}`);
      expect(r.loaded).toContain(`dev.limitless.${kind}`);
      expect(r.files["original.plist"]).toBeUndefined();
      expect(r.backupBeforeStop).toBe(true);
      expect(r.backup).toBeNull();
      expect(r.state).toBe(false);
    });
  }
}

test("replacement bootout failure does not prevent restoration after failed health", async () => {
  const { result: r } = await migration("health-bootout");
  expect(r.error).toContain("replacement health failed");
  expect(r.error).toContain("bootout denied");
  expect(r.files["original.plist"]).toBe(r.old);
  expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.backup).toBe(r.old);
  expect(r.state).toBe(true);
});

test("backup persistence failure aborts before draining or stopping", async () => {
  const { result: r } = await migration("persist-failure");
  expect(r.error).not.toBe("");
  expect(r.calls).toEqual([]);
  expect(r.files["original.plist"]).toBe(r.old);
  expect(r.loaded).toContain("arbitrary.installed.daemon");
});

for (const scenario of ["install-install", "install-deploy", "deploy-install"]) {
  test(`${scenario} contention refuses before mutations and preserves holder ownership`, async () => {
    const { result: r } = await migration(scenario);
    expect(r.error).toBe("");
    expect(r.contenderError).toContain("deploy already running");
    expect(r.contenderCalls).toEqual([]);
    expect(r.lockHeld).toBe(true);
    expect(r.lock).toBe(false);
    expect(r.loaded).toContain(
      scenario === "deploy-install" ? "arbitrary.installed.daemon" : "dev.limitless.daemon",
    );
  });
}

async function interrupted(
  scenario: string,
  signal: "SIGINT" | "SIGTERM" | "SIGKILL",
  twice = false,
  phase = "replacing",
) {
  const dir = mkdtempSync(join(tmpdir(), "limitless-interrupted-migration-"));
  migrationDirs.push(dir);
  const child = Bun.spawn([process.execPath, "test/service-migration-support.ts", scenario], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SERVICE_TEST_HOME: dir },
  });
  const reader = child.stdout.getReader();
  let output = "";
  const until = async (marker: string) => {
    while (!output.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`fixture exited before ${marker}: ${output}`);
      output += new TextDecoder().decode(chunk.value);
    }
  };
  try {
    await until("READY");
    const backupDir = join(dir, ".limitless", "service-backup");
    const original = readFileSync(join(backupDir, "original.plist"), "utf8");
    const state = JSON.parse(readFileSync(join(backupDir, "migration.json"), "utf8"));
    expect(state.old.label).toBe(scenario.startsWith("marked") ? state.label : "arbitrary.installed.daemon");
    expect(state.label).toBe("dev.limitless.daemon");
    expect(state.phase).toBe(phase);
    child.kill(signal);
    if (signal !== "SIGKILL") await until("interrupted, rolling back...");
    if (twice) {
      await until("ROLLBACK");
      child.kill(signal);
    }
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    expect(await child.exited).toBe(
      signal === "SIGKILL" ? 137 : twice ? (signal === "SIGTERM" ? 143 : 130) : 0,
    );
    expect(await new Response(child.stderr).text()).toBe("");
    return { dir, original, output };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} restores and bootstraps the old unit and releases lifecycle resources`, async () => {
    const { dir, output, original } = await interrupted("signal", signal);
    const r = JSON.parse(output.trim().split("\n").at(-1) ?? "") as MigrationResult;
    expect(r.error).toContain(`interrupted by ${signal}`);
    expect(r.files["original.plist"]).toBe(original);
    expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
    expect(r.loaded).toContain("arbitrary.installed.daemon");
    expect(r.state).toBe(true);
    expect(r.lock).toBe(false);
    // The restored old agent is not the replacement: a later deploy that never proves the
    // replacement healthy must leave the rollback data on disk.
    const { result: later } = await migration("recover-unhealthy-deploy", "daemon", dir);
    expect(later.error).toContain("daemon health failed");
    expect(later.calls.filter((call) => call.startsWith("boot"))).toEqual([]);
    expect(later.loaded).toContain("arbitrary.installed.daemon");
    expect(later.state).toBe(true);
    expect(later.backup).toBe(original);
  });
}
for (const operation of ["recover-install", "recover-deploy"]) {
  test(`${operation} restores from disk after SIGTERM interrupts rollback`, async () => {
    const { dir, original } = await interrupted("signal-rollback", "SIGTERM", true);
    const { result: r } = await migration(operation, "daemon", dir);
    expect(r.error).toContain("Recovered previous agent arbitrary.installed.daemon");
    expect(r.files["original.plist"]).toBe(original);
    expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
    expect(r.loaded).toContain("arbitrary.installed.daemon");
    expect(r.loaded).not.toContain("dev.limitless.daemon");
    expect(r.state).toBe(true);
    expect(r.backup).toBe(original);
    expect(r.lock).toBe(false);
    const retry = await migration("recover-install", "daemon", dir);
    expect(retry.result.error).toBe("");
    expect(retry.result.loaded).toContain("dev.limitless.daemon");
    expect(retry.result.state).toBe(false);
  });
}

test("a failed drain keeps its rollback data while deploy recovery leaves the running agent alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-drain-failure-"));
  const { result: failed } = await migration("drain", "daemon", dir);
  expect(failed.error).toContain("drain failed");
  expect(failed.state).toBe(true);
  expect(failed.backup).toBe(failed.old);
  const { result: r } = await migration("recover-deploy", "daemon", dir);
  expect(r.error).toBe("");
  expect(r.calls.filter((call) => call.startsWith("boot"))).toEqual([]);
  expect(r.files["original.plist"]).toBe(failed.old);
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.state).toBe(true);
  expect(r.backup).toBe(failed.old);
});

for (const [scenario, signal] of [
  ["signal-drain", "SIGINT"],
  ["signal-drain", "SIGTERM"],
  ["marked-signal-drain", "SIGKILL"],
] as const) {
  test(`${signal} during ${scenario} leaves the running agent alone and its rollback data intact`, async () => {
    const { dir, original } = await interrupted(scenario, signal, false, "prepared");
    const { result: r } = await migration("recover-deploy", "daemon", dir);
    expect(r.error).toBe("");
    expect(r.calls.filter((call) => call.startsWith("boot"))).toEqual([]);
    expect(r.files["original.plist"]).toBe(original);
    expect(r.loaded).toContain(
      scenario.startsWith("marked") ? "dev.limitless.daemon" : "arbitrary.installed.daemon",
    );
    expect(r.state).toBe(true);
    expect(r.backup).toBe(original);
  });
}

test("healthy replacement after process loss clears recovery data before deployment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-healthy-migration-"));
  migrationDirs.push(dir);
  const child = Bun.spawn([process.execPath, "test/service-migration-support.ts", "crash-healthy"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SERVICE_TEST_HOME: dir },
  });
  await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
  const { result: r } = await migration("recover-healthy-deploy", "daemon", dir);
  expect(r.error).toBe("");
  expect(r.calls).toEqual(["health fresh", "health fresh"]);
  expect(r.state).toBe(false);
  expect(r.backup).toBeNull();
  expect(r.loaded).toContain("dev.limitless.daemon");
});

test("tracked text and triage recovery examples use neutral service labels", () => {
  const domain = ["matt", "flower"].join("");
  const forbidden = new RegExp(`(?:${domain}\\.cc|cc\\.${domain})(?:\\.limitless)?`, "i");
  for (const sample of [`${domain}.cc`, `cc.${domain}`, `cc.${domain}.limitless`])
    expect(forbidden.test(sample)).toBe(true);
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { stdout: "pipe" });
  expect(tracked.exitCode).toBe(0);
  const violations = tracked.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((path) => {
      const content = readFileSync(path);
      return !content.includes(0) && forbidden.test(content.toString());
    });
  expect(violations).toEqual([]);
  const cases = JSON.parse(readFileSync("evals/triage/cases.json", "utf8"));
  const entries = Array.isArray(cases) ? cases : cases.cases;
  expect(entries.find((entry: { id: string }) => entry.id === "triage-h24").prompt).toContain(
    "dev.limitless.daemon",
  );
});

test("rollback attempts old bootstrap even when the replacement uses the same label and cannot unload", async () => {
  const { result: r } = await migration("marked-health-bootout");
  expect(r.error).toContain("replacement health failed");
  expect(r.error).toContain("bootout denied");
  expect(r.error).toContain("overlapping services");
  expect(r.files["original.plist"]).toBe(r.old);
  expect(r.calls.filter((call) => call === "bootstrap dev.limitless.daemon")).toHaveLength(2);
  expect(r.backup).toBe(r.old);
  expect(r.state).toBe(true);
});

test("a failed journal phase update retains its previous record and still restores the old plist", async () => {
  const { result: r } = await migration("phase-update");
  expect(r.error).toContain("replacement health failed");
  expect(r.error).toContain("EISDIR");
  expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
  expect(r.files["original.plist"]).toBe(r.old);
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.backup).toBe(r.old);
  expect(r.state).toBe(true);
});

test("SIGKILL after plist removal is recoverable without the old plist or an in-memory rollback", async () => {
  const { dir, original } = await interrupted("signal", "SIGKILL");
  expect(existsSync(join(dir, "Library", "LaunchAgents", "original.plist"))).toBe(false);
  const { result: r } = await migration("recover-install", "daemon", dir);
  expect(r.error).toContain("Recovered previous agent arbitrary.installed.daemon");
  expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.files["original.plist"]).toBe(original);
  expect(r.backup).toBe(original);
});

for (const kind of ["tunnel", "mtplx"]) {
  test(`matching ${kind} marker remains discoverable`, async () => {
    const { result: r } = await migration("marked", kind);
    expect(r.error).toBe("");
    expect(r.calls).toContain(`bootout dev.limitless.${kind}`);
    expect(r.loaded).toContain(`dev.limitless.${kind}`);
    expect(r.files["original.plist"]).toBeUndefined();
  });
}

// Bootout was accepted but the old agent unloads only after the installer gave up (timeout) or was
// interrupted: the journal must survive so a later deploy can bootstrap the old agent again.
for (const [scenario, signal] of [
  ["stuck", null],
  ["signal-stopping", "SIGTERM"],
] as const) {
  for (const unloaded of [true, false]) {
    test(`${scenario} keeps rollback data until deploy restores the old agent (late unload: ${unloaded})`, async () => {
      const run = signal
        ? await interrupted(scenario, signal, false, "stopping")
        : await migration(scenario).then((m) => ({ ...m, dir: migrationDirs.at(-1) ?? "" }));
      const first = JSON.parse(
        ("output" in run ? run.output : run.stdout).trim().split("\n").at(-1) ?? "",
      ) as MigrationResult;
      expect(first.error).not.toBe("");
      expect(first.state).toBe(true);
      expect(first.backup).toBe(first.old);
      expect(first.calls.some((call: string) => call.startsWith("bootstrap"))).toBe(false);
      const loadedFile = join(run.dir, "loaded.json");
      if (unloaded)
        writeFileSync(
          loadedFile,
          JSON.stringify(
            JSON.parse(readFileSync(loadedFile, "utf8")).filter(
              (l: string) => l !== "arbitrary.installed.daemon",
            ),
          ),
        );
      const { result: r } = await migration("recover-deploy", "daemon", run.dir);
      expect(r.error).toContain("Recovered previous agent arbitrary.installed.daemon");
      expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
      expect(r.calls.includes("bootout arbitrary.installed.daemon")).toBe(!unloaded);
      expect(r.loaded).toContain("arbitrary.installed.daemon");
      expect(r.files["original.plist"]).toBe(first.old);
    });
  }
}
