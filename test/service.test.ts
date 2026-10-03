import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  calls: string[];
  loaded: string[];
  draining: boolean;
  old: string;
  time: number;
  files: Record<string, string>;
  unrelated: string;
};
async function migration(scenario: string, kind = "daemon") {
  const dir = mkdtempSync(join(tmpdir(), "limitless-service-migration-"));
  migrationDirs.push(dir);
  const child = Bun.spawn([process.execPath, "test/fixtures/service-migration.ts", scenario, kind], {
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

test("discovery accepts Bun's run command before the entry point", async () => {
  const { result: r } = await migration("bun-run");
  expect(r.error).toBe("");
  expect(r.calls).toContain("drain");
  expect(r.calls).toContain("bootout arbitrary.installed.daemon");
  expect(r.files["original.plist"]).toBeUndefined();
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
