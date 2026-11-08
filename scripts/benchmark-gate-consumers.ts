import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Context,
  consumerSign,
  consumerState,
  drainOutcome,
  eventBacklog,
  type Fn,
  field,
  type Job,
  operation,
  projectFixture,
  projectionOutcome,
  renderInputs,
  validate,
} from "../test/benchmark-gate-output-support.ts";

const call = (c: Context, name: string, ...args: unknown[]) => (c.a[name] as Fn)(...args);
const snapshot = (c: Context) => call(c, "verifier", c.checker().registry, () => c.key) as { verify: Fn };
async function projects(c: Context, name: string): Promise<Job[]> {
  const state = consumerState(Number(c.a.IDENTITY_CAP ?? 65536)),
    results = state.lastGates.map((g) => g.result);
  const supported = ["checkAndSign", "verifier", "gateIdentities", "provisionPrivacyPolicy"].every(
    (k) => typeof c.a[k] === "function",
  );
  const equivalent = (r: unknown) => call(c, "redactGateData", r);
  const op = operation(
    c.a,
    "projectGateDiagnostics",
    typeof c.a.redactGateData === "function" ? equivalent : undefined,
  );
  const baseline = op.path === "baseline-equivalent";
  const prepare = await projectFixture(c, name, state);
  return ["outward", "durable"].map((mode) => [
    `${mode}:${op.path}${baseline ? ":redactGateData; no proof enforcement" : ""}`,
    50,
    supported && op.run
      ? () => {
          if (name === "project-after-edit") {
            c.checker().registry.refreshPolicy();
            const v = snapshot(c);
            for (const r of results)
              validate(v.verify(r.textPrivacy?.output, "output", r.output) === false, "fresh proof class");
          }
          return JSON.stringify({
            ...state,
            lastGates: state.lastGates.map((g) => ({
              ...g,
              result: op.run?.(g.result, { mode, registry: c.checker().registry, signer: () => c.key }),
            })),
          });
        }
      : undefined,
    (value) => projectionOutcome(value, state, baseline || name === "project-proven", mode),
    prepare,
  ]);
}
async function events(c: Context): Promise<Job[]> {
  const event = field(c.a.RunContext, "prototype.event") as Fn | undefined;
  const input = eventBacklog(10000, false);
  let count = 0;
  const receiver = {
    store: {
      addEvent: (e: unknown) => {
        validate(
          field(e, "message") === `event-${count}` && field(e, "data.n") === count,
          "sanitizer sink order",
        );
        count++;
        return e;
      },
    },
  };
  return [
    [
      "RunContext.event:production",
      input.length,
      event
        ? () => {
            count = 0;
            for (const e of input) event.call(receiver, e);
            return count;
          }
        : undefined,
      (v) => validate(v === 10000 && count === 10000, "10000 sanitized sink events"),
    ],
  ];
}
async function drain(c: Context): Promise<Job[]> {
  const backlog = eventBacklog();
  let pages = 0,
    unsubscribed = 0;
  const store = {
    listEvents: (_id: string, o: { after: number; limit: number }) => {
      pages++;
      return backlog.slice(o.after, o.after + o.limit);
    },
    subscribe: () => () => {
      unsubscribed++;
    },
  };
  const factory = {
    store,
    cfg: { port: 0, uiUrl: "http://localhost", trustedProxies: [], publicOrigins: [], auth: "optional" },
  };
  const routes = typeof c.a.createHttpRoutes === "function" ? call(c, "createHttpRoutes", factory) : {};
  const route = field(routes, "/api/runs/:id/stream") as Fn | undefined;
  const run = async () => {
    pages = 0;
    unsubscribed = 0;
    const abort = new AbortController();
    const req = Object.assign(
      new Request("http://localhost/api/runs/synthetic/stream", { signal: abort.signal }),
      { params: { id: "synthetic" } },
    );
    const response = await route?.(req, { requestIP: () => ({ address: "127.0.0.1" }), timeout: () => {} });
    validate(
      response instanceof Response &&
        response.status === 200 &&
        response.headers.get("content-type")?.includes("text/event-stream"),
      "SSE response",
    );
    const reader = (response as Response).body?.getReader();
    validate(reader, "SSE body");
    const chunks: Uint8Array[] = [];
    let frames = 0,
      previous = 0;
    try {
      // Count only frame delimiters to know when to close; decoding and validation follow measurement.
      while (frames <= backlog.length) {
        const chunk = await reader?.read();
        validate(chunk && !chunk.done, "complete SSE backlog");
        const bytes = chunk?.value ?? new Uint8Array();
        chunks.push(bytes);
        for (let i = bytes.indexOf(10); i >= 0; i = bytes.indexOf(10, i + 1))
          if ((i ? bytes[i - 1] : previous) === 10) frames++;
        previous = bytes.at(-1) ?? previous;
      }
    } finally {
      abort.abort();
      await reader?.cancel();
    }
    return { chunks, pages, unsubscribed };
  };
  return [["/api/runs/:id/stream:production", 50000, route ? run : undefined, drainOutcome]];
}
async function feedback(c: Context): Promise<Job[]> {
  const text = ".".repeat(100000),
    available = ["checkAndSign", "verifier"].every((k) => typeof c.a[k] === "function");
  let proof: unknown;
  const prepare = async () => {
    proof = await consumerSign(c, text, "feedback");
    validate(snapshot(c).verify(proof, "feedback", text) === true, "seed feedback proof");
  };
  return [
    [
      "checkAndSign:production",
      100000,
      available ? () => consumerSign(c, text, "feedback") : undefined,
      (v) => validate(snapshot(c).verify(v, "feedback", text) === true, "feedback signed"),
      prepare,
    ],
    [
      "verifier.verify:fresh-snapshot:production",
      100000,
      available ? () => snapshot(c).verify(proof, "feedback", text) : undefined,
      (v) => validate(v === true, "feedback verified"),
      prepare,
    ],
  ];
}
function render(c: Context): Job[] {
  const state = consumerState(64),
    gates = state.lastGates;
  const inputs = renderInputs(state);
  return inputs.map(([name, input]) => [
    `${name}:production`,
    50,
    typeof c.a[name] === "function" ? () => call(c, name, input) : undefined,
    (v) => validate(typeof v === "string" && gates.every((g) => v.includes(g.name)), "50 rendered gate rows"),
  ]);
}
async function landLog(c: Context): Promise<Job[]> {
  const available = ["openLandLog", "appendLandLog", "readLandLog"].every(
    (k) => typeof c.a[k] === "function",
  );
  const path = join(c.cwd, "land.log"),
    entries = Array.from({ length: 10000 }, (_, i) => `${`entry ${i} `.padEnd(511, ".")}\n`),
    expected = entries.join("");
  const privacy = () => ({ checker: c.checker(), signer: () => c.key });
  let seeded = false;
  const append = async () => {
    const log = call(c, "openLandLog", path, "", privacy());
    for (const entry of entries) await call(c, "appendLandLog", log, [entry]);
    seeded = true;
    return path;
  };
  const check = (v: unknown) => validate(v === expected, "10000 verified entries in order");
  return [
    ["append:production", 10000, available ? append : undefined, () => check(readFileSync(path, "utf8"))],
    [
      "read-and-verify:production",
      10000,
      available ? () => call(c, "readLandLog", path, privacy()) : undefined,
      check,
      async () => {
        if (!seeded) await append();
      },
    ],
  ];
}
export const consumerRegistry: Record<string, (c: Context) => Promise<Job[]> | Job[]> = Object.fromEntries([
  ...["project-proven", "project-unproven", "project-refused", "project-after-edit"].map((name) => [
    name,
    (c: Context) => projects(c, name),
  ]),
  ["events", events],
  ["event-drain", drain],
  ["feedback-sign", feedback],
  ["render-prompts", render],
  ["land-log", landLog],
]);
