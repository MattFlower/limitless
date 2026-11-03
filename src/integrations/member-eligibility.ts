import type { Config } from "../config.ts";
import type { ModelSelection, Repo, ReviewSystem, RunModels, RunRole } from "../core/types.ts";
import { RUN_ROLES } from "../core/types.ts";
import { selectHarness } from "../harness/select.ts";
import type { Phase } from "../pipeline/context.ts";
import { providerKind } from "../router/config-catalog.ts";
import { originExclusion } from "../router/origins.ts";
import type { ProviderTracker } from "../router/providers.ts";
import type { RouteConstraints, Router } from "../router/router.ts";
import { transportError } from "../router/targets.ts";
import { type ClockSource, windowOpen } from "../util/claim-clock.ts";
import type { MemberAdvertiser } from "./member-advert.ts";
import { CAPABILITY_FRESH_MS, type Capabilities, type CapabilityMonitor } from "./member-capabilities.ts";

export type CapabilityTask = {
  runId: string;
  phase: Phase;
  models?: RunModels;
  checkpoint?: 1 | 2;
  implementer?: { ref: string | ModelSelection; policyRevision?: string };
  repo: Repo;
};
export type CapabilityRefusal =
  | "advert"
  | "stale"
  | "protocol"
  | "checkpoint"
  | "os"
  | "confinement"
  | "login"
  | "route"
  | "parity"
  | "access"
  | "slots"
  | "power"
  | "draining";
