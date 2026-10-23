import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Factory } from "../src/app.ts";
import { agentTestCommand, type WrapperConfig } from "../src/cli/agent-test.ts";
import { agentTestLease } from "../src/gates/agent-tests.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { approve, holdout, pass, pipelineSetup, roleOf, spec, triage, waitFor } from "./pipeline-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start } = pipelineSetup(fixture);

test.each([false, true])(
  "base command config survives opposite PR edits and resume (enabled=%s)",
  async (enabled) => {
    const file = join(fixture.repoDir, ".limitless.toml");
    const original = readFileSync(file, "utf8");
    const config = '[limits]\nslotted_commands = ["bun test"]\nagent_full_suite = "refuse"\n';
    const secret = `credential-${crypto.randomUUID()}`;
    registerCredential("AGENT_TEST_SECRET", secret);
    if (enabled) {
      writeFileSync(file, original + config);
      await sh(["git", "add", ".limitless.toml"], { cwd: fixture.repoDir });
      await sh(["git", "commit", "-qm", "base slotting config"], { cwd: fixture.repoDir });
    }
    const wrappers: string[] = [],
      roles = new Set<string>();
    const handler: Parameters<typeof start>[0] = async (agent) => {
      const role = roleOf(agent);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      roles.add(role);
      expect(!!agent.commandPath).toBe(enabled);
      expect(!!agent.idleNow).toBe(enabled);
      if (agent.commandPath) {
        const wrapper = agent.commandPath.split(delimiter)[0] ?? "";
        expect(existsSync(join(wrapper, "bun"))).toBe(true);
        expect(wrapper.startsWith(agent.cwd)).toBe(false);
        expect(wrapper.startsWith(agent.scratchDir ?? "")).toBe(false);
        wrappers.push(wrapper);
        if (role === "implement") {
          const wrapperConfig: WrapperConfig = JSON.parse(readFileSync(join(wrapper, "config.json"), "utf8"));
          expect(wrapperConfig).toMatchObject({ role, agentFullSuite: "refuse" });
          const { token } = wrapperConfig;
          const stderr = spyOn(console, "error").mockImplementation(() => {});
          try {
            expect(
              await agentTestCommand(wrapperConfig, ["bun", "test", "-t", secret], async (body) =>
                agentTestLease(body),
              ),
            ).not.toBe(0);
            expect(stderr.mock.calls.flat().join()).toContain("factory's gates run the full suite");
            expect(stderr.mock.calls.flat().join()).not.toContain(secret);
          } finally {
            stderr.mockRestore();
          }
          const lease = await agentTestLease({ token, name: "bun test", lane: "small" });
          expect(lease.acquired).toBe(true);
          await agentTestLease({ token, id: lease.id, release: true });
        }
      }
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return {
        files: { "farewell.txt": "goodbye\n", ".limitless.toml": original + (enabled ? "" : config) },
      };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell.txt" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect([...roles].sort()).toEqual(["implement", "review", "verify"]);
    const watchdogEvents = f.store.listEvents(run.id).filter((e) => e.message.startsWith("Idle watchdog"));
    expect(watchdogEvents).toHaveLength(enabled ? 2 : 0);
    if (enabled) {
      expect(watchdogEvents[0]?.message).toBe("Idle watchdog held off for slotted command");
      expect(watchdogEvents[1]?.message).toMatch(/^Idle watchdog resumed after \d+ms held off/);
      const implementer = f.store.listInvocations(run.id).find((inv) => inv.role === "implement");
      if (!implementer) throw new Error("missing implementer invocation");
      expect(watchdogEvents.map((e) => e.invocationId)).toEqual([implementer.id, implementer.id]);
    }
    expect(f.store.getRunState<RunState>(run.id)?.slottedCommands).toEqual(enabled ? [["bun", "test"]] : []);
    expect(f.store.getRunState<RunState>(run.id)?.agentFullSuite).toBe(enabled ? "refuse" : "slot");
    const refusals = f.store.listEvents(run.id).filter((e) => e.message.startsWith("agent-test refused:"));
    expect(refusals).toHaveLength(enabled ? 1 : 0);
    if (enabled) {
      expect(refusals[0]?.invocationId).toBe(
        f.store.listInvocations(run.id).find((inv) => inv.role === "implement")?.id,
      );
      expect(refusals[0]?.message).toBe("agent-test refused: full suite: bun test -t [redacted]");
      expect(refusals[0]?.data).toBeNull();
      expect(f.store.listEvents(run.id).some((e) => e.message.startsWith("Agent test "))).toBe(false);
      expect(JSON.stringify(f.store.listEvents(run.id))).not.toContain(secret);
    }
    for (const wrapper of wrappers) expect(existsSync(wrapper)).toBe(false);
    const state = f.store.getRunState<RunState>(run.id);
    if (!state) throw new Error("missing state");
    // Upgrade a run whose PR now has the opposite value, using its original base revision.
    await f.stop();
    delete state.slottedCommands;
    delete state.agentFullSuite;
    f.store.setRunState(run.id, { ...state, phase: "loop" });
    f.store.updateRun(run.id, { status: "queued", finishedAt: null });
    f.store.close();
    fixture.factory = null;
    const resumed = start(handler);
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(resumed.store.getRunState<RunState>(run.id)?.agentFullSuite).toBe(enabled ? "refuse" : "slot");
    expect(resumed.store.getRunState<RunState>(run.id)?.slottedCommands).toEqual(
      enabled ? [["bun", "test"]] : [],
    );
  },
);
