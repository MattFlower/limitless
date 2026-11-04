import {
  type Context,
  consumerSign,
  consumerState,
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
          c.checker().registry.refreshPolicy();
          const v = snapshot(c),
            expected = name === "project-proven";
          for (const r of results)
            validate(v.verify(r.textPrivacy?.output, "output", r.output) === expected, "fresh proof class");
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
    let count = 0,
      gates = 0,
      pending = "";
    try {
      while (count < backlog.length) {
        const chunk = await reader?.read();
        validate(chunk && !chunk.done, "complete SSE backlog");
        pending += new TextDecoder().decode(chunk?.value);
        let end = pending.indexOf("\n\n");
        while (end >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = frame.split("\n").find((s) => s.startsWith("data: "));
          if (data) {
            const msg = JSON.parse(data.slice(6));
            validate(
              msg.kind === "event" &&
                msg.event.id === ++count &&
                msg.event.message === `event-${count - 1}` &&
                msg.event.type === ((count - 1) % 10 ? "log" : "gate"),
              "SSE order",
            );
            if (msg.event.type === "gate") gates++;
          }
          end = pending.indexOf("\n\n");
        }
      }
    } finally {
      abort.abort();
      await reader?.cancel();
    }
    return { count, gates, pages, unsubscribed, pending };
  };
  return [
    [
      "/api/runs/:id/stream:production",
      50000,
      route ? run : undefined,
      (v) =>
        validate(
          field(v, "count") === 50000 &&
            field(v, "gates") === 5000 &&
            Number(field(v, "pages")) > 0 &&
            field(v, "unsubscribed") === 1 &&
            field(v, "pending") === "",
          "50000 ordered events; 5000 gate events; stream closed",
        ),
    ],
  ];
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
export const consumerRegistry: Record<string, (c: Context) => Promise<Job[]> | Job[]> = Object.fromEntries([
  ...["project-proven", "project-unproven", "project-refused", "project-after-edit"].map((name) => [
    name,
    (c: Context) => projects(c, name),
  ]),
  ["events", events],
  ["event-drain", drain],
  ["feedback-sign", feedback],
  ["render-prompts", render],
  [
    "land-log",
    () =>
      ["append", "read-and-verify"].map((label) => [
        `${label}:unavailable:signed-log API absent`,
        10000,
        undefined,
        () => validate(false, "signed log unavailable"),
      ]),
  ],
]);
