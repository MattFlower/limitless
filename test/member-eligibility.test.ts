import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { type Repo, type ReviewSystem, RUN_ROLES } from "../src/core/types.ts";
import type { Capabilities, CapabilityMonitor, Observed } from "../src/integrations/member-capabilities.ts";
import {
  type CapabilityRefusal,
  type CapabilityTask,
  canContinue,
  createCapabilityGate,
  eligible,
  reviewTargets,
  taskNeeds,
} from "../src/integrations/member-eligibility.ts";
import type { Phase } from "../src/pipeline/context.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import type { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";
import { type ClockSample, windowOpen } from "../src/util/claim-clock.ts";

afterEach(() => mock.restore());
const repo: Repo = {
  id: "repo",
  slug: "example/repo",
  kind: "github",
  url: "https://example.com/repo.git",
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr",
  createdAt: 0,
};
const cfg = {
  reviewRosters: {
    quick: [{ target: "codex/m", prompt: "standard" }],
    standard: [{ prompt: "standard" }],
    deep: [{ target: "claude/m", prompt: "careful" }],
  },
} as Config;
const system: ReviewSystem = {
  name: "panel",
  mode: "panel",
  implementerReport: "include",
  finders: [{ target: "codex/m", prompt: "standard" }, { prompt: "standard" }],
  verifier: { target: "codex/m@high", targets: ["codex/m@low"] },
};
function task(base = "claude/m", phase: Phase = "triage"): CapabilityTask {
  return { runId: "run", phase, repo, models: Object.fromEntries(RUN_ROLES.map((role) => [role, [base]])) };
}
function catalog() {
  const providers: ProviderDef[] = [
    {
      id: "claude",
      kind: "claude-cli",
      label: "Claude",
      harness: "claude",
      billing: "subscription",
      maxConcurrent: 1,
    },
    {
      id: "codex",
      kind: "codex-cli",
      label: "Codex",
      harness: "codex",
      billing: "subscription",
      maxConcurrent: 1,
    },
    {
      id: "http",
      kind: "openai-compatible",
      label: "HTTP",
      harness: "claude",
      billing: "metered",
      maxConcurrent: 1,
      openaiBaseUrl: "https://example.com/v1",
    },
    {
      id: "anthropic",
      kind: "anthropic-compatible",
      label: "API",
      harness: "claude",
      billing: "metered",
      maxConcurrent: 1,
      baseUrl: "https://example.com",
    },
    {
      id: "decision",
      kind: "decisions",
      label: "Decision",
      harness: "decisions",
      billing: "metered",
      maxConcurrent: 1,
    },
    { id: "fake", label: "Fake", harness: "fake", billing: "metered", maxConcurrent: 1 },
  ];
  const models: ModelDef[] = providers.map((p) => ({
    id: `${p.id}/m`,
    provider: p.id,
    model: "model",
    vendor: "other",
    origin: "US",
    baseOrigin: "US",
    supportedEfforts: ["low", "high"],
    tier: 1,
    price: { input: 0, output: 0 },
    source: "runtime",
  }));
  const policy = Object.fromEntries(RUN_ROLES.map((role) => [role, { default: ["claude/m"] }])) as Policy;
  let unavailable: string | null = null;
  const tracker = {
    def: (id: string) => providers.find((p) => p.id === id),
    onDiscoveryChanged: () => {},
    headroom: () => 1,
    unavailableReason: () => unavailable,
    modelUnavailableReason: () => null,
    notServed: () => false,
    authToken: () => undefined,
  };
  const router = new Router(tracker as unknown as ProviderTracker, policy, models, [], ["CN"]);
  return {
    router,
    tracker,
    models,
    providers,
    policy,
    reviewTargets: { prefer: [] as string[], only: [] as string[] },
    unavailable: () => {
      unavailable = "offline";
    },
  };
}
function caps(): Capabilities {
  return {
    protocol: 1,
    release: null,
    checkpoints: [1, 2],
    os: "darwin",
    arch: "arm64",
    confinement: {
      backend: "seatbelt",
      verified: true,
      codex: { edit: true, read: true, confinedRead: true },
    },
    agents: { claude: { version: "1.0.0", loggedIn: true }, codex: { version: "1.0.0", loggedIn: true } },
    privateStrings: { parity: "match", policy: null },
    freeSlots: 1,
    power: "ac",
    draining: false,
  };
}
function gateFixture() {
  const routing = catalog();
  const data = caps();
  let now: ClockSample = { inclusive: 1_000, exclusive: 1_000 };
  let snapshot: Observed<Capabilities> | null = { at: now, value: data };
  let access: Observed<boolean> = { at: now, value: true };
  let advertAt: ClockSample | null = now;
  let slots = 1;
  let draining = false;
  const clock = { sample: mock(() => ({ ...now })) };
  const monitor: CapabilityMonitor = {
    current: mock((time) => (snapshot && windowOpen(snapshot.at, time, 60_000) ? snapshot : null)),
    refresh: mock(async () => {
      if (!snapshot) throw new Error("no snapshot");
      return snapshot;
    }),
    access: mock(async () => access),
    start: mock(() => () => {}),
  };
  const advertiser = { fresh: mock((time: ClockSample) => windowOpen(advertAt, time, 180_000)) };
  const gate = createCapabilityGate({
    ...routing,
    monitor,
    advertiser,
    cfg,
    clock,
    freeSlots: () => slots,
    draining: () => draining,
  });
  return {
    ...routing,
    gate,
    data,
    clock,
    monitor,
    advertiser,
    time: (age: number, exclusive = age) => {
      now = { inclusive: 1_000 + age, exclusive: 1_000 + exclusive };
    },
    snapshot: (value: Observed<Capabilities> | null) => {
      snapshot = value;
    },
    access: (value: Observed<boolean>) => {
      access = value;
    },
    advert: (value: ClockSample | null) => {
      advertAt = value;
    },
    live: (free: number, drain: boolean) => {
      slots = free;
      draining = drain;
    },
  };
}

