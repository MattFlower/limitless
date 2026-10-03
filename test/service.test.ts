import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      expect(units[0]?.[1]).toContain("serve");
      if (mtplx) expect(units[1]?.[1]).toContain("mtplx-local");
    }
});

function isolatedConfig(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "limitless-service-cli-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "config.toml"), "[server]\nport = 9000\n");
  return { LIMITLESS_HOME: join(dir, "home"), LIMITLESS_CONFIG_DIR: join(dir, "config") };
}

test("service CLI dispatches opt-in mtplx and advertises the new flag", async () => {
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
      { env: { ...process.env, ...isolatedConfig(), LIMITLESS_PORT: "" }, stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    if (flags.includes("--help")) {
      expect(output).toContain("[--mtplx]");
      expect(output).not.toContain("--no-mtplx");
    } else expect(output).toContain(JSON.stringify({ tunnel: flags.length > 0, mtplx: flags.length > 0 }));
  }
});

test("service install, status and deploy CLI use config port with environment taking precedence", async () => {
  const preload = join(mkdtempSync(join(tmpdir(), "limitless-service-port-")), "preload.ts");
  const service = JSON.stringify(join(import.meta.dir, "..", "src", "cli", "service.ts"));
  const print = "async (port: number) => console.log(JSON.stringify({ port }))";
  writeFileSync(
    preload,
    `import { mock } from "bun:test";\nmock.module(${service}, () => ({ install: ${print}, status: ${print}, deploy: ${print} }));\n`,
  );
  for (const command of [["service", "install"], ["service", "status"], ["deploy"]])
    for (const override of ["", "9100"]) {
      const child = Bun.spawn([process.execPath, "--preload", preload, "src/cli/main.ts", ...command], {
        env: { ...process.env, ...isolatedConfig(), LIMITLESS_PORT: override },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(output)).toEqual({ port: override ? 9100 : 9000 });
    }
});

interface ServiceResult {
  calls: string[];
  files: Record<string, string>;
  loaded: string[];
  logs: string[];
  error?: string;
}

async function serviceFake(scenario: Record<string, unknown>): Promise<ServiceResult> {
  const child = Bun.spawn([process.execPath, "test/fixtures/service-fake.ts", JSON.stringify(scenario)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(errors).toBe("");
  return JSON.parse(output) as ServiceResult;
}

const newLabels = ["dev.limitless.daemon", "dev.limitless.mtplx", "dev.limitless.tunnel"] as const;
const oldLabels = [
  "cc.mattflower.limitless",
  "cc.mattflower.limitless-mtplx",
  "cc.mattflower.limitless-tunnel",
] as const;
const agentPath = (label: string) => `/fake/home/Library/LaunchAgents/${label}.plist`;
const bootout = (label: string) => `launchctl bootout gui/501/${label}`;
const bootstrap = (label: string) => `launchctl bootstrap gui/501 ${agentPath(label)}`;

test("fresh installs generate only requested neutral plists and matching stdout/stderr logs", async () => {
  for (const optional of [false, true]) {
    const f = await serviceFake({ mtplx: optional, tunnel: optional, port: 9000, delayed: true });
    expect(f.error).toBeUndefined();
    expect(f.loaded).toEqual(optional ? [...newLabels] : [newLabels[0]]);
    for (const label of f.loaded) {
      expect(f.calls).toContain(bootstrap(label));
      const plist = f.files[agentPath(label)] ?? "";
      expect(plist).toContain(`<key>Label</key><string>${label}</string>`);
      for (const key of ["StandardOutPath", "StandardErrorPath"])
        expect(plist).toContain(`<key>${key}</key><string>/fake/home/.limitless/logs/${label}.log</string>`);
    }
    expect(f.files[agentPath("dev.limitless.daemon")]).not.toContain("<key>LIMITLESS_PORT</key>");
    expect(f.files[agentPath("dev.limitless.daemon")]).toContain(
      "<key>LIMITLESS_STAGING_PORT</key><string>9001</string>",
    );
  }
});

test("install preserves an explicit port override without pinning a config-derived port", async () => {
  const f = await serviceFake({ port: 9000, envPort: "9000" });
  expect(f.error).toBeUndefined();
  expect(f.files[agentPath(newLabels[0])]).toContain("<key>LIMITLESS_PORT</key><string>9000</string>");
  expect(f.calls).toContain("health 9000/api/health");
});

test("fresh and migrating mtplx units authenticate their health probes", async () => {
  for (const labels of [[], [oldLabels[1]]]) {
    const f = await serviceFake({ labels, mtplx: true });
    expect(f.error).toBeUndefined();
    expect(f.calls).toContain("authorization Bearer mtplx-local");
    expect(f.calls).toContain("health 8000/v1/models");
    if (labels.length) expect(f.calls).toContain("health 8001/v1/models");
    expect(f.loaded).toContain(newLabels[1]);
    expect(f.loaded).not.toContain(oldLabels[1]);
  }
});

test("migration verifies each staged replacement before retiring or deleting its predecessor", async () => {
  const f = await serviceFake({ labels: oldLabels, mtplx: true, tunnel: true });
  expect(f.error).toBeUndefined();
  expect(f.loaded).toEqual([...newLabels]);
  for (let i = 0; i < newLabels.length; i++) {
    const current = newLabels[i] ?? "";
    const old = oldLabels[i] ?? "";
    const ready =
      i === 0 ? "health 7401/api/health" : i === 1 ? "health 8001/v1/models" : "health 7402/ready";
    expect(f.calls.indexOf(bootstrap(current))).toBeLessThan(f.calls.indexOf(ready));
    expect(f.calls.indexOf(ready)).toBeLessThan(f.calls.indexOf(bootout(old)));
    expect(f.calls.indexOf(bootout(old))).toBeLessThan(f.calls.indexOf(`unlink ${agentPath(old)}`));
    expect(f.files[agentPath(old)]).toBeUndefined();
  }
  expect(f.files[agentPath("dev.limitless.mtplx")]).toContain("<string>8000</string>");
});

test("bootstrap, health and old-daemon health cannot retire a legacy unit", async () => {
  for (const failure of ["bootstrap", "health", "old-health", "stub"]) {
    const f = await serviceFake({ labels: [oldLabels[0]], failure });
    expect(f.error).toContain("failed");
    expect(f.loaded).toContain("cc.mattflower.limitless");
    expect(f.loaded).not.toContain("dev.limitless.daemon");
    expect(f.files[agentPath("cc.mattflower.limitless")]).toBeDefined();
    expect(f.calls).not.toContain(bootout("cc.mattflower.limitless"));
  }
});

test("optional unit bootstrap or readiness failures preserve its legacy agent", async () => {
  for (const failure of ["bootstrap", "health", "port-owner"])
    for (const label of ["dev.limitless.mtplx", "dev.limitless.tunnel"]) {
      const old = label.endsWith("mtplx") ? oldLabels[1] : oldLabels[2];
      const f = await serviceFake({ labels: [old], mtplx: true, tunnel: true, failure, failLabel: label });
      expect(f.error).toContain("failed");
      expect(f.loaded).toContain(old ?? "");
      expect(f.files[agentPath(old ?? "")]).toBeDefined();
      expect(f.calls).not.toContain(bootout(old ?? ""));
    }
});

test("failed final port handoff restores the old daemon and retains its plist", async () => {
  const f = await serviceFake({ labels: [oldLabels[0]], failure: "handoff" });
  expect(f.error).toContain("handoff failed");
  expect(f.loaded).toEqual([oldLabels[0]]);
  expect(f.files[agentPath("cc.mattflower.limitless")]).toBeDefined();
  expect(f.calls).toContain(bootstrap("cc.mattflower.limitless"));
});

test("a fresh unhealthy daemon makes install fail", async () => {
  const f = await serviceFake({ failure: "health" });
  expect(f.error).toContain("failed");
  expect(f.logs).not.toContain("installed dev.limitless.daemon");
});

test("status reports the installed labels and logs; uninstall cleans legacy, neutral and mixed units", async () => {
  for (const labels of [oldLabels, newLabels, [...oldLabels, ...newLabels]]) {
    const f = await serviceFake({ action: "status", labels });
    expect(f.error).toBeUndefined();
    for (const label of labels === oldLabels ? oldLabels : newLabels)
      expect(f.logs).toContain(`${label}: loaded; log: /fake/home/.limitless/logs/${label}.log`);
    const removed = await serviceFake({ action: "uninstall", labels });
    expect(removed.error).toBeUndefined();
    expect(removed.loaded).toEqual([]);
    for (const label of labels) expect(removed.files[agentPath(label)]).toBeUndefined();
  }
});

test("omitted options preserve optional legacy installations", async () => {
  const f = await serviceFake({ labels: oldLabels });
  expect(f.error).toBeUndefined();
  expect(f.loaded).toContain("cc.mattflower.limitless-mtplx");
  expect(f.loaded).toContain("cc.mattflower.limitless-tunnel");
  expect(f.calls).not.toContain(bootout("cc.mattflower.limitless-mtplx"));
  expect(f.calls).not.toContain(bootstrap("dev.limitless.tunnel"));
});

test("daemon handoff serves the real app on staging until the old label unloads", async () => {
  const f = await serviceFake({ action: "handoff", labels: [oldLabels[0]] });
  expect(f.error).toBeUndefined();
  expect(f.calls[1]).toBe("staging 7401");
  expect(f.calls.at(-1)).toBe("staging stop");
  expect(f.loaded).toEqual([]);
});

test("a replacement startup failure never stops the old daemon", async () => {
  const handoff = await serviceFake({ action: "handoff", labels: [oldLabels[0]], failure: "staging" });
  expect(handoff.error).toContain("replacement startup failed");
  expect(handoff.calls).not.toContain("staging stop");
  // Without the real app answering on staging, install never retires the old daemon.
  const f = await serviceFake({ labels: [oldLabels[0]], failure: "stub" });
  expect(f.error).toContain("dev.limitless.daemon bootstrap or health failed");
  expect(f.calls).not.toContain(bootout(oldLabels[0]));
  expect(f.calls).not.toContain("health 7400/api/health");
  expect(f.loaded).toEqual([oldLabels[0]]);
});

test("a failed mtplx final bootstrap restores its legacy unit", async () => {
  const f = await serviceFake({
    labels: [oldLabels[1]],
    mtplx: true,
    failure: "final-bootstrap",
    failLabel: newLabels[1],
  });
  expect(f.error).toContain("failure");
  expect(f.loaded).toContain(oldLabels[1]);
  expect(f.loaded).not.toContain(newLabels[1]);
  expect(f.files[agentPath(oldLabels[1])]).toBeDefined();
});

test("an absent legacy plist aborts migration before the running service is stopped", async () => {
  const f = await serviceFake({ labels: [oldLabels[0]], missingPlist: true });
  expect(f.error).toContain("missing legacy plist");
  expect(f.loaded).toEqual([oldLabels[0]]);
  expect(f.calls).not.toContain(bootout(oldLabels[0]));
});

test("bootout failures retain legacy services and plists during install and uninstall", async () => {
  for (const action of ["install", "uninstall"]) {
    const f = await serviceFake({ action, labels: [oldLabels[0]], failure: "bootout" });
    expect(f.error).toContain("fake failure");
    expect(f.loaded).toContain(oldLabels[0]);
    expect(f.files[agentPath(oldLabels[0])]).toBeDefined();
  }
});

test("mixed status chooses the old daemon when the new PID does not serve healthy responses", async () => {
  const f = await serviceFake({
    action: "status",
    labels: [...oldLabels, ...newLabels],
    failure: "old-health",
  });
  expect(f.error).toBeUndefined();
  expect(f.logs).toContain(`${oldLabels[0]}: loaded; log: /fake/home/.limitless/logs/${oldLabels[0]}.log`);
});

test("healthy installs clean unloaded predecessor plists only for requested units", async () => {
  for (const optional of [false, true]) {
    const f = await serviceFake({ plists: oldLabels, mtplx: optional, tunnel: optional });
    expect(f.error).toBeUndefined();
    for (const old of oldLabels) expect(f.calls).not.toContain(bootout(old));
    expect(f.files[agentPath(oldLabels[0])]).toBeUndefined();
    for (const old of oldLabels.slice(1)) {
      if (optional) expect(f.files[agentPath(old)]).toBeUndefined();
      else expect(f.files[agentPath(old)]).toBeDefined();
    }
  }
});