export type TaskNeeds = {
  roles: readonly RunRole[];
  logins: readonly ("claude" | "codex")[];
  versions: readonly ("claude" | "codex")[];
  codexModes: readonly ("edit" | "read" | "confinedRead")[];
  unsupported: readonly RunRole[];
  checkpoint?: 1 | 2;
};
export function reviewTargets(cfg: Pick<Config, "reviewRosters">, override?: ReviewSystem) {
  const finders = override ? override.finders : Object.values(cfg.reviewRosters).flat();
  return {
    prefer: finders.flatMap((finder) => (finder.target === undefined ? [] : [finder.target])),
    only: [
      ...(override?.verifier?.target === undefined ? [] : [override.verifier.target]),
      ...(override?.verifier?.targets ?? []),
    ],
  };
}
export function taskNeeds(
  task: CapabilityTask,
  deps: {
    router: Router;
    tracker: Pick<ProviderTracker, "def">;
    reviewTargets: { prefer: string[]; only: string[] };
  },
): TaskNeeds {
  const { router, tracker } = deps;
  const start = { prepare: 0, triage: 0, clarify: 1, spec: 1, loop: 2, deliver: 2, accept: 2, done: 6 };
  const roles = RUN_ROLES.slice(start[task.phase]);
  const logins = new Set<"claude" | "codex">();
  const versions = new Set<"claude" | "codex">();
  const codexModes = new Set<"edit" | "read" | "confinedRead">();
  const unsupported: RunRole[] = [];
  for (const role of roles) {
    let executable = false;
    let failed = false;
    const chain = task.models?.[role];
    if (chain != null && (!Array.isArray(chain) || !chain.every((group) => typeof group === "string"))) {
      unsupported.push(role);
      continue;
    }
    const base: RouteConstraints = { billing: "free_first" };
    if (role === "implement")
      Object.assign(base, {
        minTier: 1,
        prefer: task.implementer?.ref,
        preferPolicyRevision: task.implementer?.policyRevision,
      });
    const shapes: RouteConstraints[] = chain == null ? [base] : [{ chain }];
    if (chain == null && role === "review")
      shapes.push(
        ...deps.reviewTargets.prefer.map((prefer) => ({ ...base, prefer })),
        ...deps.reviewTargets.only.map((only) => ({ only })),
      );
    for (const complexity of ["trivial", "small", "medium", "large"] as const) {
      for (const shape of shapes) {
        try {
          for (const visited of router.preview(role, complexity, shape)) {
            try {
              const resolved = router.resolve(visited.modelId);
              const { model } = resolved;
              // Preview target IDs without a suffix can represent a deliberately unset saved effort.
              const effort = visited.modelId === model.id ? undefined : resolved.effort;
              const provider = tracker.def(model.provider);
              if (
                originExclusion(model, router.excludeOrigins) ||
                transportError(role, { ...resolved, effort }, provider)
              )
                continue;
              const { harnessName, noTools } = selectHarness(role, router.toTarget(model, effort ?? null));
              executable = true;
              if (harnessName === "claude" || harnessName === "codex") {
                versions.add(harnessName);
                if (harnessName === "codex" || (provider && providerKind(provider) === "claude-cli"))
                  logins.add(harnessName);
                const mode = role === "implement" ? "edit" : role === "holdout" ? "confinedRead" : "read";
                if (harnessName === "codex" && !noTools) codexModes.add(mode);
              }
            } catch {
              /* A removed or invalid candidate grants no capability. */
            }
          }
        } catch {
          failed = true; // An incomplete preview cannot establish the role's requirements.
        }
      }
    }
    if (!executable || failed) unsupported.push(role);
  }
  return {
    roles,
    logins: [...logins],
    versions: [...versions],
    codexModes: [...codexModes],
    unsupported,
    checkpoint: task.checkpoint,
  };
}
export function canContinue(needs: TaskNeeds, caps: Capabilities): CapabilityRefusal[] {
  const refused: CapabilityRefusal[] = [];
  if (caps.protocol !== 1) refused.push("protocol");
  if (needs.roles.length && caps.os === "linux") refused.push("os");
  if (
    (needs.roles.length && (caps.confinement.backend !== "seatbelt" || !caps.confinement.verified)) ||
    needs.codexModes.some((mode) => !caps.confinement.codex[mode])
  )
    refused.push("confinement");
  if (
    needs.versions.some((cli) => caps.agents[cli].version === null) ||
    needs.logins.some((cli) => !caps.agents[cli].loggedIn)
  )
    refused.push("login");
  if (needs.unsupported.length) refused.push("route");
  if (caps.privateStrings.parity !== "match") refused.push("parity");
  return refused;
}
export function eligible(needs: TaskNeeds, caps: Capabilities, access: boolean): CapabilityRefusal[] {
  const refused = canContinue(needs, caps);
  if (needs.checkpoint !== undefined && !caps.checkpoints.includes(needs.checkpoint))
    refused.push("checkpoint");
  if (!access) refused.push("access");
  if (caps.freeSlots <= 0) refused.push("slots");
  if (caps.power !== "ac") refused.push("power");
  if (caps.draining) refused.push("draining");
  return refused;
}
export interface CapabilityGate {
  admit(task: CapabilityTask, signal?: AbortSignal): Promise<CapabilityRefusal[]>;
  canContinue(task: CapabilityTask, signal?: AbortSignal): Promise<CapabilityRefusal[]>;
  capableNow(runId: string): boolean;
  forget(runId: string): void;
}
export function createCapabilityGate(deps: {
  monitor: CapabilityMonitor;
  advertiser: Pick<MemberAdvertiser, "fresh">;
  router: Router;
  tracker: Pick<ProviderTracker, "def">;
  cfg: Config;
  reviewSystem?: ReviewSystem;
  clock: ClockSource;
  freeSlots(): number;
  draining(): boolean;
}): CapabilityGate {
  const memo = new Map<string, TaskNeeds>();
  async function check(
    task: CapabilityTask,
    admission: boolean,
    signal?: AbortSignal,
  ): Promise<CapabilityRefusal[]> {
    const needs = taskNeeds(task, { ...deps, reviewTargets: reviewTargets(deps.cfg, deps.reviewSystem) });
    memo.set(task.runId, needs);
    try {
      const [snapshot, access] = await Promise.all([
        deps.monitor.current(deps.clock.sample()) ?? deps.monitor.refresh(signal),
        deps.monitor.access(task.repo, signal),
      ]);
      const now = deps.clock.sample();
      const freshSnapshot = windowOpen(snapshot.at, now, CAPABILITY_FRESH_MS);
      const freshAccess = windowOpen(access.at, now, CAPABILITY_FRESH_MS);
      const advert = !admission || deps.advertiser.fresh(now);
      const refused: CapabilityRefusal[] = [];
      if (!freshSnapshot || !freshAccess) refused.push("stale");
      if (!advert) refused.push("advert");
      if (refused.length) return refused;
      if (!admission)
        return [...canContinue(needs, snapshot.value), ...(!access.value ? ["access" as const] : [])];
      const caps = { ...snapshot.value, freeSlots: deps.freeSlots(), draining: deps.draining() };
      return eligible(needs, caps, access.value);
    } catch {
      return ["stale"];
    }
  }
  return {
    admit: (task, signal) => check(task, true, signal),
    canContinue: (task, signal) => check(task, false, signal),
    capableNow(runId) {
      const needs = memo.get(runId);
      const snapshot = deps.monitor.current(deps.clock.sample());
      return !!needs && !!snapshot && canContinue(needs, snapshot.value).length === 0;
    },
    forget: (runId) => void memo.delete(runId),
  };
}