test.each(["escalation", "finder", "verifier", "free", "preference"])(
  "isolated %s source requires codex",
  (source) => {
    const f = catalog();
    const t = task();
    const role = source === "escalation" || source === "preference" ? "implement" : "review";
    delete t.models?.[role];
    const codex = f.models.find((m) => m.provider === "codex");
    if (!codex) throw new Error("missing test model");
    if (source === "escalation" || source === "free") codex.source = "code";
    if (source === "free") {
      const provider = f.tracker.def("codex");
      if (provider) provider.billing = "free";
    }
    if (source === "finder") f.reviewTargets.prefer = ["codex/m"];
    if (source === "verifier") f.reviewTargets.only = ["codex/m"];
    if (source === "preference")
      t.implementer = { ref: "codex/m", policyRevision: f.router.cellRevision("implement", "small") };
    expect(taskNeeds(t, f).logins).toContain("codex");
    if (source === "preference") {
      t.implementer = { ref: "codex/m", policyRevision: "obsolete" };
      expect(taskNeeds(t, f).logins).not.toContain("codex");
    }
  },
);

test.each(["trivial", "small", "medium", "large"] as const)("visits the %s policy cell", (complexity) => {
  const f = catalog();
  f.policy.spec = { default: ["claude/m"], [complexity]: ["codex/m@high"] };
  const t = task();
  delete t.models?.spec;
  expect(taskNeeds(t, f).logins).toContain("codex");
});

test("review targets use all rosters or the override, including both verifier forms", () => {
  expect(reviewTargets(cfg)).toEqual({ prefer: ["codex/m", "claude/m"], only: [] });
  expect(reviewTargets(cfg, system)).toEqual({ prefer: ["codex/m"], only: ["codex/m@high", "codex/m@low"] });
  const f = catalog();
  const t = task();
  delete t.models?.review;
  expect(taskNeeds(t, { ...f, reviewTargets: reviewTargets(cfg, system) }).codexModes).toEqual(["read"]);
});

