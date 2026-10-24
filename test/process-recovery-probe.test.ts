import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { agentEnv, recoveryProcessStopped, runProcess } from "../src/util/proc.ts";

const unavailable = !["darwin", "linux"].includes(process.platform)
  ? "requires macOS or Linux"
  : Bun.which("python3") === null
    ? "requires python3"
    : null;
const state = z.object({
  parent: z.number(),
  group: z.number(),
  session: z.number(),
  name: z.string(),
  cwd: z.string(),
  hidden: z.boolean(),
});
const observation = z.object({
  scenario: z.string().optional(),
  control: z.string().optional(),
  pid: z.number(),
  helperPid: z.number(),
  state,
  carriesMarker: z.boolean().optional(),
  savedLeader: z.object({ pid: z.number(), group: z.number(), session: z.number() }).nullable().optional(),
});
const scan = z.object({
  scenario: z.string(),
  discovered: z.boolean(),
  controlsExcluded: z.literal(true),
  scanMs: z.array(z.number()).length(3),
});

test.skipIf(unavailable !== null)(
  `recovery probe verifies real process state and cleans owned processes (${unavailable ?? "available"})`,
  async () => {
    const result = await runProcess({
      cmd: [process.execPath, join(import.meta.dir, "../scripts/probe-process-recovery.ts")],
      cwd: process.cwd(),
      env: agentEnv(),
      timeoutMs: 30_000,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    const reports: unknown[] = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const observations = reports.flatMap((report) => {
      const parsed = observation.safeParse(report);
      return parsed.success ? [parsed.data] : [];
    });
    const scans = reports.flatMap((report) => {
      const parsed = scan.safeParse(report);
      return parsed.success ? [parsed.data] : [];
    });
    const controls = observations.filter((row) => row.control);
    expect(controls).toHaveLength(2);
    expect(controls[0]?.state.session).not.toBe(controls[1]?.state.session);
    expect(controls[0]?.state.group).not.toBe(controls[1]?.state.group);
    const scenarios = observations.filter((row) => row.scenario);
    expect(scenarios).toHaveLength(process.platform === "darwin" ? 6 : 1);
    expect(scans).toHaveLength(scenarios.length);
    for (const row of scenarios) {
      expect(scans.some((scan) => scan.scenario === row.scenario)).toBe(true);
      expect(result.stdout).toContain(`${row.scenario}: cleanup confirmed`);
    }
    // Inspect creator-reported IDs independently after the subprocess's cleanup assertions.
    for (const row of observations) {
      expect(recoveryProcessStopped(row.pid)).toBe(true);
      expect(recoveryProcessStopped(row.helperPid)).toBe(true);
    }
    if (process.platform === "darwin") {
      for (const name of ["setsid only", "cwd only", "platform only", "orphan only"])
        expect(scans.find((row) => row.scenario === name)?.discovered).toBe(true);
      const combined = scenarios.find((row) => row.scenario === "all four");
      expect(combined?.state).toMatchObject({ parent: 1, name: "sleep", hidden: true });
      expect(combined?.state.session).toBe(combined?.pid);
      expect(combined?.state.group).toBe(combined?.pid);
      expect(combined?.state.session).not.toBe(combined?.savedLeader?.session);
      expect(combined?.state.cwd.endsWith("/outside")).toBe(true);
      const nullLeader = scenarios.find((row) => row.scenario?.startsWith("null leader:"));
      expect(nullLeader?.savedLeader).toBeNull();
      expect(nullLeader?.state).toMatchObject({ parent: 1, name: "sleep", hidden: true });
      expect(nullLeader?.state.session).toBe(nullLeader?.helperPid);
      expect(nullLeader?.state.group).toBe(nullLeader?.helperPid);
    } else {
      expect(scenarios[0]?.carriesMarker).toBe(false);
      expect(scenarios[0]?.state.name).toBe("sleep");
      expect(scenarios[0]?.state.session).toBe(scenarios[0]?.helperPid);
      expect(scenarios[0]?.state.group).toBe(scenarios[0]?.helperPid);
    }
  },
  40_000,
);
