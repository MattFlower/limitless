import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { inspectService, installationUnits, stableExecutable } from "../src/cli/service.ts";
import { inspectionCases, inspectionResult } from "./service-inspection-support.ts";

for (const domain of ["gui", "user"] as const)
  for (const scenario of inspectionCases) {
    test(`launchctl inspection: ${domain} ${scenario}`, async () => {
      const label = "custom.executor";
      const result = await inspectService(
        label,
        async (args) => {
          expect(args).toEqual(["launchctl", "print", `${domain}/${userInfo().uid}/${label}`]);
          return inspectionResult(scenario, label, domain);
        },
        domain,
      );
      expect(result.state).toBe(scenario === "loaded" || scenario === "absent" ? scenario : "unknown");
      if (result.state === "unknown") {
        expect(result.reason).toContain(`launchctl print ${domain}/${userInfo().uid}/${label} failed`);
        expect(result.reason).toContain(
          scenario.startsWith("timeout-")
            ? "timed out"
            : scenario === "signal"
              ? "exit null"
              : scenario === "empty"
                ? "no output"
                : scenario === "execution-error"
                  ? "print could not execute"
                  : scenario === "permission"
                    ? "Operation not permitted"
                    : "Could not find service",
        );
      }
    });
  }

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
        expect(content).toContain("<key>LANG</key><string>C.UTF-8</string>");
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

test("service CLI dispatches configured executor and opt-in mtplx", async () => {
  // A temporary config, never the user's: --tunnel reads [server] public_url from it.
  const configDir = mkdtempSync(join(tmpdir(), "limitless-service-cli-"));
  writeFileSync(
    join(configDir, "config.toml"),
    '[server]\npublic_url = "https://hooks.example.test"\n[executor]\nenabled = true\n',
  );
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
      expect(output).toContain(JSON.stringify({ tunnel: on, mtplx: on, publicUrl, executor: true }));
    }
  }
  rmSync(configDir, { recursive: true, force: true });
});