test.each([
  ["prepare", RUN_ROLES],
  ["triage", RUN_ROLES],
  ["clarify", RUN_ROLES.slice(1)],
  ["spec", RUN_ROLES.slice(1)],
  ["loop", RUN_ROLES.slice(2)],
  ["deliver", RUN_ROLES.slice(2)],
  ["accept", RUN_ROLES.slice(2)],
  ["done", []],
] as const)("remaining roles in %s", (phase, roles) => {
  const f = catalog();
  const t = task("claude/m", phase);
  if (t.models) t.models.triage = ["codex/m"];
  const needs = taskNeeds(t, f);
  expect(needs.roles).toEqual(roles);
  expect(needs.logins.includes("codex")).toBe(phase === "prepare" || phase === "triage");
  if (phase === "done")
    expect(needs).toMatchObject({ logins: [], versions: [], codexModes: [], unsupported: [] });
});

test("pinned chains exclude free, preference, escalation and review targets; empty is authoritative", () => {
  const f = catalog();
  f.reviewTargets = { prefer: ["claude/m"], only: ["claude/m"] };
  const t = task("codex/m");
  t.implementer = { ref: "claude/m" };
  expect(taskNeeds(t, f)).toMatchObject({ logins: ["codex"], versions: ["codex"], unsupported: [] });
  if (t.models) t.models.review = [];
  expect(taskNeeds(t, f).unsupported).toEqual(["review"]);
});

test.each(["unknown/m", "http/m", "decision/m", "codex/m@bogus", "bad provider/m", "codex/m@", ""])(
  "non-executable reference %j adds no requirement and refuses route",
  (reference) => {
    const f = catalog();
    const t = task("fake/m", "loop");
    if (t.models) t.models.implement = [reference];
    let needs: ReturnType<typeof taskNeeds> | undefined;
    expect(() => {
      needs = taskNeeds(t, f);
    }).not.toThrow();
    expect(needs).toMatchObject({ logins: [], versions: [], unsupported: ["implement"] });
    if (needs) expect(canContinue(needs, caps())).toEqual(["route"]);
  },
);

test("excluded origins, unknown providers and unsupported transport effort are dropped independently", () => {
  const f = catalog();
  f.router.setModels([...f.models, { ...f.models[0], id: "unknown/m", provider: "unknown" } as ModelDef]);
  const codex = f.models.find((m) => m.provider === "codex");
  if (codex) codex.origin = "CN";
  const t = task("fake/m");
  if (t.models) t.models.implement = ["unknown/m", "codex/m", "anthropic/m@high", "fake/m"];
  expect(taskNeeds(t, f)).toMatchObject({ logins: [], versions: [], unsupported: [] });
});

test("availability skips still contribute every harness", () => {
  const f = catalog();
  f.unavailable();
  expect(f.router.preview("implement", "small", { chain: ["codex/m"] })[0]?.eligible).toBe(false);
  expect(taskNeeds(task("codex/m"), f)).toMatchObject({
    logins: ["codex"],
    codexModes: ["read", "confinedRead", "edit"],
  });
});

test.each([
  ["triage", "http/m", [], [], []],
  ["triage", "decision/m", [], [], []],
  ["triage", "codex/m", ["codex"], ["codex"], []],
  ["implement", "codex/m@high", ["codex"], ["codex"], ["edit"]],
  ["holdout", "codex/m", ["codex"], ["codex"], ["confinedRead"]],
  ["review", "codex/m", ["codex"], ["codex"], ["read"]],
  ["review", "anthropic/m", ["claude"], [], []],
  ["review", "claude/m", ["claude"], ["claude"], []],
  ["review", "fake/m", [], [], []],
] as const)("harness requirements for %s on %s", (role, reference, versions, logins, codexModes) => {
  const t = task("fake/m");
  if (t.models) t.models[role] = [reference];
  expect(taskNeeds(t, catalog())).toMatchObject({ versions, logins, codexModes, unsupported: [] });
});

test("saved explicitly unset effort survives preview and harness validation", () => {
  const f = catalog();
  const model = f.models.find((m) => m.provider === "anthropic");
  if (model) model.effort = "high";
  const t = task("fake/m");
  delete t.models?.implement;
  f.policy.implement = { default: ["fake/m"] };
  t.implementer = { ref: { modelId: "anthropic/m", effort: null } };
  const target = spyOn(f.router, "toTarget");
  expect(taskNeeds(t, f).versions).toEqual(["claude"]);
  expect(target.mock.calls.some(([model, effort]) => model.id === "anthropic/m" && effort === null)).toBe(
    true,
  );
  t.implementer.ref = { modelId: "anthropic/m", effort: "high" };
  expect(taskNeeds(t, f).versions).toEqual([]);
});

