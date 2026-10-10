import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
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
    const config = '[limits]\nslotted_commands = ["bun test"]\n';
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
      if (agent.commandPath) {
        const wrapper = agent.commandPath.split(delimiter)[0] ?? "";
        expect(existsSync(join(wrapper, "bun"))).toBe(true);
        expect(wrapper.startsWith(agent.cwd)).toBe(false);
        expect(wrapper.startsWith(agent.scratchDir ?? "")).toBe(false);
        wrappers.push(wrapper);
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
    expect(f.store.getRunState<RunState>(run.id)?.slottedCommands).toEqual(enabled ? [["bun", "test"]] : []);
    for (const wrapper of wrappers) expect(existsSync(wrapper)).toBe(false);
    const state = f.store.getRunState<RunState>(run.id);
    if (!state) throw new Error("missing state");
    // Upgrade a run whose PR now has the opposite value, using its original base revision.
    await f.stop();
    delete state.slottedCommands;
    f.store.setRunState(run.id, { ...state, phase: "loop" });
    f.store.updateRun(run.id, { status: "queued", finishedAt: null });
    f.store.close();
    fixture.factory = null;
    const resumed = start(handler);
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(resumed.store.getRunState<RunState>(run.id)?.slottedCommands).toEqual(
      enabled ? [["bun", "test"]] : [],
    );
  },
);