const migrationDirs: string[] = [];
afterEach(() => {
  for (const dir of migrationDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type MigrationResult = {
  firstCalls: string[];
  recoveries: { error: string; phase: string; retained: boolean }[];
  discovered: string[];
  discoveredUnits: { label: string; path: string; kind: string }[];
  intent: boolean;
  original: string;
  stable: string;
  executable: string;
  commands: string[][];
  parsedUnits: Record<
    string,
    {
      ProgramArguments: string[];
      WorkingDirectory: string;
      EnvironmentVariables: Record<string, string>;
    }
  >;
  error: string;
  errorKind: string;
  errorCause: string;
  filesBefore: Record<string, string>;
  loadedBefore: string[];
  disabledBefore: string[];
  backupBeforeStop: boolean;
  contenderError: string;
  contenderCalls: string[];
  lockHeld: boolean;
  recoveryCleaned: boolean;
  backup: string | null;
  phase: string;
  journals: string[];
  firstError: string;
  tunnelJournal: string;
  daemonOld: string;
  state: boolean;
  lock: boolean;
  calls: string[];
  loaded: string[];
  disabled: string[];
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
  inspectionCase = "",
) {
  migrationDirs.push(dir);
  const child = Bun.spawn([process.execPath, "test/service-migration-support.ts", scenario, kind], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SERVICE_TEST_HOME: dir, SERVICE_TEST_INSPECTION: inspectionCase },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return { result: JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as MigrationResult, stdout };
}

for (const mode of ["source", "packaged"]) {
  for (const kind of ["daemon", "mtplx", "tunnel", "executor"]) {
    test(`${mode} ${kind} discovery rejects a mismatched Program`, async () => {
      const { result: r } = await migration(`${mode}-program-mismatch`, kind);
      expect(r.error).toBe("");
      expect(r.discovered).toEqual([]);
      expect(r.files[`${kind}-original.plist`]).toBe(r.original);
      expect(r.loaded).toContain(`arbitrary.installed.${kind}`);
      expect(r.calls).toEqual([]);
    });
  }
  for (const program of ["absent", "equal", "symlink", "invalid", "unresolvable"]) {
    test(`${mode} daemon discovery handles ${program} Program`, async () => {
      const { result: r } = await migration(`${mode}-program-${program}`);
      expect(r.error).toBe("");
      expect(r.discovered).toEqual(["invalid", "unresolvable"].includes(program) ? [] : ["daemon"]);
    });
  }
  test(`${mode} install refuses a mismatched Program at the destination without side effects`, async () => {
    const { result: r } = await migration(`${mode}-program-collision`);
    expect(r.error).toContain("unrelated agent:");
    expect(r.discovered).toEqual([]);
    expect(r.files["dev.limitless.daemon.plist"]).toBe(r.original);
    expect(r.loaded.sort()).toEqual(["arbitrary.installed.daemon", "other.program"]);
    expect(r.calls).toEqual([]);
    expect(r.draining).toBe(false);
    expect(r.journals).toEqual([]);
    expect(r.lock).toBe(false);
  });
}

test("packaged stable executable maps a Cellar file to its matching opt symlink", () => {
  const prefix = mkdtempSync(join(tmpdir(), "limitless-homebrew-"));
  migrationDirs.push(prefix);
  const version = join(prefix, "Cellar", "limitless", "1.0");
  const executable = join(version, "bin", "limitless");
  mkdirSync(join(version, "bin"), { recursive: true });
  writeFileSync(executable, "binary");
  mkdirSync(join(prefix, "opt"));
  symlinkSync(version, join(prefix, "opt", "limitless"));
  expect(stableExecutable(executable)).toBe(join(prefix, "opt", "limitless", "bin", "limitless"));
});

for (const target of ["missing", "wrong-version", "missing-executable"]) {
  test(`packaged stable executable refuses ${target} with both paths`, () => {
    const prefix = mkdtempSync(join(tmpdir(), "limitless-homebrew-"));
    migrationDirs.push(prefix);
    const executable = join(prefix, "Cellar", "limitless", "1.0", "bin", "limitless");
    const other = join(prefix, "Cellar", "limitless", "2.0");
    const stable = join(prefix, "opt", "limitless", "bin", "limitless");
    mkdirSync(join(executable, ".."), { recursive: true });
    if (target !== "missing-executable") writeFileSync(executable, "binary");
    mkdirSync(join(other, "bin"), { recursive: true });
    writeFileSync(join(other, "bin", "limitless"), "other binary");
    mkdirSync(join(prefix, "opt"));
    if (target !== "missing") symlinkSync(other, join(prefix, "opt", "limitless"));
    expect(() => stableExecutable(executable)).toThrow(stable);
    expect(() => stableExecutable(executable)).toThrow(executable);
  });
}

test("packaged stable executable preserves a local bin path", () => {
  const home = mkdtempSync(join(tmpdir(), "limitless-local-bin-"));
  migrationDirs.push(home);
  const executable = join(home, ".local", "bin", "limitless");
  mkdirSync(join(executable, ".."), { recursive: true });
  writeFileSync(executable, "binary");
  expect(stableExecutable(executable)).toBe(executable);
});

test("packaged fresh install uses stable arguments, data home, explicit environment and build SHA", async () => {
  const { result: r } = await migration("packaged-fresh");
  expect(r.error).toBe("");
  const daemon = r.parsedUnits["dev.limitless.daemon.plist"];
  expect(daemon?.ProgramArguments).toEqual([r.stable, "serve"]);
  expect(Object.keys(r.parsedUnits).sort()).toEqual([
    "dev.limitless.daemon.plist",
    "dev.limitless.mtplx.plist",
    "dev.limitless.tunnel.plist",
  ]);
  const dir = migrationDirs.at(-1) ?? "";
  for (const unit of Object.values(r.parsedUnits)) {
    expect(unit.WorkingDirectory).toBe(join(dir, ".limitless"));
    expect(unit.EnvironmentVariables).toEqual({
      PATH: [
        join(dir, ".local", "bin"),
        "/opt/homebrew/bin",
        join(dir, ".bun", "bin"),
        join(dir, ".mtplx", "bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
      LANG: "C.UTF-8",
      NODE_ENV: "production",
    });
  }
  expect(
    r.commands.filter((args) => args[0] === "git" || (args[0] === "bun" && args[1] === "install")),
  ).toEqual([]);
  expect(r.firstCalls).toContain(`health ${"b".repeat(40)}`);
  expect(r.firstCalls.at(-3)).toBe(`health ${"a".repeat(40)}`);
  expect(r.firstCalls.indexOf(`health ${"b".repeat(40)}`)).toBeLessThan(
    r.firstCalls.indexOf(`health ${"a".repeat(40)}`),
  );
  expect(r.lock).toBe(false);
});

test("packaged reinstall discovers its own daemon and auxiliary units and drains before replacement", async () => {
  const { result: r } = await migration("packaged-reinstall");
  expect(r.error).toBe("");
  expect(r.discovered.sort()).toEqual(["daemon", "mtplx", "tunnel"]);
  expect(r.calls).toEqual([
    "drain",
    "health draining",
    "bootout dev.limitless.daemon",
    "bootstrap dev.limitless.daemon",
    `health ${"b".repeat(40)}`,
    `health ${"a".repeat(40)}`,
    "bootout dev.limitless.mtplx",
    "bootstrap dev.limitless.mtplx",
    "bootout dev.limitless.tunnel",
    "bootstrap dev.limitless.tunnel",
  ]);
  expect(r.journals).toEqual([]);
  expect(r.lock).toBe(false);
});

for (const failure of ["bootstrap", "health"]) {
  test(`packaged reinstall restores original plist and loaded agent after ${failure} failure`, async () => {
    const { result: r } = await migration(`packaged-${failure}`);
    expect(r.error).toContain(
      failure === "bootstrap" ? "replacement bootstrap failed" : `expected ${"a".repeat(40)}`,
    );
    expect(r.calls[0]).toBe("drain");
    expect(r.calls.at(-1)).toBe("bootstrap dev.limitless.daemon");
    expect(r.files["dev.limitless.daemon.plist"]).toBe(r.original);
    expect(r.loaded).toContain("dev.limitless.daemon");
    expect(r.backup).toBe(r.original);
    expect(r.phase).toBe("restored");
    expect(r.lock).toBe(false);
  });
}

for (const scenario of ["source", "extra", "invalid"]) {
  test(`packaged install preserves a loaded ${scenario} unit without draining or stopping`, async () => {
    const { result: r } = await migration(`packaged-${scenario}`);
    expect(r.error).toContain(scenario === "invalid" ? "stable executable" : "unrelated agent");
    if (scenario === "invalid") {
      expect(r.error).toContain(r.stable);
      expect(r.error).toContain(r.executable);
    }
    expect(r.calls).toEqual([]);
    expect(r.files["dev.limitless.daemon.plist"]).toBe(r.original);
    expect(r.loaded).toContain("dev.limitless.daemon");
    expect(r.journals).toEqual([]);
    expect(r.lock).toBe(false);
  });
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
  expect(r.files["daemon-original.plist"]).toBeUndefined();
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
    expect(r.files["daemon-original.plist"]).toBe(r.old);
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
    expect(r.files["daemon-original.plist"]).toBe(r.old);
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
  expect(r.time).toBe(0);
  expect(r.draining).toBe(true);
  expect(r.files["daemon-original.plist"]).toBe(r.old);
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.files["dev.limitless.daemon.plist"]).toBeUndefined();
});

for (const resumeFails of [false, true])
  test(`an unknown stop inspection after drain resumes once (resume fails: ${resumeFails})`, async () => {
    const { result: r } = await migration(
      `inspection-post-drain${resumeFails ? "-resume-failure" : ""}`,
      "daemon",
      undefined,
      "permission",
    );
    expect(r.error).toContain("launchctl print");
    expect(r.error).toContain("Operation not permitted");
    expect(r.errorKind).toBe("ServiceInspectionError");
    if (resumeFails) expect(r.error).toContain("Resume scheduler failed: Error: resume failed");
    expect(r.calls.filter((c) => c === "resume")).toHaveLength(1);
    expect(r.calls[0]).toBe("drain");
    expect(r.calls).toContain("health draining");
    expect(r.calls.at(-1)).toBe("resume");
    expect(r.draining).toBe(resumeFails);
    expect(r.files["daemon-original.plist"]).toBe(r.old);
    expect(r.files["dev.limitless.daemon.plist"]).toBeUndefined();
    expect(r.loaded).toEqual(["arbitrary.installed.daemon", "other.program"]);
    expect(r.commands.filter((c) => c[0] === "launchctl" && c[1] !== "print")).toEqual([]);
    expect(
      r.commands.filter((c) => c[1] === "print" && c[2]?.endsWith("/arbitrary.installed.daemon")),
    ).toHaveLength(2);
  });

for (const failure of ["drain-timeout", "stop"])
  test(`an unknown recovery inspection after ${failure} still resumes once`, async () => {
    const { result: r } = await migration(
      `failed-recovery-inspection-${failure}`,
      "daemon",
      undefined,
      "permission",
    );
    const original = failure === "drain-timeout" ? "daemon request timed out" : "stop failed";
    expect(r.error).toContain(original);
    expect(r.calls.filter((c) => c === "resume")).toHaveLength(1);
    expect(r.error).toContain("Restoration failed:");
    expect(r.error).toContain("launchctl print");
    expect(r.error).toContain("Operation not permitted");
    expect(r.errorCause).toContain(original);
    expect(r.errorKind).toBe("Error");
    expect(r.calls.at(-1)).toBe("resume");
    expect(r.draining).toBe(false);
    expect(r.loaded.sort()).toEqual(["arbitrary.installed.daemon", "other.program"]);
    expect(r.files["daemon-original.plist"]).toBe(r.old);
    expect(r.files["dev.limitless.daemon.plist"]).toBeUndefined();
    expect(r.calls.some((c) => c.startsWith("bootstrap"))).toBe(false);
  });

for (const resumeFails of [false, true])
  test(`a failed restoration after stop failure still resumes once (resume fails: ${resumeFails})`, async () => {
    const { result: r } = await migration(`failed-recovery-restore${resumeFails ? "-resume-failure" : ""}`);
    expect(r.error).toContain("stop failed");
    expect(r.calls.filter((c) => c === "resume")).toHaveLength(1);
    expect(r.error).toContain("Restoration failed:");
    expect(r.error).toContain("old bootstrap failed");
    expect(r.errorCause).toContain("stop failed");
    if (resumeFails) expect(r.error).toContain("Resume scheduler failed: Error: resume failed");
    else expect(r.error).not.toContain("Resume scheduler failed:");
    expect(r.calls.slice(-2)).toEqual(["bootstrap arbitrary.installed.daemon", "resume"]);
    expect(r.draining).toBe(resumeFails);
    expect(r.loaded.sort()).toEqual(["arbitrary.installed.daemon", "other.program"]);
    expect(r.files["daemon-original.plist"]).toBe(r.old);
    expect(r.files["dev.limitless.daemon.plist"]).toBeUndefined();
  });

test("rollback reports both the replacement and restoration failures", async () => {
  const { result: r } = await migration("restore");
  expect(r.error).toContain("replacement bootstrap failed");
  expect(r.error).toContain("Restoration failed:");
  expect(r.error).toContain("old bootstrap failed");
  expect(r.files["daemon-original.plist"]).toBe(r.old);
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
        expect(r.files[`${kind}-original.plist`]).toBeUndefined();
      } else {
        expect(r.error).toContain("replacement bootstrap failed");
        expect(r.files[`${kind}-original.plist`]).toBe(r.old);
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
  expect(r.files["daemon-original.plist"]).toBeUndefined();
  expect(r.files["unrelated.plist"]).toBe(r.unrelated);
});

for (const mode of ["source", "packaged"])
  for (const scenario of [...inspectionCases, "path"]) {
    test(`${mode} executor destination collision preflights every unit: ${scenario}`, async () => {
      const { result: r } = await migration(`${mode}-inspection-collision`, "executor", undefined, scenario);
      if (scenario === "absent") {
        expect(r.error).toBe("");
        expect(r.files["executor-original.plist"]).toBeUndefined();
        expect(r.loaded).toContain("dev.limitless.executor");
        expect(r.loaded).toContain("dev.limitless.daemon");
      } else {
        expect(r.error).toContain(
          scenario === "path"
            ? "unrelated agent:"
            : scenario === "loaded"
              ? "unrecognized agent: dev.limitless.executor"
              : "launchctl print",
        );
        expect(r.files).toEqual(r.filesBefore);
        expect(r.loaded).toEqual(r.loadedBefore);
        expect(r.disabled).toEqual(r.disabledBefore);
        expect(r.calls).toEqual([]);
        expect(r.commands.filter((c) => c[0] === "launchctl" && c[1] !== "print")).toEqual([]);
        expect(r.draining).toBe(false);
        expect(r.journals).toEqual([]);
      }
    });
  }

for (const scenario of inspectionCases) {
  if (!["loaded", "absent"].includes(scenario))
    test(`executor old-label inspection preserves the plist: ${scenario}`, async () => {
      const { result: r } = await migration("inspection-old", "executor", undefined, scenario);
      expect(r.error).toContain("launchctl print");
      expect(r.files["executor-original.plist"]).toBe(r.old);
      expect(r.files["dev.limitless.executor.plist"]).toBeUndefined();
      expect(r.calls.some((c) => c.includes("executor"))).toBe(false);
      expect(r.state).toBe(true);
      expect(
        r.commands.filter((c) => c[1] === "print" && c[2]?.endsWith("/arbitrary.installed.executor")),
      ).toHaveLength(1);
    });

  test(`executor uninstall inspection: ${scenario}`, async () => {
    const { result: r } = await migration("inspection-uninstall", "executor", undefined, scenario);
    if (["loaded", "absent"].includes(scenario)) {
      expect(r.error).toBe("");
      expect(r.files["executor-original.plist"]).toBeUndefined();
      expect(r.calls).toEqual(scenario === "loaded" ? ["bootout arbitrary.installed.executor"] : []);
    } else {
      expect(r.error).toContain("launchctl print");
      expect(r.files["executor-original.plist"]).toBe(r.old);
      expect(r.loaded).toContain("arbitrary.installed.executor");
      expect(r.calls).toEqual([]);
    }
  });

  test(`executor status inspection: ${scenario}`, async () => {
    const { result: r, stdout } = await migration("inspection-status", "executor", undefined, scenario);
    const state = scenario === "loaded" ? "loaded" : scenario === "absent" ? "not loaded" : "unknown:";
    expect(stdout).toContain(`arbitrary.installed.executor: ${state}`);
    if (state === "unknown:") expect(stdout).toContain("launchctl print");
    expect(r.error).toBe("");
    expect(r.files["executor-original.plist"]).toBe(r.old);
    expect(r.calls).toEqual([]);
    expect(r.commands.filter((c) => c[0] === "launchctl")).toEqual([
      ["launchctl", "print", `gui/${userInfo().uid}/arbitrary.installed.executor`],
    ]);
  });
}

for (const kind of ["daemon", "executor"])
  test(`${kind} restoration preserves replacement and journal on an unknown inspection`, async () => {
    const { result: r } = await migration("inspection-restore", kind, undefined, "permission");
    expect(r.error).toContain("replacement bootstrap failed");
    expect(r.error).toContain("Operation not permitted");
    expect(r.state).toBe(true);
    expect(r.phase).toBe("rollback");
    expect(r.files[`${kind}-original.plist`]).toBeUndefined();
    expect(r.files[`dev.limitless.${kind}.plist`]).toContain(`<string>dev.limitless.${kind}</string>`);
    expect(r.backup).toBe(r.old);
    expect(r.calls).not.toContain(`bootstrap arbitrary.installed.${kind}`);
  });

test("install retains its replacement and journal when reconciliation times out with exit zero", async () => {
  const { result: r } = await migration("inspection-reconcile", "executor", undefined, "timeout-loaded");
  expect(r.error).toContain("timed out, exit 0");
  expect(r.state).toBe(true);
  expect(r.phase).toBe("replacing");
  expect(r.files["executor-original.plist"]).toBeUndefined();
  expect(r.files["dev.limitless.executor.plist"]).toContain("<string>dev.limitless.executor</string>");
  expect(r.backup).toBe(r.old);
  expect(r.calls).toContain("enable dev.limitless.executor");
  expect(r.calls).not.toContain("bootout dev.limitless.executor");
  expect(r.calls).not.toContain("bootstrap dev.limitless.executor");
});

test("an already marked neutral unit is discovered and reinstalled with a drained restart", async () => {
  const { result: r } = await migration("marked");
  expect(r.error).toBe("");
  expect(r.calls).toContain("drain");
  expect(r.calls).toContain("bootout dev.limitless.daemon");
  expect(r.calls.at(-2)).toBe("bootstrap dev.limitless.daemon");
  expect(r.calls.at(-1)).toBe("health fresh");
  expect(r.files["daemon-original.plist"]).toBeUndefined();
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
  expect(r.files["daemon-original.plist"]).toBe(r.old);
});

test("an unrelated plist at the neutral path is preserved without draining or stopping", async () => {
  const { result: r } = await migration("path-collision");
  expect(r.error).toContain("unrelated agent:");
  expect(r.calls).toEqual([]);
  expect(r.files["dev.limitless.daemon.plist"]).toBe(r.unrelated);
  expect(r.files["daemon-original.plist"]).toBe(r.old);
});

for (const kind of ["tunnel", "mtplx"]) {
  test(`install leaves an unselected older ${kind} agent in place`, async () => {
    const { result: r } = await migration("unselected", kind);
    expect(r.error).toBe("");
    expect(r.calls).toEqual(["bootstrap dev.limitless.daemon", "health fresh"]);
    expect(r.files[`${kind}-original.plist`]).toBe(r.old);
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
      expect(r.files[`${kind}-original.plist`]).toBe(r.old);
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
      expect(r.files[`${kind}-original.plist`]).toBeUndefined();
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
  expect(r.files["daemon-original.plist"]).toBe(r.old);
  expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.backup).toBe(r.old);
  expect(r.state).toBe(true);
});

test("backup persistence failure aborts before draining or stopping", async () => {
  const { result: r } = await migration("persist-failure");
  expect(r.error).not.toBe("");
  expect(r.calls).toEqual([]);
  expect(r.files["daemon-original.plist"]).toBe(r.old);
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
  kind = "daemon",
) {
  const dir = mkdtempSync(join(tmpdir(), "limitless-interrupted-migration-"));
  migrationDirs.push(dir);
  const child = Bun.spawn([process.execPath, "test/service-migration-support.ts", scenario, kind], {
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
    const state = JSON.parse(readFileSync(join(backupDir, "dev.limitless.daemon.json"), "utf8"));
    const original = Buffer.from(state.backup, "base64").toString();
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
    expect(r.files["daemon-original.plist"]).toBe(original);
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
    expect(r.files["daemon-original.plist"]).toBe(original);
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
  expect(r.files["daemon-original.plist"]).toBe(failed.old);
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
    const { dir, original, output } = await interrupted(scenario, signal, false, "prepared");
    if (signal !== "SIGKILL") {
      const stopped = JSON.parse(output.trim().split("\n").at(-1) ?? "") as MigrationResult;
      expect(stopped.draining).toBe(false);
      expect(stopped.calls.filter((call) => ["drain applied", "resume"].includes(call))).toEqual([
        "drain applied",
        "resume",
      ]);
      expect(stopped.calls.some((call) => call.startsWith("boot"))).toBe(false);
    }
    const { result: r } = await migration("recover-deploy", "daemon", dir);
    expect(r.error).toBe("");
    expect(r.calls.filter((call) => call.startsWith("boot"))).toEqual([]);
    expect(r.files["daemon-original.plist"]).toBe(original);
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
  expect(r.files["daemon-original.plist"]).toBe(r.old);
  expect(r.calls.filter((call) => call === "bootstrap dev.limitless.daemon")).toHaveLength(2);
  expect(r.backup).toBe(r.old);
  expect(r.state).toBe(true);
});

test("a failed journal phase update retains its previous record and still restores the old plist", async () => {
  const { result: r } = await migration("phase-update");
  expect(r.error).toContain("replacement health failed");
  expect(r.error).toContain("EISDIR");
  expect(r.phase).toBe("replacing");
  expect(r.journals).toEqual(["dev.limitless.daemon.json"]);
  const backupDir = join(migrationDirs.at(-1) ?? "", ".limitless", "service-backup");
  expect(existsSync(join(backupDir, "original.plist"))).toBe(false);
  expect(existsSync(join(backupDir, "migration.json"))).toBe(false);
  expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
  expect(r.files["daemon-original.plist"]).toBe(r.old);
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.backup).toBe(r.old);
  expect(r.state).toBe(true);
});

test("SIGKILL after plist removal is recoverable without the old plist or an in-memory rollback", async () => {
  const { dir, original } = await interrupted("signal", "SIGKILL");
  expect(existsSync(join(dir, "Library", "LaunchAgents", "daemon-original.plist"))).toBe(false);
  const { result: r } = await migration("recover-install", "daemon", dir);
  expect(r.error).toContain("Recovered previous agent arbitrary.installed.daemon");
  expect(r.calls).toContain("bootstrap arbitrary.installed.daemon");
  expect(r.loaded).toContain("arbitrary.installed.daemon");
  expect(r.files["daemon-original.plist"]).toBe(original);
  expect(r.backup).toBe(original);
});

for (const kind of ["tunnel", "mtplx"]) {
  test(`matching ${kind} marker remains discoverable`, async () => {
    const { result: r } = await migration("marked", kind);
    expect(r.error).toBe("");
    expect(r.calls).toContain(`bootout dev.limitless.${kind}`);
    expect(r.loaded).toContain(`dev.limitless.${kind}`);
    expect(r.files[`${kind}-original.plist`]).toBeUndefined();
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
      expect(r.files["daemon-original.plist"]).toBe(first.old);
    });
  }
}

test("restored tunnel survives daemon install", async () => {
  const { result: r } = await migration("sequence", "tunnel");
  expect(r.firstError).toContain("replacement bootstrap failed");
  expect(r.error).toBe("");
  expect(r.files["tunnel-original.plist"]).toBe(r.old);
  expect(r.files["daemon-original.plist"]).toBeUndefined();
  expect(r.loaded).toContain("arbitrary.installed.tunnel");
  expect(r.loaded).toContain("dev.limitless.daemon");
  expect(r.journals).toEqual(["dev.limitless.tunnel.json"]);
  const retained = readFileSync(
    join(migrationDirs.at(-1) ?? "", ".limitless", "service-backup", "dev.limitless.tunnel.json"),
    "utf8",
  );
  expect(retained).toBe(r.tunnelJournal);
  expect(JSON.parse(retained).phase).toBe("restored");
  expect(Buffer.from(JSON.parse(retained).backup, "base64").toString()).toBe(r.old);
  expect(r.backup).toBe(r.old);
});

test("interrupted daemon preserves tunnel rollback", async () => {
  const { dir, original } = await interrupted("sequence-signal", "SIGKILL", false, "prepared", "tunnel");
  const backupDir = join(dir, ".limitless", "service-backup");
  const tunnelJournal = readFileSync(join(backupDir, "dev.limitless.tunnel.json"), "utf8");
  const tunnelOld = Buffer.from(JSON.parse(tunnelJournal).backup, "base64").toString();
  expect(tunnelOld).toContain("arbitrary.installed.tunnel");
  expect(tunnelOld).not.toBe(original);
  const { result: r } = await migration("recover-deploy", "daemon", dir);
  expect(r.error).toBe("");
  expect(r.calls.filter((call) => call.startsWith("boot"))).toEqual([]);
  expect(r.files["daemon-original.plist"]).toBe(original);
  expect(r.files["tunnel-original.plist"]).toBe(tunnelOld);
  expect(r.journals.sort()).toEqual(["dev.limitless.daemon.json", "dev.limitless.tunnel.json"]);
  expect(r.backup).toBe(original);
  expect(readFileSync(join(backupDir, "dev.limitless.tunnel.json"), "utf8")).toBe(tunnelJournal);
  // If the old daemon subsequently unloads, only its own bytes are restored.
  writeFileSync(
    join(dir, "loaded.json"),
    JSON.stringify(r.loaded.filter((l) => l !== "arbitrary.installed.daemon")),
  );
  const { result: restored } = await migration("recover-deploy", "daemon", dir);
  expect(restored.error).toContain("Recovered previous agent arbitrary.installed.daemon");
  expect(restored.files["daemon-original.plist"]).toBe(original);
  expect(restored.files["tunnel-original.plist"]).toBe(tunnelOld);
  expect(restored.backup).toBe(original);
  expect(readFileSync(join(backupDir, "dev.limitless.tunnel.json"), "utf8")).toBe(tunnelJournal);
});

for (const phase of ["prepared", "restored", "stopping", "unhealthy", "restore-failure"]) {
  test(`recovers every service record (${phase})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "limitless-multi-record-"));
    migrationDirs.push(dir);
    const backupDir = join(dir, ".limitless", "service-backup");
    const agents = join(dir, "Library", "LaunchAgents");
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(agents, { recursive: true });
    const retain = ["prepared", "restored"].includes(phase);
    const records = ["daemon", "tunnel", "mtplx"].map((kind) => {
      const label = `dev.limitless.${kind}`;
      const oldLabel = `arbitrary.installed.${kind}`;
      const old = `<plist><dict><key>Label</key><string>${oldLabel}</string><key>Original</key><string>${kind}</string></dict></plist>`;
      const state = {
        label,
        path: join(agents, `${label}.plist`),
        old: { label: oldLabel, path: join(agents, `${kind}-original.plist`) },
        phase:
          kind === "mtplx"
            ? "replacing"
            : phase === "unhealthy" && kind === "daemon"
              ? "replacing"
              : phase === "unhealthy"
                ? "stopping"
                : phase === "restore-failure"
                  ? "stopping"
                  : phase,
        target: "current",
        backup: Buffer.from(old).toString("base64"),
      };
      const json = JSON.stringify(state);
      writeFileSync(join(backupDir, `${label}.json`), json);
      if (retain) writeFileSync(state.old.path, old);
      else writeFileSync(state.path, `<plist><dict><key>Label</key><string>${label}</string></dict></plist>`);
      return { state, old, json };
    });
    writeFileSync(join(backupDir, "incomplete.json.tmp"), "unfinished atomic write");
    writeFileSync(
      join(dir, "loaded.json"),
      JSON.stringify([
        "dev.limitless.mtplx",
        ...(retain
          ? ["arbitrary.installed.daemon", "arbitrary.installed.tunnel"]
          : phase === "unhealthy"
            ? ["dev.limitless.daemon"]
            : []),
      ]),
    );
    const { result: r } = await migration(
      phase === "unhealthy"
        ? "recover-unhealthy-deploy"
        : phase === "restore-failure"
          ? "recover-restore-failure-deploy"
          : "recover-deploy",
      "daemon",
      dir,
    );
    expect(r.error === "").toBe(retain);
    if (phase === "restore-failure") {
      expect(r.error).toContain("Restoration failed");
      expect(r.error).toContain("old bootstrap failed");
      expect(r.error).toStartWith("Error: Restoration failed for arbitrary.installed.daemon:");
      const recovered = r.error.split("Recovered previous agent ").slice(1).join("");
      expect(recovered).toContain("arbitrary.installed.tunnel");
      expect(recovered).not.toContain("arbitrary.installed.daemon");
    } else expect(r.error).not.toContain("Restoration failed");
    expect(r.loaded).toContain("dev.limitless.mtplx");
    expect(existsSync(join(backupDir, "dev.limitless.mtplx.json"))).toBe(false);
    expect(readFileSync(join(backupDir, "incomplete.json.tmp"), "utf8")).toBe("unfinished atomic write");
    for (const { state, old, json } of records.slice(0, 2)) {
      const saved = readFileSync(join(backupDir, `${state.label}.json`), "utf8");
      expect(Buffer.from(JSON.parse(saved).backup, "base64").toString()).toBe(old);
      expect(readFileSync(state.old.path, "utf8")).toBe(old);
      const failed = phase === "restore-failure" && state.label === "dev.limitless.daemon";
      expect(r.loaded.includes(state.old.label)).toBe(!failed);
      if (retain) expect(saved).toBe(json);
      else {
        expect(r.error).toContain(state.old.label);
        expect(r.error).toContain("retry installation");
        expect(JSON.parse(saved).phase).toBe(failed ? "rollback" : "restored");
        expect(existsSync(state.path)).toBe(false);
      }
    }
  });
}

for (const executor of [undefined, false, true]) {
  for (const packaged of [false, true]) {
    test(`executor unit arguments and environment (${packaged}, ${executor})`, () => {
      const units = installationUnits({
        executor,
        execPath: "/opt/bin/limitless",
        release: packaged
          ? { kind: "packaged", sha: "a".repeat(40), version: "1", bun: Bun.version }
          : { kind: "source", root: "/app", version: "1", bun: Bun.version },
      });
      const content = units.find(([label]) => label === "dev.limitless.executor")?.[1];
      if (!executor) {
        expect(content).toBeUndefined();
        return;
      }
      expect(content).toContain("<key>KeepAlive</key><true/>");
      expect(content).toContain("<string>executor</string>");
      expect(content).toContain(
        packaged
          ? "<string>/opt/bin/limitless</string>"
          : `<string>${join(homedir(), ".bun/bin/bun")}</string>`,
      );
      expect(content?.match(/<key>EnvironmentVariables<\/key>.*?<\/dict>/s)?.[0]).toBe(
        units[0]?.[1].match(/<key>EnvironmentVariables<\/key>.*?<\/dict>/s)?.[0],
      );
    });
  }
}
for (const scenario of ["migration", "contradictory", "duplicate", "unselected", "bootstrap"]) {
  test(`executor install: ${scenario}`, async () => {
    const { result: r } = await migration(scenario, "executor");
    if (scenario === "contradictory") {
      expect(r.error).toBe("");
      expect(r.loaded).toContain("arbitrary.installed.executor");
      return;
    }
    if (scenario === "duplicate") {
      expect(r.error).toContain("multiple installed executor agents");
      return;
    }
    if (scenario === "bootstrap") {
      expect(r.error).toContain("replacement bootstrap failed");
      expect(r.files["executor-original.plist"]).toBe(r.old);
      expect(r.phase).toBe("restored");
      expect(r.loaded).not.toContain("arbitrary.installed.executor");
      expect(r.disabled).toContain("arbitrary.installed.executor");
      expect(r.calls).not.toContain("bootstrap arbitrary.installed.executor");
      return;
    }
    expect(r.error).toBe("");
    expect(r.calls).toContain("disable arbitrary.installed.executor");
    if (scenario === "unselected") {
      expect(r.files["executor-original.plist"]).toBeUndefined();
    } else {
      expect(r.calls.indexOf("enable dev.limitless.executor")).toBeLessThan(
        r.calls.indexOf("bootstrap dev.limitless.executor"),
      );
      expect(r.loaded).toContain("dev.limitless.executor");
    }
  });
}

for (const stuck of [false, true]) {
  test(`restored executor journal survives two recoveries until reconciliation (stuck: ${stuck})`, async () => {
    const { result: r } = await migration(`executor-recovery${stuck ? "-stuck" : ""}`, "executor");
    expect(r.error).toBe("");
    expect(r.firstError).toContain("replacement bootstrap failed");
    expect(r.firstCalls).not.toContain("enable arbitrary.installed.executor");
    expect(r.firstCalls).not.toContain("bootstrap arbitrary.installed.executor");
    expect(r.recoveries).toHaveLength(2);
    for (const recovery of r.recoveries) {
      expect(recovery.retained).toBe(true);
      expect(recovery.phase).toBe("restored");
      expect(recovery.error).not.toContain("retry installation");
      expect(recovery.error).toContain(stuck ? "launchctl disable gui/" : "stopped after recovery");
    }
    expect(r.state).toBe(stuck);
    if (!stuck) {
      expect(r.loaded).toContain("arbitrary.installed.executor");
      expect(r.disabled).not.toContain("arbitrary.installed.executor");
    }
  });
}
for (const mode of ["source", "packaged"]) {
  test(`${mode} executor discovery returns its actual label and path`, async () => {
    const { result: r } = await migration(`${mode}-program-absent`, "executor");
    expect(r.error).toBe("");
    expect(r.discovered).toEqual(["executor"]);
    expect(r.discoveredUnits).toEqual([
      {
        label: "arbitrary.installed.executor",
        kind: "executor",
        path: join(
          migrationDirs.at(-1) ?? "",
          mode === "packaged" ? "isolated-agents" : "Library/LaunchAgents",
          "executor-original.plist",
        ),
      },
    ]);
  });
}

test("install recovers a deploying intent before installing and reconciles after health", async () => {
  const { result: r } = await migration("intent-install", "executor");
  expect(r.error).toBe("");
  expect(r.intent).toBe(false);
  const disabled = r.commands.findIndex((args) => args[0] === "launchctl" && args[1] === "disable");
  const installed = r.commands.findIndex((args) => args[0] === "bun" && args[1] === "install");
  expect(disabled).toBeGreaterThan(-1);
  expect(disabled).toBeLessThan(installed);
  expect(r.calls.indexOf("enable dev.limitless.executor")).toBeLessThan(
    r.calls.indexOf("bootstrap dev.limitless.executor"),
  );
  expect(r.loaded).toContain("dev.limitless.executor");
});

test("packaged executor installation uses the stable binary and daemon working directory", async () => {
  const { result: r } = await migration("packaged-fresh", "executor");
  expect(r.error).toBe("");
  const executor = r.parsedUnits["dev.limitless.executor.plist"];
  expect(executor?.ProgramArguments).toEqual([r.stable, "executor"]);
  expect(executor?.WorkingDirectory).toBe(r.parsedUnits["dev.limitless.daemon.plist"]?.WorkingDirectory);
  expect(r.loaded).toContain("dev.limitless.executor");
});

for (const mode of ["source", "packaged"])
  for (const scenario of ["marker", "duplicate"]) {
    test(`${mode} executor discovery rejects ${scenario}`, async () => {
      const { result: r } = await migration(`${mode}-program-${scenario}`, "executor");
      expect(r.discovered).toEqual([]);
      expect(r.error).toBe(scenario === "duplicate" ? "Error: multiple installed executor agents" : "");
    });
  }