const continuationCases: [string, CapabilityRefusal, (c: Capabilities) => void][] = [
  [
    "protocol",
    "protocol",
    (c) => {
      Object.assign(c, { protocol: 2 });
    },
  ],
  [
    "different parity",
    "parity",
    (c) => {
      c.privateStrings.parity = "differs";
    },
  ],
  [
    "unknown parity",
    "parity",
    (c) => {
      c.privateStrings.parity = "unknown";
    },
  ],
  [
    "claude login",
    "login",
    (c) => {
      c.agents.claude.loggedIn = false;
    },
  ],
  [
    "codex login",
    "login",
    (c) => {
      c.agents.codex.loggedIn = false;
    },
  ],
  [
    "claude version",
    "login",
    (c) => {
      c.agents.claude.version = null;
    },
  ],
  [
    "codex version",
    "login",
    (c) => {
      c.agents.codex.version = null;
    },
  ],
  [
    "Seatbelt verification",
    "confinement",
    (c) => {
      c.confinement.verified = false;
    },
  ],
  [
    "Seatbelt backend",
    "confinement",
    (c) => {
      c.confinement.backend = "bwrap-landlock";
    },
  ],
  [
    "edit",
    "confinement",
    (c) => {
      c.confinement.codex.edit = false;
    },
  ],
  [
    "read",
    "confinement",
    (c) => {
      c.confinement.codex.read = false;
    },
  ],
  [
    "confined read",
    "confinement",
    (c) => {
      c.confinement.codex.confinedRead = false;
    },
  ],
  [
    "Linux",
    "os",
    (c) => {
      c.os = "linux";
    },
  ],
];
test.each(continuationCases)("continuation refuses %s alone", (_name, reason, change) => {
  const t = task("codex/m");
  if (t.models) t.models.spec = ["claude/m"];
  const needs = taskNeeds(t, catalog());
  const data = caps();
  expect(canContinue(needs, data)).toEqual([]);
  change(data);
  expect(canContinue(needs, data)).toEqual([reason]);
  expect(eligible(needs, data, true)).toEqual([reason]);
});

test.each([
  [
    "checkpoint",
    (c: Capabilities) => {
      c.checkpoints = [1];
    },
  ],
  [
    "slots",
    (c: Capabilities) => {
      c.freeSlots = 0;
    },
  ],
  [
    "power",
    (c: Capabilities) => {
      c.power = "battery";
    },
  ],
  [
    "power",
    (c: Capabilities) => {
      c.power = "unknown";
    },
  ],
  [
    "draining",
    (c: Capabilities) => {
      c.draining = true;
    },
  ],
] as const)("admission alone refuses %s", (reason, change) => {
  const needs = taskNeeds({ ...task(), checkpoint: 2 }, catalog());
  const data = caps();
  change(data);
  expect(eligible(needs, data, true)).toEqual([reason]);
  expect(canContinue(needs, data)).toEqual([]);
});

test("access, omitted checkpoints, unused CLI probes, and completed Linux tasks", () => {
  const f = catalog();
  const needs = taskNeeds(task("fake/m"), f);
  const data = caps();
  data.agents = { claude: { version: null, loggedIn: false }, codex: { version: null, loggedIn: false } };
  data.confinement.codex = { edit: false, read: false, confinedRead: false };
  data.checkpoints = [];
  expect(eligible(needs, data, false)).toEqual(["access"]);
  data.os = "linux";
  data.confinement.verified = false;
  expect(canContinue(taskNeeds(task("fake/m", "done"), f), data)).toEqual([]);
});

test("construction is inert; awaited methods pass signals and continuation requires access only", async () => {
  const f = gateFixture();
  expect(f.monitor.current).not.toHaveBeenCalled();
  expect(f.monitor.start).not.toHaveBeenCalled();
  expect(f.monitor.refresh).not.toHaveBeenCalled();
  expect(f.monitor.access).not.toHaveBeenCalled();
  f.snapshot(null);
  const at = f.clock.sample();
  const refresh = spyOn(f.monitor, "refresh").mockResolvedValue({ at, value: f.data });
  f.access({ at, value: false });
  f.advert(null);
  f.live(0, true);
  f.data.power = "unknown";
  f.data.checkpoints = [];
  const signal = new AbortController().signal;
  expect(await f.gate.canContinue({ ...task(), checkpoint: 2 }, signal)).toEqual(["access"]);
  expect(refresh).toHaveBeenCalledWith(signal);
  expect(f.monitor.access).toHaveBeenCalledWith(repo, signal);
  expect(f.advertiser.fresh).not.toHaveBeenCalled();
});

test.each(["snapshot", "access"] as const)(
  "final sample catches %s expiring during either await",
  async (observation) => {
    const f = gateFixture();
    const at = f.clock.sample();
    const snapshot = Promise.withResolvers<Observed<Capabilities>>();
    const access = Promise.withResolvers<Observed<boolean>>();
    f.snapshot(null);
    f.monitor.refresh = mock(() => snapshot.promise);
    f.monitor.access = mock(() => access.promise);
    const decision = f.gate.admit(task());
    f.time(31_000);
    if (observation === "snapshot") snapshot.resolve({ at, value: f.data });
    else access.resolve({ at, value: true });
    await Promise.resolve();
    f.time(60_000);
    if (observation === "snapshot") access.resolve({ at: f.clock.sample(), value: true });
    else snapshot.resolve({ at: f.clock.sample(), value: f.data });
    expect(await decision).toEqual(["stale"]);
  },
);

test.each([31_000, 59_999, 60_000])("strict observation window at %d ms", async (age) => {
  const f = gateFixture();
  f.time(age);
  expect(await f.gate.admit(task())).toEqual(age < 60_000 ? [] : ["stale"]);
});

test.each(["snapshot", "access"] as const)("suspend invalidates the %s observation", async (observation) => {
  const f = gateFixture();
  f.time(3_000, 1_000);
  if (observation === "snapshot") f.access({ at: f.clock.sample(), value: true });
  else f.snapshot({ at: f.clock.sample(), value: f.data });
  f.advert(f.clock.sample());
  expect(await f.gate.admit(task())).toEqual(["stale"]);
});

test.each(["refresh", "access"] as const)("rejected %s observation fails closed", async (operation) => {
  const f = gateFixture();
  f.snapshot(null);
  f.monitor.refresh = mock(async () => ({ at: f.clock.sample(), value: f.data }));
  f.monitor[operation] = mock(async () => {
    throw new Error("probe failed");
  });
  expect(await f.gate.admit(task())).toEqual(["stale"]);
  expect(await f.gate.canContinue(task())).toEqual(["stale"]);
});

test("own advert must be confirmed and fresh; its payload cannot override local logout", async () => {
  const f = gateFixture();
  f.advert(null);
  expect(await f.gate.admit(task())).toEqual(["advert"]);
  f.advert(f.clock.sample());
  f.data.agents.claude.loggedIn = false;
  expect(await f.gate.admit(task())).toEqual(["login"]);
  f.data.agents.claude.loggedIn = true;
  f.time(180_000);
  f.snapshot({ at: f.clock.sample(), value: f.data });
  f.access({ at: f.clock.sample(), value: true });
  expect(await f.gate.admit(task())).toEqual(["advert"]);
  expect(await f.gate.canContinue(task())).toEqual([]);
});

test("advert expiration is evaluated at the final sample after access resolves", async () => {
  const f = gateFixture();
  f.time(179_000);
  f.snapshot({ at: f.clock.sample(), value: f.data });
  const pending = Promise.withResolvers<Observed<boolean>>();
  f.monitor.access = mock(() => pending.promise);
  const decision = f.gate.admit(task());
  expect(f.advertiser.fresh).not.toHaveBeenCalled();
  f.time(180_000);
  pending.resolve({ at: f.clock.sample(), value: true });
  expect(await decision).toEqual(["advert"]);
  expect(f.advertiser.fresh).toHaveBeenCalledWith({ inclusive: 181_000, exclusive: 181_000 });
});

test("freshness and advert share one final sample; admission reads slots and drain live", async () => {
  const f = gateFixture();
  const pending = Promise.withResolvers<Observed<boolean>>();
  f.monitor.access = mock(() => pending.promise);
  const decision = f.gate.admit(task());
  f.time(59_999);
  f.live(0, true);
  pending.resolve({ at: { inclusive: 1_000, exclusive: 1_000 }, value: true });
  f.clock.sample.mockClear();
  expect(await decision).toEqual(["slots", "draining"]);
  expect(f.clock.sample).toHaveBeenCalledTimes(1);
  expect(f.advertiser.fresh).toHaveBeenCalledWith(f.clock.sample.mock.results[0]?.value);
  f.live(1, false);
  f.data.freeSlots = 0;
  f.data.draining = true;
  expect(await f.gate.admit(task())).toEqual([]);
});

test("synchronous guard uses per-run needs, fresh local truth, and no async or routing work", async () => {
  const f = gateFixture();
  const codex = task("codex/m");
  const claude = { ...task(), runId: "other" };
  const preview = spyOn(f.router, "preview");
  expect(f.gate.capableNow("unknown")).toBe(false);
  expect(await f.gate.canContinue(codex)).toEqual([]);
  expect(await f.gate.canContinue(claude)).toEqual([]);
  preview.mockClear();
  mock.clearAllMocks();
  expect(f.gate.capableNow(codex.runId)).toBe(true);
  f.data.agents.codex.loggedIn = false;
  expect(f.gate.capableNow(codex.runId)).toBe(false);
  expect(f.gate.capableNow(claude.runId)).toBe(true);
  f.gate.forget(claude.runId);
  expect(f.gate.capableNow(claude.runId)).toBe(false);
  expect(preview).not.toHaveBeenCalled();
  expect(f.monitor.refresh).not.toHaveBeenCalled();
  expect(f.monitor.access).not.toHaveBeenCalled();
  expect(f.advertiser.fresh).not.toHaveBeenCalled();
  expect(await f.gate.canContinue({ ...task(), runId: codex.runId })).toEqual([]);
  expect(f.gate.capableNow(codex.runId)).toBe(true);
  f.time(60_000);
  expect(f.gate.capableNow(codex.runId)).toBe(false);
});

test("legacy CLI provider kinds and explicit efforts keep their requirements", () => {
  const f = catalog();
  const provider = f.tracker.def("claude");
  if (provider) delete provider.kind;
  expect(taskNeeds(task(), f).logins).toEqual(["claude"]);
  const target = spyOn(f.router, "toTarget");
  const t = task("fake/m");
  if (t.models) t.models.review = ["codex/m@high", "codex/m@low"];
  expect(taskNeeds(t, f).logins).toEqual(["codex"]);
  for (const effort of ["high", "low"]) {
    expect(target.mock.calls.some(([model, selected]) => model.id === "codex/m" && selected === effort)).toBe(
      true,
    );
  }
});

test("a preview that cannot inspect malformed grouped references refuses without throwing", () => {
  const f = catalog();
  const t = task("fake/m");
  if (t.models) t.models.review = ["codex/m|codex/m@"];
  expect(taskNeeds(t, f).unsupported).toEqual(["review"]);
});

test("gate uses the review override instead of roster targets", async () => {
  const f = gateFixture();
  f.data.agents.codex.loggedIn = false;
  const gate = createCapabilityGate({
    ...f,
    cfg,
    freeSlots: () => 1,
    draining: () => false,
    reviewSystem: { ...system, finders: [], verifier: { targets: ["anthropic/m"] } },
  });
  const t = task("fake/m");
  delete t.models?.review;
  expect(await gate.canContinue(t)).toEqual([]);
});

test("latest needs are memoized before observations finish", async () => {
  const f = gateFixture();
  expect(await f.gate.canContinue(task("fake/m"))).toEqual([]);
  f.data.agents.codex.loggedIn = false;
  const access = Promise.withResolvers<Observed<boolean>>();
  f.monitor.access = mock(() => access.promise);
  const decision = f.gate.canContinue(task("codex/m"));
  expect(f.gate.capableNow("run")).toBe(false);
  access.resolve({ at: f.clock.sample(), value: true });
  expect(await decision).toEqual(["login"]);
});
