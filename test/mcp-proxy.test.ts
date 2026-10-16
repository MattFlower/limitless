import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResultSchema, JSONRPCResultResponseSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FeedPage, Question, Run } from "../src/core/types.ts";
import * as diagnosticCatalogue from "../src/db/owner-diagnostics.ts";
import * as gitCommand from "../src/git/command.ts";
import { cachePath } from "../src/git/repos.ts";
import { createMcpServer, type Fetch, factoryBackend, httpBackend } from "../src/integrations/mcp.ts";
import { getChange } from "../src/integrations/mcp-change.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import {
  type ChangePage,
  changeFixture,
  connect,
  fixture,
  localServer,
  type Route,
  requestWithParams,
  resultValue,
} from "./mcp-support.ts";
import { privacyTexts } from "./privacy-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
});

async function changeConnections() {
  const routes = createHttpRoutes(f.factory);
  const proxy = await connect(
    httpBackend("http://daemon.invalid", async (url, init) => {
      const parsed = new URL(url);
      const key =
        parsed.pathname === "/api/land"
          ? "/api/land"
          : parsed.pathname.endsWith("/change")
            ? "/api/runs/:id/change"
            : parsed.pathname.endsWith("/review")
              ? "/api/runs/:id/review"
              : "/api/runs/:id";
      const route = routes[key];
      const handler = (
        typeof route === "function" ? route : (route as Record<string, Route>)[init?.method ?? "GET"]
      ) as Route;
      return handler(requestWithParams(url, init, { id: parsed.pathname.split("/")[3] ?? "" }), localServer);
    }),
  );
  const direct = await connect(factoryBackend(f.factory));
  return {
    proxy,
    direct,
    async close() {
      await proxy.close();
      await direct.close();
    },
  };
}

test("MCP approvals retain optional normalized consumer provenance on both backends", async () => {
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" }, true);
  f.factory.deps.gh = async () =>
    JSON.stringify({
      state: "OPEN",
      headRefOid: c.headSha,
      headRefName: "limitless/feature",
      isCrossRepository: false,
      headRepositoryOwner: { login: "test" },
      headRepository: { name: "repo" },
      autoMergeRequest: null,
    });
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      for (const consumer of [" agent-a ", "x".repeat(200), undefined]) {
        const result = resultValue<{ approval: { sha: string } }>(
          await conn.client.callTool({
            name: "limitless_review",
            arguments: {
              run: c.run.id,
              verdict: "approve",
              reviewedSha: c.headSha,
              ...(consumer === undefined ? {} : { consumer }),
            },
          }),
        );
        const reviewer = consumer === undefined ? "mcp" : `mcp:${consumer.trim()}`;
        expect(result.approval.sha).toBe(c.headSha);
        expect(
          f.factory.store.db.query("SELECT reviewer FROM review_approvals ORDER BY id DESC LIMIT 1").get(),
        ).toEqual({ reviewer });
        const feed = f.factory.store
          .readFeed({ limit: 100 })
          .items.filter((item) => item.kind === "review.approved");
        expect(feed.at(-1)?.data.reviewer).toBe(reviewer);
      }
    }
  } finally {
    await connections.close();
  }
});

test.each([
  "pagination pins",
  "unknown file index",
  "superseded pinned head",
  "superseded snapshot",
  "missing head commit",
  "missing base commit",
])("change-view refusals identify %s on both backends", async (failure) => {
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
  const connections = await changeConnections();
  const pin = { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha };
  const missing = "d".repeat(40);
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      c.observe(c.headSha);
      let args: Record<string, unknown> = pin;
      let reason: string;
      switch (failure) {
        case "pagination pins":
          args = { run: c.run.id, file: 1 };
          reason = "Further reads require headSha and baseSha from the first page.";
          break;
        case "unknown file index":
          args = { ...pin, file: 1 };
          reason = "Unknown file index 1; change has 1 files.";
          break;
        case "superseded pinned head":
          c.observe(c.baseSha);
          reason = `PR head superseded; current head ${c.baseSha}; restart limitless_get_change.`;
          break;
        case "superseded snapshot":
          f.factory.store.observePrHead(c.prUrl, c.baseSha);
          reason = `PR head superseded; current head ${c.baseSha}; restart limitless_get_change.`;
          break;
        case "missing head commit":
          c.observe(missing);
          args = { run: c.run.id };
          reason = `Required commit ${missing} unavailable in local cache.`;
          break;
        default:
          args = { ...pin, baseSha: missing };
          reason = `Required commit ${missing} unavailable in local cache.`;
      }
      const result = await conn.client.callTool({ name: "limitless_get_change", arguments: args });
      if (failure === "pagination pins") {
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: reason }]);
      } else expect(resultValue<unknown>(result)).toEqual({ available: false, reason });
      expect(JSON.stringify(result)).not.toMatch(/fatal:|bad object|Change view request failed/);
    }
  } finally {
    await connections.close();
  }
});

test("HTTP-backed change pages match direct MCP for the pinned code and report", async () => {
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
  const connections = await changeConnections();
  const pin = { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha };
  try {
    for (const args of [pin, { ...pin, reportOffset: 4000 }]) {
      const read = (conn: typeof connections.direct) =>
        conn.client.callTool({ name: "limitless_get_change", arguments: args });
      const direct = resultValue<ChangePage>(await read(connections.direct));
      expect(resultValue<ChangePage>(await read(connections.proxy))).toEqual(direct);
      expect(direct).toMatchObject({
        headSha: c.headSha,
        baseSha: c.baseSha,
        files: [{ path: "hello.txt", additions: 1, deletions: 1 }],
      });
      expect(direct.diff.text).toContain("-hello\n+new greeting\n");
    }
    c.observe(c.baseSha);
    expect(
      resultValue(
        await connections.proxy.client.callTool({
          name: "limitless_get_change",
          arguments: { ...pin, diffOffset: 1 },
        }),
      ),
    ).toMatchObject({ available: false, reason: expect.stringContaining("superseded") });
  } finally {
    await connections.close();
  }
});

test("an ordinary holdout unrelated to the diff leaves code, hunk ranges and report intact", async () => {
  const c = await changeFixture(f, {
    "hello.txt": "hello\nnew greeting\n",
    "src/count.ts": "export const publicCounterName = 3;\n",
  });
  const report = [
    "AC-1 met: src/count.ts sets the limit to 3 (verified at 100%).",
    "## Checks",
    "lint: bun run lint — Passed",
    "typecheck: bun run typecheck — All checks passed.",
    "Build complete.",
  ].join("\n");
  f.factory.store.setRunState(c.run.id, {
    spec: {
      summary: "Add src/count.ts with a word limit of 3.",
      assumptions: [],
      requirements: ["Export the limit from src/count.ts."],
      acceptance_criteria: [{ id: "AC-1", criterion: "The limit is 3.", how_to_verify: "bun test" }],
      out_of_scope: [],
      blocking_questions: [],
    },
    lastVerify: {
      notes: "Passed",
      criteria: [
        {
          id: "AC-1",
          evidence: "Observed 'publicCounterName' in the public criterion.",
          publicSummary: "",
          status: "met",
          gateEvidence: { check: "lint", command: "bun run lint" },
        },
      ],
    },
    verifyResults: [
      {
        notes: "All checks passed.",
        modelOutput: { notes: "Build complete." },
        criteria: [{ id: "H-1", gateEvidence: { check: "typecheck", command: "bun run typecheck" } }],
      },
    ],
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: "Count words in src/count.ts with 2 inputs and a limit of 3.",
          steps: "Run wc --verbose on fixtures/words.txt with maxWords set to 42.",
          expected: "Prints 2 lines and exits 0.",
          edge_case: false,
        },
      ],
    },
  });
  f.factory.store.putArtifact(c.run.id, "report.md", "report", report);
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const read = async (file: number) =>
        resultValue<ChangePage>(
          await conn.client.callTool({
            name: "limitless_get_change",
            arguments: { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha, file },
          }),
        );
      const first = await read(0);
      expect(first.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
        ["hello.txt", 1, 0],
        ["src/count.ts", 1, 0],
      ]);
      // "2" is a private holdout literal, yet Git's hunk range and the code stay readable.
      expect(first.diff.text).toContain("@@ -1 +1,2 @@\n hello\n+new greeting\n");
      expect((await read(1)).diff.text).toContain("+export const publicCounterName = 3;\n");
      expect(first.reports[0]?.text).toBe(report);
      for (const text of [first.diff.text, (await read(1)).diff.text, first.reports[0]?.text])
        expect(text).not.toMatch(/private detail|withheld/);
    }
  } finally {
    await connections.close();
  }
});

test("shared holdout words leave PR code visible while holdout-only reports stay private", async () => {
  const code = "hello\nconst maxWords = 42;\nconst uppercase = true;\nconst total = 420;\n";
  const c = await changeFixture(f, {
    "hello.txt": code,
    "src/uppercase.ts": "export const uppercase = true;\n",
  });
  const hidden = "hiddenTestOnlySentinel";
  writeFileSync(join(f.repo, "hidden.test.ts"), `expect(uppercase('${hidden}')).toBe('PRIVATE');`);
  f.factory.store.setRunState(c.run.id, {
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: 'Use maxWords of 42 with "uppercase".',
          steps: `Read hidden.test.ts with '${hidden}'.`,
          expected: "Done.",
          edge_case: false,
        },
      ],
    },
    lastVerify: {
      criteria: [
        { id: "H-1", evidence: "Observed 'holdoutResultOnlySentinel'." },
        { id: "H-2", evidence: "Verifier saw the amber lantern glow." },
      ],
    },
  });
  f.factory.store.putArtifact(
    c.run.id,
    "report.md",
    "report",
    [
      "Unrelated implementation summary.",
      `Quoted hidden test: ${hidden}`,
      "Observed holdoutResultOnlySentinel.",
      "Quoted result: Verifier saw the amber lantern glow.",
      "H-1 met outside the section.",
      "## Holdout scenarios",
      "H-1 met: clipped private output",
      "",
      "## Checks",
      "Public checks passed.",
    ].join("\n"),
  );
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<ChangePage>(
        await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
      );
      expect(page.diff.text).toContain(
        "+const maxWords = 42;\n+const uppercase = true;\n+const total = 420;\n",
      );
      const added = resultValue<ChangePage>(
        await conn.client.callTool({
          name: "limitless_get_change",
          arguments: {
            run: c.run.id,
            headSha: c.headSha,
            baseSha: c.baseSha,
            file: 1,
          },
        }),
      );
      expect(added.diff.text).toContain("+export const uppercase = true;");
      expect(page.files.map((file) => file.path)).toEqual(["hello.txt", "src/uppercase.ts"]);
      expect(JSON.stringify(page)).not.toMatch(
        /hiddenTestOnlySentinel|holdoutResultOnlySentinel|amber lantern|H-1|clipped private output/,
      );
      expect(page.reports[0]?.text).toContain("Unrelated implementation summary.");
      expect(page.reports[0]?.text).toContain("Public checks passed.");
      expect(page.reports[0]?.text).toContain("[withheld: holdout result or quotation; 1 line]");
      expect(page.reports[0]?.text).toMatch(/\[withheld: holdout section; 1 section, \d+ lines\]/);
      const tools = await conn.client.listTools();
      expect(tools.tools.find((tool) => tool.name === "limitless_get_change")?.description).toMatch(
        /PR diff text.*holdout-only.*reason and count/,
      );
    }
  } finally {
    await connections.close();
  }
});

test.each([
  ["\n", " "],
  ["\\n", " "],
  ["\\r\\n", " "],
  ["\\u000a", " "],
  ["\n", "\n"],
  ["\n", "\\n"],
  ["\n", "\\u000a"],
])("wrapped holdout quotations stay private (report: %j, verifier: %j)", async (separator, evidenceSpace) => {
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
  f.factory.store.setRunState(c.run.id, {
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: "Exercise private behavior.",
          steps: "Run the check.",
          expected: "Done.",
          edge_case: false,
        },
      ],
    },
    lastVerify: {
      criteria: [{ id: "H-1", evidence: ["the", "amber", "lantern", "glows"].join(evidenceSpace) }],
    },
  });
  f.factory.store.putArtifact(
    c.run.id,
    "report.md",
    "report",
    `Quoted result: the amber lantern${separator}glows\nPublic checks passed.`,
  );
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<ChangePage>(
        await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
      );
      const withheld = "[withheld: holdout result or quotation; 1 line]\n";
      expect(page.reports[0]?.text).toBe(
        `${withheld.repeat(separator === "\n" ? 2 : 1)}Public checks passed.`,
      );
    }
  } finally {
    await connections.close();
  }
});

test.each(["\n", "\r\n", "\\n", "\\r\\n", "\\u000a"])(
  "overlapping and mid-word private quotations are withheld (%j)",
  async (separator) => {
    const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
    f.factory.store.setRunState(c.run.id, {
      holdout: {
        scenarios: [
          { id: "H-1", description: "Private behavior", steps: "Run it", expected: "Done", edge_case: false },
        ],
      },
      lastVerify: {
        criteria: [
          { id: "H-1", evidence: "amber lantern", publicSummary: "lantern glows ultraviolet" },
          { id: "unknown", evidence: "the amber lantern glows" },
        ],
      },
    });
    f.factory.store.putArtifact(
      c.run.id,
      "report.md",
      "report",
      `amber${separator}lantern${separator}glows ultraviolet\nPublic neighbor\nthe amber lan${separator}tern glows\nPublic ending`,
    );
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        const text = page.reports[0]?.text ?? "";
        expect(text).not.toMatch(/amber|lantern|glows|ultraviolet|tern/);
        expect(text).toContain("Public neighbor");
        expect(text).toContain("Public ending");
      }
    } finally {
      await connections.close();
    }
  },
);

function privateReportState(phrase: string): Parameters<typeof renderReport>[0]["state"] {
  return {
    spec: {
      summary: "Public task",
      assumptions: [],
      requirements: [],
      out_of_scope: [],
      blocking_questions: [],
      acceptance_criteria: [{ id: "AC-1", criterion: "Public criterion", how_to_verify: "Run checks" }],
    },
    holdout: {
      scenarios: [
        { id: "H-1", description: "Private behavior", steps: "Run it", expected: "Done", edge_case: false },
      ],
    },
    lastVerify: {
      modelId: "verifier",
      overall: "fail",
      notes: "",
      criteria: [
        { id: "H-1", status: "unmet", requirement: "request", evidence: phrase, publicSummary: phrase },
      ],
    },
  };
}

async function renderedPages(
  state: Parameters<typeof renderReport>[0]["state"],
  check: (text: string) => void,
  prepare?: (runId: string) => void,
) {
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
  f.factory.store.setRunState(c.run.id, state);
  prepare?.(c.run.id);
  f.factory.store.putArtifact(
    c.run.id,
    "report.md",
    "report",
    renderReport({
      success: false,
      runId: c.run.id,
      prompt: "Public request",
      state,
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
      runUrl: "u",
    }),
  );
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      let text = "";
      let offset = 0;
      do {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({
            name: "limitless_get_change",
            arguments: {
              run: c.run.id,
              headSha: c.headSha,
              baseSha: c.baseSha,
              reportOffset: offset,
            },
          }),
        );
        const report = page.reports[0];
        if (!report) throw new Error("Missing report");
        text += report.text;
        offset = report.nextOffset ?? 0;
      } while (offset);
      check(text);
    }
  } finally {
    await connections.close();
  }
}

const quotationForms = [
  ["plain", "red owl", "red owl"],
  ["link", "red owl", "[red owl](u)"],
  ["image", "red owl", "![red owl](u)"],
  ["emphasis", "red owl", "**red** _owl_"],
  ["code", "red owl", "`red owl`"],
  ["blockquote", "red owl", "> red\n> owl"],
  ["list", "red owl", "- red\n- owl"],
  ["table", "red owl", "| red owl |"],
  ["numeric entity", "red owl", "&#114;ed owl"],
  ["hex entity", "red owl", "&#x72;ed owl"],
  ["named entity", "red & owl", "red &amp; owl"],
  ["named whitespace", "red owl", "red&NewLine;owl"],
  ["wrap", "red owl", "red\nowl"],
  ["mid-word", "red owl", "red o\nwl"],
  ["escaped pipe", "the amber|lantern glows", "the amber|lantern glows"],
  ["long quoted wrap", "the amber lantern glows ultraviolet", "> the amber lan\n> tern glows ultraviolet"],
  ["wrapped label", "the amber lantern glows ultraviolet", "![the amber lan\ntern glows ultraviolet](u)"],
];

test.each(quotationForms)(
  "author backstops withhold %s quotations in rendered reports",
  async (_form, phrase = "", quotation = "") => {
    const state = privateReportState(phrase);
    state.implementerReport = `${quotation}\nUnrelated summary neighbor`;
    state.terminalReason = quotation;
    state.lastVerify?.criteria.push({ id: "AC-1", status: "met", evidence: quotation, publicSummary: "" });
    await renderedPages(state, (text) => {
      expect(text).not.toMatch(/red|owl|amber|lantern|ultraviolet|Private behavior|&#|&amp;/);
      expect(text).not.toContain("AC-1");
      expect(text).not.toContain("🚧");
      expect(text).toContain("## Implementer's summary\n\n[withheld:");
      expect(text).toContain("Unrelated summary neighbor");
      expect(text).toContain("## Checks");
    });
  },
);

test.each(["implementer", "verifier"] as const)(
  "gap 4 generic evidence follows %s provenance",
  async (author) => {
    const phrase = "All checks passed.";
    const state = privateReportState(phrase);
    const privateRow = state.lastVerify?.criteria[0];
    if (!privateRow || !state.spec) throw new Error("Missing fixture rows");
    privateRow.status = "met";
    privateRow.publicSummary = "";
    state.implementerReport = `Ordinary build status: ${phrase}`;
    state.lastReview = {
      modelId: "reviewer",
      verdict: "approve",
      summary: `Ordinary review: ${phrase}`,
      findings: [],
    };
    if (author === "verifier") {
      state.spec.assumptions = [`Ordinary assumption: ${phrase}`];
      state.lastVerify?.criteria.push({ id: "AC-1", status: "met", evidence: phrase, publicSummary: "" });
      state.terminalReason = phrase;
    }
    await renderedPages(state, (text) => {
      expect(text).toContain(`Ordinary build status: ${phrase}`);
      expect(text).toContain(`Ordinary review: ${phrase}`);
      expect(text).not.toContain("Private behavior");
      if (author === "verifier") {
        expect(text).toContain(`Ordinary assumption: ${phrase}`);
        expect(text).not.toContain("AC-1");
        expect(text).not.toContain(`🚧 ${phrase}`);
      }
    });
  },
);

test.each(["unknown row", "notes", "no holdout"])(
  "private verifier material without scenarios: %s",
  async (source) => {
    const state = privateReportState("red owl");
    state.holdout = source === "no holdout" ? undefined : { scenarios: [] };
    if (!state.lastVerify) throw new Error("Missing verifier");
    state.lastVerify.criteria[0] = { id: "unknown", status: "unmet", evidence: "red owl", publicSummary: "" };
    if (source === "notes") {
      state.lastVerify.criteria = [];
      state.lastVerify.notes = "red owl";
    }
    state.lastVerify.criteria.push({
      id: "AC-1",
      status: "met",
      evidence: "[red owl](u)",
      publicSummary: "",
    });
    state.terminalReason = "![red owl](u)";
    await renderedPages(state, (text) => {
      expect(text).not.toContain("red owl");
      expect(text).not.toContain("AC-1");
      expect(text).toContain("## Checks");
    });
  },
);

test.each(["\n", "\r\n", "\\n", "\\r\\n", "\\u000a"])(
  "marked author spans withhold overlapping phrases (%j)",
  async (separator) => {
    const state = privateReportState("amber lantern");
    state.holdout?.scenarios.push({
      id: "H-2",
      description: "Second private behavior",
      steps: "Run it",
      expected: "Done",
      edge_case: false,
    });
    state.lastVerify?.criteria.push({
      id: "H-2",
      status: "unmet",
      requirement: "request",
      evidence: "lantern glows ultraviolet",
      publicSummary: "lantern glows ultraviolet",
    });
    const quote = `amber${separator}lantern${separator}glows ultraviolet`;
    state.implementerReport = `${quote}\nUnrelated summary neighbor`;
    state.terminalReason = quote;
    state.lastVerify?.criteria.push({ id: "AC-1", status: "met", evidence: quote, publicSummary: "" });
    await renderedPages(state, (text) => {
      expect(text).not.toMatch(/amber|lantern|glows|ultraviolet/);
      expect(text).toContain("Unrelated summary neighbor");
      expect(text).toContain("## Checks");
    });
  },
);

test.each(["summary", "notes"])(
  "unreceived diagnostic %s stays visible only in other authors' prose",
  async (source) => {
    const state = privateReportState("A separate private observation");
    if (!state.lastVerify) throw new Error("Missing verifier");
    state.lastVerify.criteria = [
      { id: "AC-1", status: "met", evidence: "All checks passed.", publicSummary: "" },
    ];
    state.implementerReport = "Ordinary build status: All checks passed.";
    await renderedPages(
      state,
      (text) => {
        expect(text).toContain("Ordinary build status: All checks passed.");
        expect(text).not.toContain("AC-1");
      },
      (runId) => {
        const invocation = f.factory.store.createInvocation({
          runId,
          stageId: null,
          role: "verify",
          harness: "fake",
          provider: "fake",
          model: "test",
          modelId: "fake/m",
        });
        f.factory.store.recordOwnerDiagnostic(
          {
            runId,
            invocationId: invocation.id,
            kind: "result",
            text: JSON.stringify(
              source === "notes"
                ? { notes: "All checks passed." }
                : {
                    criteria: [
                      {
                        id: "H-1",
                        status: "unmet",
                        requirement: "request",
                        publicSummary: "All checks passed.",
                      },
                    ],
                  },
            ),
          },
          "Private diagnostic",
        );
      },
    );
  },
);

test.each(["summary", "unbroken summary", "wrapped summary", "cell"])(
  "clipping never reveals private prefixes in a %s",
  async (field) => {
    const phrase =
      field === "cell"
        ? `the amber lantern glows ultraviolet ${"a long private observation of hidden behavior. ".repeat(10)}`
        : "the amber lantern glows ultraviolet";
    const state = privateReportState(phrase);
    if (field === "summary") state.implementerReport = `${"x".repeat(4979)}\n${phrase}`;
    else if (field === "unbroken summary") state.implementerReport = `${"x".repeat(4979)} ${phrase}`;
    else if (field === "wrapped summary")
      state.implementerReport = `Visible start\n${"x".repeat(4960)}\n> the amber\n> lantern glows ultraviolet`;
    else state.lastVerify?.criteria.push({ id: "AC-1", status: "met", evidence: phrase, publicSummary: "" });
    await renderedPages(state, (text) => {
      expect(text).not.toContain("amber");
      for (let i = 0; i + 40 <= phrase.length; i++) expect(text).not.toContain(phrase.slice(i, i + 40));
      if (field === "wrapped summary") expect(text).toContain("Visible start");
      expect(text).toContain("## Checks");
    });
  },
);

test.each([
  ["a generated <br>", `${"x".repeat(280)} the amber lantern\nglows ultraviolet`],
  ["an entity", `${"x".repeat(278)} the amber lantern &#103;lows ultraviolet`],
  [
    "a link target",
    `${"x".repeat(250)} [the amber lantern glows ultraviolet](https://example.com/${"p".repeat(40)})`,
  ],
])("a cell clipped inside %s never reveals a private prefix", async (_syntax, evidence) => {
  const state = privateReportState("the amber lantern glows ultraviolet");
  state.lastVerify?.criteria.push({ id: "AC-1", status: "met", evidence, publicSummary: "" });
  await renderedPages(state, (text) => {
    expect(text).not.toMatch(/amber|lantern/);
    expect(text).toContain("## Checks");
  });
});

test("clipped public evidence without private text stays visible", async () => {
  const evidence = `Ran bun test; observed ${"ordinary public output line. ".repeat(15)}`;
  const state = privateReportState("the amber lantern glows ultraviolet");
  state.lastVerify?.criteria.push({ id: "AC-1", status: "met", evidence, publicSummary: "" });
  await renderedPages(state, (text) => {
    expect(text).toContain(
      "| ✅ AC-1 | Public criterion | Ran bun test; observed ordinary public output line.",
    );
    expect(text).not.toContain("amber");
  });
});

test("public evidence quoting one sentence of a holdout description is withheld", async () => {
  const state = privateReportState("red owl");
  const scenario = state.holdout?.scenarios[0];
  if (!scenario) throw new Error("Missing scenario");
  scenario.description =
    "The cache warms before the scheduler starts. Stale ledger entries are evicted at midnight.";
  state.lastVerify?.criteria.push({
    id: "AC-1",
    status: "met",
    evidence: "Observed: stale ledger entries are evicted at midnight.",
    publicSummary: "",
  });
  state.terminalReason = "Stale ledger entries are evicted at midnight.";
  await renderedPages(state, (text) => {
    expect(text).not.toMatch(/ledger|midnight/i);
    expect(text).toContain("## Checks");
  });
});

test.each(["red owl", "All checks passed."])(
  "rendered private rows with %j evidence are withheld by structure",
  async (evidence) => {
    const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
    const state: Parameters<typeof renderReport>[0]["state"] = {
      implementerReport: "Quoted: red owl\nUnrelated summary neighbor",
      spec: {
        summary: "Public task",
        assumptions: [],
        requirements: [],
        out_of_scope: [],
        blocking_questions: [],
        acceptance_criteria: [{ id: "AC-1", criterion: "Public criterion", how_to_verify: "Run checks" }],
      },
      holdout: {
        scenarios: [
          { id: "H-1", description: "Private behavior", steps: "Run it", expected: "Done", edge_case: false },
        ],
      },
      lastVerify: {
        modelId: "verifier",
        overall: "pass",
        notes: "",
        criteria: [
          { id: "AC-1", status: "met", evidence: "All checks passed.", publicSummary: "" },
          { id: "H-1", status: "unmet", requirement: "request", evidence, publicSummary: "red owl" },
        ],
      },
    };
    f.factory.store.setRunState(c.run.id, state);
    const report = renderReport({
      success: true,
      runId: c.run.id,
      prompt: "Public request",
      state,
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
      runUrl: "u",
    });
    f.factory.store.putArtifact(c.run.id, "report.md", "report", report);
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        const text = page.reports[0]?.text ?? "";
        if (evidence === "red owl") expect(text).toContain("Public criterion | All checks passed.");
        else expect(text).not.toContain("All checks passed.");
        expect(text).not.toContain("red owl");
        expect(text).not.toContain("Private behavior");
        expect(text).toContain("## Checks");
        expect(text).toContain("Unrelated summary neighbor");
      }
      for (const damaged of [
        report.replace("limitless-report:v2:", "limitless-report:broken:"),
        report.replace("limitless-report:v2:", "limitless-report:v99:"),
        report.slice(0, -5),
        report.replace("Public criterion", "Changed criterion"),
        report.replace(/\n<!-- limitless-report:v2:.* -->\n$/u, ""),
      ]) {
        f.factory.store.putArtifact(c.run.id, "report.md", "report", damaged);
        for (const conn of [connections.direct, connections.proxy]) {
          const page = resultValue<ChangePage>(
            await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
          );
          const text = page.reports[0]?.text ?? "";
          expect(text).not.toContain("red owl");
          expect(text).not.toContain("Private behavior");
          expect(text).toContain("withheld");
          if (damaged.includes("limitless-report:"))
            expect(text).toBe("[withheld: invalid report structure]");
        }
      }
    } finally {
      await connections.close();
    }
  },
);

test.each(["evidence", "publicSummary"] as const)(
  "public acceptance evidence quoting private %s stays withheld in marked reports",
  async (field) => {
    const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
    const privateProse = "All checks passed. The amber lantern glows.";
    const state: Parameters<typeof renderReport>[0]["state"] = {
      spec: {
        summary: "Public task",
        assumptions: [],
        requirements: [],
        out_of_scope: [],
        blocking_questions: [],
        acceptance_criteria: [
          { id: "AC-1", criterion: "Public criterion", how_to_verify: "Run checks" },
          { id: "AC-2", criterion: "Unrelated criterion", how_to_verify: "Run checks" },
        ],
      },
      holdout: {
        scenarios: [
          { id: "H-1", description: "Private behavior", steps: "Run it", expected: "Done", edge_case: false },
        ],
      },
      lastVerify: {
        modelId: "verifier",
        overall: "pass",
        notes: "",
        criteria: [
          { id: "AC-1", status: "met", evidence: `Quoted: ${privateProse}`, publicSummary: "" },
          { id: "AC-2", status: "met", evidence: "All checks passed.", publicSummary: "" },
          {
            id: "H-1",
            status: "met",
            evidence: "All checks passed.",
            publicSummary: "All checks passed.",
            [field]: privateProse,
          },
        ],
      },
    };
    f.factory.store.setRunState(c.run.id, state);
    f.factory.store.putArtifact(
      c.run.id,
      "report.md",
      "report",
      renderReport({
        success: true,
        runId: c.run.id,
        prompt: "Public request",
        state,
        invocations: [],
        totals: { costUsd: 0, costEquivUsd: 0 },
        runUrl: "u",
      }),
    );
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        const text = page.reports[0]?.text ?? "";
        expect(text).not.toContain("amber lantern");
        expect(text).not.toContain("Quoted:");
        expect(text).not.toContain("Unrelated criterion | All checks passed.");
        expect(text).toContain("## Checks");
      }
    } finally {
      await connections.close();
    }
  },
);

test("marked reports still filter model prose and withhold private spans before pagination", async () => {
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
  const state: Parameters<typeof renderReport>[0]["state"] = {
    implementerReport: `${"Readable summary line\n".repeat(220)}Quoted: red owl\nReadable neighbor\nthe amber lan\ntern glows\nReadable ending`,
    holdout: {
      scenarios: [
        { id: "H-1", description: "Private behavior", steps: "Run it", expected: "Done", edge_case: false },
      ],
    },
    lastVerify: {
      modelId: "verifier",
      overall: "pass",
      notes: "",
      criteria: [
        {
          id: "H-1",
          status: "unmet",
          requirement: "request",
          evidence: "red owl",
          publicSummary: "the amber lantern glows",
        },
      ],
    },
  };
  f.factory.store.setRunState(c.run.id, state);
  f.factory.store.putArtifact(
    c.run.id,
    "report.md",
    "report",
    renderReport({
      success: true,
      runId: c.run.id,
      prompt: "Public request",
      state,
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
      runUrl: "u",
    }),
  );
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      let text = "";
      let offset = 0;
      do {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({
            name: "limitless_get_change",
            arguments: { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha, reportOffset: offset },
          }),
        );
        const report = page.reports[0];
        if (!report) throw new Error("Missing report");
        text += report.text;
        offset = report.nextOffset ?? 0;
      } while (offset);
      expect(text).not.toMatch(/amber|tern glows|Private behavior|limitless-report:/);
      expect(text).toContain("Quoted: red owl");
      expect(text).toContain("Readable neighbor");
      expect(text).toContain("Readable ending");
      expect(text).toContain("## Checks");
      expect(text).toContain("[withheld: holdout section;");
    }
  } finally {
    await connections.close();
  }
});

test("malformed criterion IDs and generic evidence leave unrelated report lines public", async () => {
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
  f.factory.store.setRunState(c.run.id, {
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: "Exercise private behavior.",
          steps: "Run the check.",
          expected: "Done.",
          edge_case: false,
        },
      ],
    },
    lastVerify: {
      criteria: [
        { id: "a", evidence: "Passed" },
        { id: "1", publicSummary: "All done" },
        { id: "H-2", evidence: "Congratulations" },
        { id: " h-1 ", evidence: "the amber lantern glows" },
        { id: "unknown", evidence: "the violet beacon shines" },
      ],
    },
  });
  const publicLines =
    "All gates passed\n2 files changed\na public change\n1 public check: All done\nCongratulations H-2 check";
  f.factory.store.putArtifact(
    c.run.id,
    "report.md",
    "report",
    `${publicLines}\nH-1 met\nthe amber lantern glows\nthe violet beacon shines`,
  );
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<ChangePage>(
        await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
      );
      expect(page.reports[0]?.text).toBe(
        publicLines + "\n[withheld: holdout result or quotation; 1 line]".repeat(3),
      );
    }
  } finally {
    await connections.close();
  }
});

test("short literals in multiline holdout fields stay private in reports and visible in PR patches", async () => {
  const content =
    'const label = "xq-77";\nconst shortLabel = "qv";\nrun --dry a/b\nexit 3\nconst val9 = true;\nreadable ending\n';
  const c = await changeFixture(f, { "hello.txt": content });
  f.factory.store.setRunState(c.run.id, {
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: 'Inspect output.\nIt contains "xq-77" and "qv".',
          steps: "Run check.\nUse --dry on a/b before checking.",
          expected: "Exit 3 with val9 set.",
          edge_case: false,
        },
      ],
    },
  });
  f.factory.store.putArtifact(c.run.id, "report.md", "report", content);
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<ChangePage>(
        await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
      );
      expect(page.available).toBe(true);
      expect(page.diff.text).toContain('+const label = "xq-77";');
      expect(page.diff.text).toContain('+const shortLabel = "qv";');
      expect(page.diff.text).toContain("+run --dry a/b");
      expect(page.diff.text).toContain("+exit 3");
      expect(page.diff.text).toContain("+const val9 = true;");
      const text = page.reports[0]?.text;
      expect(text).toContain("[withheld: holdout result or quotation; 1 line]");
      expect(text).toContain("readable ending");
      expect(text).not.toMatch(/xq-77|qv|--dry|a\/b|exit 3|val9/);
    }
  } finally {
    await connections.close();
  }
});

test("files absent from the pinned PR head cannot expose hidden test diffs", async () => {
  const hidden = "hiddenDeletedTestSentinel";
  writeFileSync(join(f.repo, "hidden.test.ts"), `expect('${hidden}').toBe('private result');\n`);
  await sh(["git", "add", "hidden.test.ts"], { cwd: f.repo });
  await sh(["git", "commit", "-qm", "base test"], { cwd: f.repo });
  rmSync(join(f.repo, "hidden.test.ts"));
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
  f.factory.store.setRunState(c.run.id, {
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: `Use '${hidden}'.`,
          steps: "Run test.",
          expected: "Done.",
          edge_case: false,
        },
      ],
    },
  });
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<ChangePage>(
        await conn.client.callTool({
          name: "limitless_get_change",
          arguments: {
            run: c.run.id,
            headSha: c.headSha,
            baseSha: c.baseSha,
            file: 1,
          },
        }),
      );
      expect(page.files[1]?.path).toBe("hidden.test.ts");
      expect(page.diff.text).toBe("[withheld: file absent from PR head; 1 file, 1 lines]");
      expect(JSON.stringify(page)).not.toMatch(/hiddenDeletedTestSentinel|private result|expect\(/);
    }
  } finally {
    await connections.close();
  }
});

test.each(["maxWords", "cafe\u0301"])(
  "encoded holdout literal %s is visible in PR paths and patches but withheld in reports",
  async (literal) => {
    const percent = [...Buffer.from(literal)]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");
    const unicode = [...literal].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const c = await changeFixture(f, {
      "hello.txt": `hello\n${percent}\n`,
      "unicode.txt": `const label = "${unicode}";\n`,
      [`${percent}.txt`]: "path\n",
    });
    f.factory.store.setRunState(c.run.id, {
      holdout: {
        scenarios: [
          {
            id: "H-1",
            description: `Use "${literal}".`,
            steps: "Run it.",
            expected: "Done.",
            edge_case: false,
          },
        ],
      },
    });
    f.factory.store.putArtifact(c.run.id, "report.md", "report", `Saw ${unicode} and ${percent}.`);
    const connections = await changeConnections();
    const pin = { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha };
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const read = async (file: number) =>
          resultValue<ChangePage>(
            await conn.client.callTool({ name: "limitless_get_change", arguments: { ...pin, file } }),
          );
        const first = await read(0);
        expect(first.files).toHaveLength(3);
        const pages = [first, await read(1), await read(2)];
        expect(first.files.map((file) => file.path)).toContain(`${percent}.txt`);
        expect(pages.some((page) => page.diff.text.includes(percent))).toBe(true);
        expect(pages.some((page) => page.diff.text.includes(unicode))).toBe(true);
        const report = first.reports[0]?.text ?? "";
        for (const secret of [percent, unicode, literal, literal.normalize("NFKC")])
          expect(report).not.toContain(secret);
        expect(report).toBe("[withheld: holdout result or quotation; 1 line]");
      }
    } finally {
      await connections.close();
    }
  },
);

test.each([2, 3])(
  "change pages expose %i-line PR prose but protect its holdout quotation in reports",
  async (length) => {
    const prose = [
      "Walk along the shoreline",
      "until the lantern turns violet",
      "and listen for the distant bell",
    ].slice(0, length);
    // The first line is context; the rest are added lines beyond the first page.
    writeFileSync(join(f.repo, "hello.txt"), `${prose[0]}\n`);
    await sh(["git", "commit", "-am", "public context"], { cwd: f.repo });
    const c = await changeFixture(f, {
      "hello.txt": `${"unrelated readable line\n".repeat(800)}${prose.join("\n")}\nmore readable code\n`,
    });
    f.factory.store.putArtifact(c.run.id, "report.md", "report", `${prose.join("\n")}\npublic report ending`);
    const connections = await changeConnections();
    try {
      for (const field of ["description", "steps", "expected"] as const) {
        f.factory.store.setRunState(c.run.id, {
          holdout: {
            scenarios: [
              {
                id: "H-1",
                description: "Private check.",
                steps: "Perform check.",
                expected: "Check completes.",
                edge_case: false,
                [field]: prose.join("\n"),
              },
            ],
          },
        });
        for (const conn of [connections.direct, connections.proxy]) {
          let text = "",
            offset = 0;
          do {
            const page = resultValue<ChangePage>(
              await conn.client.callTool({
                name: "limitless_get_change",
                arguments: { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha, diffOffset: offset },
              }),
            );
            expect(page.available).toBe(true);
            text += page.diff.text;
            offset = page.diff.nextOffset ?? 0;
          } while (offset);
          for (const line of prose) expect(text).toContain(line);
          expect(text).toContain("unrelated readable line");
          expect(text).toContain("more readable code");
          const report =
            resultValue<ChangePage>(
              await conn.client.callTool({
                name: "limitless_get_change",
                arguments: { run: c.run.id },
              }),
            ).reports[0]?.text ?? "";
          for (const line of prose) expect(report).not.toContain(line);
          expect(report).toContain("[withheld: holdout result or quotation; 1 line]");
          expect(report).toContain("public report ending");
        }
      }
    } finally {
      await connections.close();
    }
  },
);

test.each(["\\n", "\\r", "\\r\\n", "\\t", "\\u000a", "\\u000d", "\\u0009"])(
  "short multiline prose with %s escapes stays public in PR pages and private in report pages",
  async (separator) => {
    const escaped = `Amber sky${separator}Violet sea`;
    const c = await changeFixture(f, {
      "hello.txt": `${"readable line\n".repeat(1500)}"${escaped}"\nreadable ending\n`,
    });
    f.factory.store.setRunState(c.run.id, {
      holdout: {
        scenarios: [
          {
            id: "H-1",
            description: "Amber sky\nViolet sea",
            steps: "Run check.",
            expected: "Done.",
            edge_case: false,
          },
        ],
      },
    });
    f.factory.store.putArtifact(
      c.run.id,
      "report.md",
      "report",
      `${"readable report\n".repeat(600)}"${escaped}"\nreport ending`,
    );
    const conn = await connect(factoryBackend(f.factory));
    const pin = { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha };
    try {
      for (const stream of ["diff", "report"] as const) {
        const read = async (offset: number) => {
          const page = resultValue<ChangePage>(
            await conn.client.callTool({
              name: "limitless_get_change",
              arguments: { ...pin, [stream === "diff" ? "diffOffset" : "reportOffset"]: offset },
            }),
          );
          expect(page.available).toBe(true);
          const content = stream === "diff" ? page.diff : page.reports[0];
          if (!content) throw new Error("Missing report");
          if (stream === "report") expect(content.text).not.toMatch(/Amber sky|Violet sea/);
          return content;
        };
        let text = "",
          offset = 0;
        do {
          const page = await read(offset);
          text += page.text;
          offset = page.nextOffset ?? 0;
        } while (offset);
        expect(text).toContain("readable");
        expect(text).toContain("ending");
        if (stream === "diff") {
          expect(text).toContain(escaped);
          continue;
        }
        const marker = text.indexOf("[withheld: holdout result or quotation; 1 line]");
        const cap = 4000;
        expect(marker).toBeGreaterThan(cap);
        // Put the sanitized placeholder across a page boundary and read both sides.
        const boundary = await read(marker - cap + 6);
        expect(boundary.text).toEndWith("[withh");
        expect(boundary.nextOffset).not.toBeNull();
        const next = await read(boundary.nextOffset ?? 0);
        expect(next.text).toStartWith("eld: holdout result or quotation; 1 line]");
      }
    } finally {
      await conn.close();
    }
  },
);

test("multiline PR hunks stay visible while complete report quotations stay private", async () => {
  writeFileSync(join(f.repo, "hello.txt"), "}\nold behavior\n");
  await sh(["git", "commit", "-am", "public context"], { cwd: f.repo });
  const c = await changeFixture(f, {
    "hello.txt": `}\n  return true;\n  expect(x).toBe(1)\n${"unrelated readable line\n".repeat(800)}}\nreturn true;\nindependent assertion\nexpect(x).toBe(1)\nconst counter = 1;\nexpect(counter).toBe(2);`,
    "renamed.txt": "}\nreturn true;\nexpect(x).toBe(1)",
  });
  // Generic assertion tokens are not public exemptions; only the complete phrase is private.
  f.factory.store.setRunState(c.run.id, {
    spec: {
      summary: "Review this change.",
      assumptions: [],
      requirements: [],
      acceptance_criteria: [],
      out_of_scope: [],
      blocking_questions: [],
    },
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: "}\nreturn true;\nexpect(x).toBe(1)",
          steps: "Run check.",
          expected: "Done.",
          edge_case: false,
        },
      ],
    },
  });
  f.factory.store.putArtifact(
    c.run.id,
    "report.md",
    "report",
    "}\nreturn true;\nexpect(x).toBe(1)\nindependent assertion\nreturn true;\nconst counter = 1;",
  );
  const conn = await connect(factoryBackend(f.factory));
  try {
    for (const file of [0, 1]) {
      let text = "",
        offset = 0;
      do {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({
            name: "limitless_get_change",
            arguments: { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha, file, diffOffset: offset },
          }),
        );
        expect(page.available).toBe(true);
        text += page.diff.text;
        offset = page.diff.nextOffset ?? 0;
      } while (offset);
      if (file === 0) {
        expect(text).toContain(" }\n-old behavior\n+  return true;\n+  expect(x).toBe(1)");
        expect(text).toContain("+}\n+return true;\n+independent assertion\n+expect(x).toBe(1)");
        expect(text).toContain("unrelated readable line");
        expect(text).toContain("+const counter = 1;");
        expect(text).toContain("+expect(counter).toBe(2);");
      } else {
        expect(text).toContain("+}\n+return true;\n+expect(x).toBe(1)");
        expect(text).toContain("\\ No newline at end of file");
      }
      const report = resultValue<ChangePage>(
        await conn.client.callTool({
          name: "limitless_get_change",
          arguments: { run: c.run.id },
        }),
      ).reports[0]?.text;
      expect(report).toStartWith("[withheld: holdout result or quotation; 1 line]\n".repeat(3));
      expect(report).toContain("independent assertion\nreturn true;\nconst counter = 1;");
    }
  } finally {
    await conn.close();
  }
});

test("multiline whitespace matching stays bounded and hides positive matches before paging", async () => {
  const whitespace = " ".repeat(128 * 1024);
  const content = `${whitespace}X\n"\tZ"\nreadable ending\n`;
  const c = await changeFixture(f, { "hello.txt": content });
  f.factory.store.setRunState(c.run.id, {
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: 'Inspect "\tZ".\nKeep it private.',
          steps: "Run check.",
          expected: "Done.",
          edge_case: false,
        },
      ],
    },
  });
  f.factory.store.putArtifact(c.run.id, "report.md", "report", content);
  const started = performance.now();
  const page = (await getChange(f.factory, {
    run: c.run.id,
    headSha: c.headSha,
    baseSha: c.baseSha,
    diffOffset: whitespace.length,
    reportOffset: whitespace.length,
  })) as ChangePage;
  expect(performance.now() - started).toBeLessThan(1500);
  expect(page.available).toBe(true);
  expect(page.diff.text).toContain('"\tZ"');
  expect(page.diff.text).toContain("readable ending");
  expect(page.reports[0]?.text).toContain("[withheld: holdout result or quotation; 1 line]");
  expect(page.reports[0]?.text).toContain("readable ending");
  expect(page.reports[0]?.text).not.toContain("Z");
}, 3000);

test("escaped multiline PR hunk annotations stay visible with Git ranges", async () => {
  const annotation = 'const label = "Amber sky\\nViolet sea";';
  const prefix = `${annotation}\n${"\n".repeat(12)}`;
  writeFileSync(join(f.repo, "hello.txt"), `${prefix}old behavior\n`);
  await sh(["git", "commit", "-am", "public annotation"], { cwd: f.repo });
  const c = await changeFixture(f, { "hello.txt": `${prefix}new behavior\n` });
  f.factory.store.setRunState(c.run.id, {
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: "Amber sky\nViolet sea",
          steps: "Run check.",
          expected: "Done.",
          edge_case: false,
        },
      ],
    },
  });
  const conn = await connect(factoryBackend(f.factory));
  try {
    const page = resultValue<ChangePage>(
      await conn.client.callTool({
        name: "limitless_get_change",
        arguments: { run: c.run.id },
      }),
    );
    expect(page.available).toBe(true);
    expect(page.diff.text).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(page.diff.text).toContain(annotation);
    expect(page.diff.text).toContain("-old behavior\n+new behavior\n");
  } finally {
    await conn.close();
  }
});

test("change pages reuse the catalogue and refresh diagnostics, holdouts and privacy inputs", async () => {
  const c = await changeFixture(
    f,
    {
      "hello.txt": `${"readable line\n".repeat(1500)}diagnosticSecret\nholdoutSecret\nroundSecret\nprivacySecret\ncredentialSecret\n`,
    },
    true,
  );
  const { store } = f.factory;
  const holdout = {
    scenarios: [
      {
        id: "H-1",
        description: "Private check.",
        steps: "Run check.",
        expected: "Done.",
        edge_case: false,
      },
    ],
  };
  store.setRunState(c.run.id, { holdout });
  const invocation = store.createInvocation({
    runId: c.run.id,
    stageId: null,
    role: "verify",
    harness: "fake",
    provider: "fake",
    model: "test",
    modelId: "fake/m",
  });
  store.recordOwnerDiagnostic(
    { runId: c.run.id, invocationId: invocation.id, kind: "result", text: "Observed 'initialSecret'." },
    "Private observation.",
  );
  // Count full diagnostic reads, not the lightweight freshness watermark lookup.
  store.putArtifact(
    c.run.id,
    "report.md",
    "report",
    "diagnosticSecret\nholdoutSecret\nroundSecret\nreadable line",
  );
  const reads = spyOn(diagnosticCatalogue, "ownerDiagnostics");
  const conn = await connect(factoryBackend(f.factory));
  const read = async (diffOffset = 16000) =>
    resultValue<ChangePage>(
      await conn.client.callTool({
        name: "limitless_get_change",
        arguments: { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha, diffOffset },
      }),
    );
  try {
    await read(0);
    const page = await read();
    expect(page.diff.text).toContain("diagnosticSecret");
    expect(reads).toHaveBeenCalledTimes(1);
    store.recordOwnerDiagnostic(
      { runId: c.run.id, invocationId: invocation.id, kind: "result", text: "Observed 'diagnosticSecret'." },
      "Private observation.",
    );
    expect((await read()).reports[0]?.text).not.toContain("diagnosticSecret");
    expect(reads).toHaveBeenCalledTimes(2);
    await read();
    expect(reads).toHaveBeenCalledTimes(2);
    store.setRunState(c.run.id, {
      holdout: { scenarios: [{ ...holdout.scenarios[0], description: 'Use "holdoutSecret".' }] },
    });
    expect((await read()).reports[0]?.text).not.toContain("holdoutSecret");
    expect(reads).toHaveBeenCalledTimes(3);
    const round = store.createReviewRound(
      c.repo,
      store.getRun(c.run.id) as Run,
      { prUrl: c.prUrl, reviewedSha: c.headSha, findings: [], cap: 3 },
      (number) => ({
        repo: c.repo.slug,
        prompt: "Fix review",
        baseBranch: "limitless/feature",
        deliveryBranch: "limitless/feature",
        sourceRef: {
          kind: "review-round",
          runId: c.run.id,
          round: number,
          prUrl: c.prUrl,
          reviewedSha: c.headSha,
        },
      }),
    );
    if (!("run" in round)) throw new Error("Round refused");
    store.setRunState(round.run.id, {
      holdout: { scenarios: [{ ...holdout.scenarios[0], description: 'Use "roundSecret".' }] },
    });
    expect((await read()).reports[0]?.text).not.toContain("roundSecret");
    expect(reads).toHaveBeenCalledTimes(5);
    await read();
    expect(reads).toHaveBeenCalledTimes(5);
    writeFileSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"), "privacySecret\n");
    const privatePage = await read();
    expect(privatePage.available).toBe(true);
    expect(privatePage.diff.text).not.toContain("privacySecret");
    expect(privatePage.diff.text).toContain("diagnosticSecret\n+holdoutSecret\n+roundSecret");
    expect((await read(0)).diff.text).toContain("readable line");
    expect(reads).toHaveBeenCalledTimes(7);
    writeFileSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"), "");
    registerCredential("CHANGE_TEST_CREDENTIAL", "credentialSecret");
    expect((await read(0)).diff.text).toContain("readable line");
    expect((await read()).diff.text).not.toContain("credentialSecret");
    writeFileSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"), "");
    // The documented per-store limit is 2,048 details; this adds 2,049 unique literals.
    store.recordOwnerDiagnostic(
      {
        runId: c.run.id,
        invocationId: invocation.id,
        kind: "result",
        text: Array.from({ length: 2049 }, (_, i) => `'oversizedSecret${i}'`).join(" "),
      },
      "Private observation.",
    );
    const beforeOversized = reads.mock.calls.length;
    expect((await read()).available).toBe(true);
    expect(reads).toHaveBeenCalledTimes(beforeOversized + 2);
    expect((await read()).available).toBe(true);
    expect(reads).toHaveBeenCalledTimes(beforeOversized + 4);
    store.recordOwnerDiagnostic(
      { runId: c.run.id, invocationId: invocation.id, kind: "result", text: "Observed 'readable line'." },
      "Private observation.",
    );
    const updated = await read();
    expect(updated.available).toBe(true);
    expect(updated.reports[0]?.text).not.toContain("readable line");
    expect(updated.diff.text).toContain("readable line");
    expect(reads).toHaveBeenCalledTimes(beforeOversized + 6);
    rmSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"));
    // Missing optional private strings means an empty list; an unreadable policy fails closed.
    mkdirSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"));
    expect(await read()).toMatchObject({
      message: expect.stringContaining("privacy policy unavailable"),
    });
  } finally {
    reads.mockRestore();
    await conn.close();
  }
}, 30_000);

test("change pages protect verifier quotations while returning implementer-visible literals", async () => {
  const hidden = "runtimeProbeSecret",
    diagnosticOnly = "ownerOnlyProbeSecret",
    plainObserved = "violettide";
  const c = await changeFixture(f, {
    "hello.txt": `${"readable line\n".repeat(1500)}${hidden}\n${diagnosticOnly}\n${plainObserved}\n`,
    [`${hidden}.txt`]: "private filename\n",
  });
  const { store } = f.factory;
  const holdout = {
    scenarios: [
      {
        id: "H-1",
        description: "Exercise private behavior.",
        steps: "Run the check.",
        expected: "It completes.",
        edge_case: false,
      },
    ],
  };
  const verify = {
    criteria: [
      {
        id: "H-1",
        status: "met",
        evidence: `Observed '${hidden}' during verification.`,
        publicSummary: "Behavior confirmed.",
      },
    ],
    notes: "",
    overall: "pass",
  };
  store.setRunState(c.run.id, {
    holdout,
    lastVerify: verify,
    verifyResults: [{ ...verify, modelOutput: verify }],
  });
  const invocation = store.createInvocation({
    runId: c.run.id,
    stageId: null,
    role: "verify",
    harness: "fake",
    provider: "fake",
    model: "test",
    modelId: "fake/m",
  });
  store.recordOwnerDiagnostic(
    {
      runId: c.run.id,
      invocationId: invocation.id,
      kind: "result",
      text: `Observed '${diagnosticOnly}' during verification.`,
    },
    "Observed '[private detail]' during verification.",
  );
  store.recordOwnerDiagnostic(
    { runId: c.run.id, invocationId: invocation.id, kind: "result", text: JSON.stringify(plainObserved) },
    '"[private detail]"',
  );
  store.putArtifact(
    c.run.id,
    "report.md",
    "report",
    `${"readable report\n".repeat(600)}${hidden}\n${diagnosticOnly}\n${plainObserved}`,
  );
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const streams: string[] = [];
      for (const stream of ["diff", "report"] as const) {
        let text = "",
          offset = 0;
        do {
          const response = await conn.client.callTool({
            name: "limitless_get_change",
            arguments: {
              run: c.run.id,
              headSha: c.headSha,
              baseSha: c.baseSha,
              [stream === "diff" ? "diffOffset" : "reportOffset"]: offset,
            },
          });
          const output = JSON.stringify(response);
          for (const privateText of ["owner_diagnostics", "invocationId", "Observed '"])
            expect(output).not.toContain(privateText);
          const page = resultValue<ChangePage>(response);
          expect(page.files[1]?.path).toBe(`${hidden}.txt`);
          const content = stream === "diff" ? page.diff : page.reports[0];
          if (!content) throw new Error("Missing report");
          if (stream === "report")
            for (const secret of [hidden, diagnosticOnly, plainObserved])
              expect(content.text).not.toContain(secret);
          text += content.text;
          offset = content.nextOffset ?? 0;
        } while (offset);
        streams.push(text);
      }
      const [patch = "", report = ""] = streams;
      expect(patch).toContain("readable line");
      for (const publicText of [hidden, diagnosticOnly, plainObserved]) expect(patch).toContain(publicText);
      expect(report).toContain("readable report");
      expect(report).toContain("[withheld: holdout result or quotation; 1 line]");
    }
    expect(diagnosticCatalogue.ownerDiagnostics(store.db, c.run.id)[0]?.text).toContain(diagnosticOnly);
  } finally {
    await connections.close();
  }
});

test.each([true, false])(
  "raw verifier diagnostics preserve public evidence while withholding private observations (complete: %s)",
  async (complete) => {
    const c = await changeFixture(f, {
      "src/count.ts": "export const publicCounterName = 123;\nexport const limit = 7;\nruntimeProbeSecret\n",
    });
    const { store } = f.factory;
    store.setRunState(c.run.id, {
      spec: {
        summary: "Count words.",
        assumptions: [],
        requirements: ["Export a count."],
        acceptance_criteria: [{ id: "AC-1", criterion: "Count words.", how_to_verify: "bun test" }],
        out_of_scope: [],
        blocking_questions: [],
      },
      holdout: {
        scenarios: [
          {
            id: "H-1",
            description: "Exercise private behavior.",
            steps: "Run the check.",
            expected: "It completes.",
            edge_case: false,
          },
        ],
      },
    });
    const invocation = store.createInvocation({
      runId: c.run.id,
      stageId: null,
      role: "verify",
      harness: "fake",
      provider: "fake",
      model: "test",
      modelId: "fake/m",
    });
    store.recordOwnerDiagnostic(
      {
        runId: c.run.id,
        invocationId: invocation.id,
        kind: "result",
        text: JSON.stringify({
          criteria: [
            {
              id: "AC-1",
              status: "met",
              evidence: "src/count.ts:7 exports 'publicCounterName' with value 123.",
              publicSummary: "src/count.ts returns 123.",
              gateEvidence: { check: "lint", command: "bun run lint" },
            },
            {
              id: "H-1",
              status: "met",
              evidence: "Observed 'runtimeProbeSecret' during verification.",
              publicSummary: "Behavior confirmed.",
              gateEvidence: { check: "typecheck", command: "bun run typecheck" },
            },
          ],
          notes: "Passed",
          ...(complete ? { overall: "pass" } : {}),
        }),
      },
      "Private verifier output withheld.",
    );
    store.recordOwnerDiagnostic(
      { runId: c.run.id, invocationId: invocation.id, kind: "error", text: "All checks passed." },
      "All checks passed.",
    );
    const publicReport =
      "src/count.ts:7 returns 123.\n## Checks\nlint: bun run lint — Passed\ntypecheck: bun run typecheck\nAll checks passed.";
    store.putArtifact(
      c.run.id,
      "report.md",
      "report",
      `${publicReport}\nsrc/count.ts:7 returns 123; runtimeProbeSecret`,
    );
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        expect(page.available).toBe(true);
        expect(page.files).toMatchObject([{ path: "src/count.ts", additions: 3, deletions: 0 }]);
        expect(page.diff.text).toContain(
          "+export const publicCounterName = 123;\n+export const limit = 7;\n",
        );
        expect(page.diff.text).toContain("+runtimeProbeSecret");
        expect(page.reports[0]?.text).toBe(
          `${publicReport}\n[withheld: holdout result or quotation; 1 line]`,
        );
        expect(JSON.stringify(page)).not.toMatch(/Observed '|invocationId|owner_diagnostics/);
      }
    } finally {
      await connections.close();
    }
  },
);

test("a rendered report never exposes a clipped holdout scenario description", async () => {
  const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
  const description = `Callers who pass an unusually long sentence ${"through the private pipeline ".repeat(12)}see one tidy summary.`;
  const state = {
    flow: "build" as const,
    holdout: {
      scenarios: [{ id: "H-1", description, steps: "Run it.", expected: "Done.", edge_case: false }],
    },
    lastVerify: {
      modelId: "verifier",
      criteria: [{ id: "H-1", status: "met" as const, evidence: "Observed the summary." }],
    },
  };
  f.factory.store.setRunState(c.run.id, state);
  const report = renderReport({
    success: true,
    runId: c.run.id,
    prompt: "Summarize text.",
    state: state as unknown as RunState,
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
  });
  // The report clips the description, so the full phrase never appears for redaction to find.
  expect(report).toContain(description.slice(0, 200));
  expect(report).not.toContain(description);
  f.factory.store.putArtifact(c.run.id, "report.md", "report", report);
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<ChangePage>(
        await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
      );
      const text = page.reports[0]?.text ?? "";
      expect(text).toMatch(/\[withheld: holdout section; 1 section, \d+ lines\]/);
      expect(text).toContain("## Checks");
      expect(text).not.toContain("unusually long sentence");
      expect(text).not.toContain("Observed the summary");
    }
  } finally {
    await connections.close();
  }
});

test.each(["LF", "CRLF"])(
  "change view withholds %s multiline credentials before paging on both backends",
  async (format) => {
    const alpha = `boundary-alpha-${"a".repeat(180)}`;
    const beta = "boundary-beta-secret";
    const newline = format === "CRLF" ? "\r\n" : "\n";
    const c = await changeFixture(f, {
      "added.txt": ["public before", "p".repeat(15830), alpha, beta, "public after", ""].join(newline),
    });
    const raw = (await sh(["git", "diff", c.baseSha, c.headSha], { cwd: f.repo })).stdout;
    expect(raw.indexOf(alpha)).toBeLessThan(16000);
    expect(raw.indexOf(beta)).toBeGreaterThan(16000);
    registerCredential("MULTILINE_CHANGE_CREDENTIAL", `${alpha}\n${beta}`);
    const connections = await changeConnections();
    const pin = { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha };
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const read = async (diffOffset: number) =>
          resultValue<ChangePage>(
            await conn.client.callTool({ name: "limitless_get_change", arguments: { ...pin, diffOffset } }),
          );
        let offset: number | null = 0;
        let diff = "";
        let pages = 0;
        while (offset !== null) {
          const page = await read(offset);
          expect(page.available).toBe(true);
          expect(page.diff.text).not.toMatch(/boundary-alpha|boundary-beta/);
          diff += page.diff.text;
          offset = page.diff.nextOffset;
          pages++;
        }
        expect(pages).toBe(1);
        expect(diff).toBe("[withheld: private text; 1 file]");
        for (const pinnedOffset of [1, 16000, raw.indexOf(beta)]) {
          const page = await read(pinnedOffset);
          expect(page.diff.text).not.toMatch(/boundary-alpha|boundary-beta/);
        }
      }
    } finally {
      await connections.close();
    }
  },
);

test.each(["new", "old", "opposite", "hunks", "files"])(
  "change view matches complete multiline credentials only within the %s file side",
  async (scenario) => {
    const alpha = `side-alpha-${scenario}`;
    const beta = `side-beta-${scenario}`;
    const gap = Array.from({ length: 12 }, (_, i) => `public gap ${i}`).join("\n");
    const base =
      scenario === "new"
        ? `public before\n${alpha}\nold value\npublic after\n`
        : scenario === "old"
          ? `public before\n${alpha}\n${beta}\npublic after\n`
          : scenario === "opposite" || scenario === "files"
            ? `public before\n${alpha}\npublic after\n`
            : `old before\n${alpha}\n${gap}\n${beta}\nold after\n`;
    const head =
      scenario === "new"
        ? `public before\n${alpha}\n${beta}\npublic after\n`
        : scenario === "old"
          ? `public before\nnew value\n${beta}\npublic after\n`
          : scenario === "files"
            ? `public before\n${alpha}\npublic changed\npublic after\n`
            : scenario === "opposite"
              ? `public before\n${beta}\npublic after\n`
              : `public before\n${alpha}\n${gap}\n${beta}\npublic after\n`;
    writeFileSync(join(f.repo, "hello.txt"), base);
    if (scenario === "opposite") writeFileSync(join(f.repo, "other.txt"), `${alpha}\n`);
    await sh(["git", "add", "."], { cwd: f.repo });
    await sh(["git", "commit", "-qm", "base hunk"], { cwd: f.repo });
    const c = await changeFixture(f, {
      "hello.txt": head,
      ...(scenario === "files"
        ? { "other.txt": `public before\n${beta}\npublic after\n` }
        : scenario === "opposite"
          ? { "other.txt": `${beta}\n` }
          : {}),
    });
    const raw = (
      await sh(
        [
          "git",
          "diff",
          "--diff-algorithm=myers",
          "--no-indent-heuristic",
          c.baseSha,
          c.headSha,
          "--",
          "hello.txt",
        ],
        { cwd: f.repo },
      )
    ).stdout;
    registerCredential(`MULTILINE_SIDE_${scenario}`, `${alpha}\n${beta}`);
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        const diff = page.diff.text;
        expect(page.available).toBe(true);
        if (scenario === "new" || scenario === "old") {
          expect(diff).toBe("[withheld: private text; 1 file]");
          expect(diff).not.toContain(alpha);
          expect(diff).not.toContain(beta);
        } else {
          expect(diff).toBe(raw);
          expect(diff).toContain("public before");
          expect(diff).toContain("public after");
          expect(diff).toContain("@@ ");
          expect(diff).toContain(alpha);
          expect(diff).not.toContain("withheld");
          if (scenario !== "files") expect(diff).toContain(beta);
          if (scenario === "hunks") expect(diff.match(/^@@ /gm)).toHaveLength(2);
          if (scenario === "opposite") expect(diff).toContain(`-${alpha}\n+${beta}`);
        }
        if (scenario === "files" || scenario === "opposite") {
          const other = resultValue<ChangePage>(
            await conn.client.callTool({
              name: "limitless_get_change",
              arguments: { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha, file: 1 },
            }),
          );
          expect(other.diff.text).toContain(`+${beta}`);
          expect(other.diff.text).not.toContain("withheld");
          expect(other.diff.text).toContain(scenario === "files" ? "+public after" : `-${alpha}`);
        }
      }
    } finally {
      await connections.close();
    }
  },
);

test.each([
  ["before", 1],
  ["before", 2],
  ["before", 3],
  ["after", 1],
  ["after", 2],
  ["after", 3],
] as const)(
  "change view withholds hunk-edge credentials with a change %s at distance %i",
  async (edge, distance) => {
    const secretLines = Array.from({ length: 5 }, (_, i) => `clipped-${edge}-${distance}-secret-${i}`);
    const base = [
      ...Array.from({ length: 4 }, (_, i) => `public before ${i}`),
      ...secretLines,
      ...Array.from({ length: 4 }, (_, i) => `public after ${i}`),
    ];
    writeFileSync(join(f.repo, "hello.txt"), `${base.join("\n")}\n`);
    await sh(["git", "add", "."], { cwd: f.repo });
    await sh(["git", "commit", "-qm", "base clipped credential"], { cwd: f.repo });
    const head = [...base];
    const changed = edge === "before" ? 4 - distance : 8 + distance;
    head[changed] = "public changed";
    const c = await changeFixture(f, { "hello.txt": `${head.join("\n")}\n` });
    const raw = (await sh(["git", "diff", "--unified=3", c.baseSha, c.headSha], { cwd: f.repo })).stdout;
    expect(secretLines.filter((line) => raw.includes(`\n ${line}\n`))).toHaveLength(4 - distance);
    registerCredential(`CLIPPED_${edge}_${distance}`, secretLines.join("\n"));
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        expect(page.available).toBe(true);
        for (const line of secretLines) expect(page.diff.text).not.toContain(line);
        expect(page.diff.text).toBe("[withheld: private text; 1 file]");
      }
    } finally {
      await connections.close();
    }
  },
);

test.each(["encoded", "CRLF", "CR", "normalized", "no final newline", "overlapping"])(
  "change view withholds files with %s multiline credential matches",
  async (format) => {
    const alpha = `mapped-alpha-${format}`;
    const beta = `mapped-beta-${format}`;
    const newline = format === "CRLF" ? "\r\n" : format === "CR" ? "\r" : "\n";
    const secret = `${alpha}${newline}${beta}`;
    const content =
      format === "encoded"
        ? `${encodeURIComponent(encodeURIComponent(alpha))}\n${[...beta].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}\npublic after\n`
        : format === "overlapping"
          ? `${alpha}\n${beta}\n${alpha}\npublic after\n`
          : `${secret}${format === "no final newline" ? "" : `${newline}public after${newline}`}`;
    const normalizedContent = format === "normalized" ? content.toUpperCase().replace(/A/g, "Ａ") : content;
    const c = await changeFixture(f, {
      "literal[?]*:file.txt": `public before${newline}${normalizedContent}`,
    });
    registerCredential(`MAPPED_MULTILINE_${format}`, secret);
    if (format === "overlapping") registerCredential("OVERLAPPING_MULTILINE", `${beta}\n${alpha}`);
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        expect(page.available).toBe(true);
        expect(page.diff.text).toBe("[withheld: private text; 1 file]");
        expect(page.diff.text).not.toContain(alpha);
        expect(page.diff.text).not.toContain(beta);
        expect(page.diff.text).not.toContain(encodeURIComponent(alpha));
      }
    } finally {
      await connections.close();
    }
  },
);

test.each([
  ["long", (i: number) => `middle-clipped-secret-${i}`],
  ["short", (i: number) => `${i}`],
  ["EOF without final newline", (i: number) => `eof-clipped-secret-${i}`],
])("change view withholds a hunk clipped inside a multiline credential (%s)", async (format, line) => {
  const eof = format === "EOF without final newline";
  const secretLines = Array.from({ length: 10 }, (_, i) => line(i));
  const base = [
    ...Array.from({ length: 4 }, (_, i) => `public before ${i}`),
    ...secretLines,
    ...(eof ? [] : Array.from({ length: 4 }, (_, i) => `public after ${i}`)),
  ];
  const ending = eof ? "" : "\n";
  writeFileSync(join(f.repo, "hello.txt"), `${base.join("\n")}${ending}`);
  await sh(["git", "add", "."], { cwd: f.repo });
  await sh(["git", "commit", "-qm", "base long credential"], { cwd: f.repo });
  const head = [...base];
  head[eof ? 12 : 9] = "public changed";
  const c = await changeFixture(f, { "hello.txt": `${head.join("\n")}${ending}` });
  const raw = (await sh(["git", "diff", "--unified=3", c.baseSha, c.headSha], { cwd: f.repo })).stdout;
  // Only the hunk header's function annotation may quote surrounding public text.
  const content = raw.replace(/^@@.*$/gm, "");
  expect(content).not.toContain("public before");
  expect(content).not.toContain("public after");
  if (eof) {
    expect(raw).toContain("\\ No newline at end of file");
    expect(content).not.toContain(secretLines[0] ?? "");
    expect(content).toContain(secretLines.at(-1) ?? "");
  }
  registerCredential("MIDDLE_CLIPPED_CREDENTIAL", secretLines.join("\n"));
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<ChangePage>(
        await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
      );
      expect(page.available).toBe(true);
      // Digits also occur in hunk headers, so check short secrets as whole patch lines.
      for (const line of secretLines) expect(page.diff.text).not.toMatch(new RegExp(`^[-+ ]${line}$`, "m"));
      for (const line of secretLines.filter((l) => l.length > 1)) expect(page.diff.text).not.toContain(line);
      expect(page.diff.text).toBe("[withheld: private text; 1 file]");
    }
  } finally {
    await connections.close();
  }
});

test("change view keeps deleted multiline credentials withheld", async () => {
  const secret = "deleted-alpha-secret\ndeleted-beta-secret";
  writeFileSync(join(f.repo, "hello.txt"), `${secret}\n`);
  await sh(["git", "add", "."], { cwd: f.repo });
  await sh(["git", "commit", "-qm", "base deleted credential"], { cwd: f.repo });
  rmSync(join(f.repo, "hello.txt"));
  const c = await changeFixture(f, { "visible.txt": "public addition\n" });
  registerCredential("DELETED_MULTILINE", secret);
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<ChangePage>(
        await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
      );
      expect(page.available).toBe(true);
      expect(page.diff.text).toBe("[withheld: file absent from PR head; 1 file, 2 lines]");
      expect(JSON.stringify(page)).not.toMatch(/deleted-alpha|deleted-beta/);
    }
  } finally {
    await connections.close();
  }
});

test("change view inspects the blob it diffs when a malformed tree repeats a path", async () => {
  const alpha = "malformed-alpha-secret".padEnd(200, "a");
  const beta = "malformed-beta-secret";
  const git = async (args: string[], stdin?: string) =>
    (await sh(["git", ...args], { cwd: f.repo, ...(stdin === undefined ? {} : { stdin }) })).stdout.trim();
  mkdirSync(join(f.repo, "foo"));
  writeFileSync(join(f.repo, "foo", "bar"), "public nested content\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "base nested file"]);
  const c = await changeFixture(f, { "visible.txt": "public addition\n" });
  // A root entry literally named "foo/bar", which ordinary commits cannot create, sorts after the
  // "foo" tree and renders as the same path as the public nested file.
  const secret = await git(["hash-object", "-w", "--stdin"], `${alpha}\n${beta}\n`);
  const entries = (await git(["ls-tree", "-z", c.headSha]))
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta = "", name = ""] = line.split("\t");
      const [mode = "", , oid = ""] = meta.split(" ");
      return { mode: mode === "040000" ? "40000" : mode, name, oid };
    });
  entries.push({ mode: "100644", name: "foo/bar", oid: secret });
  const key = (e: { mode: string; name: string }) => (e.mode === "40000" ? `${e.name}/` : e.name);
  entries.sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
  const raw = Buffer.concat(
    entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, "hex")])),
  );
  const rawPath = join(f.repo, ".git", "malformed-tree");
  writeFileSync(rawPath, raw);
  const tree = await git(["hash-object", "-w", "-t", "tree", "--literally", rawPath]);
  const head = await git(["commit-tree", tree, "-p", c.headSha, "-m", "malformed head"]);
  await git(["push", "-q", cachePath(f.factory.cfg.paths, c.repo), `${head}:refs/heads/malformed`]);
  c.observe(head);
  registerCredential("MALFORMED_TREE_MULTILINE", `${alpha}\n${beta}`);
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const read = async (diffOffset: number) =>
        resultValue<ChangePage>(
          await conn.client.callTool({
            name: "limitless_get_change",
            arguments: { run: c.run.id, headSha: head, baseSha: c.baseSha, file: 0, diffOffset },
          }),
        );
      const first = await read(0);
      expect(first.files[0]?.path).toBe("foo/bar");
      for (const page of [first, await read(16000)])
        expect(JSON.stringify(page)).not.toMatch(/malformed-alpha|malformed-beta/);
      expect(first.diff.text).toBe("[withheld: private text; 1 file]");
    }
  } finally {
    await connections.close();
  }
});

test("change view refuses a blob-mode entry that names a tag object", async () => {
  const alpha = "tagged-alpha-secret".padEnd(200, "a");
  const beta = "tagged-beta-secret";
  const git = async (args: string[], stdin?: string) =>
    (await sh(["git", ...args], { cwd: f.repo, ...(stdin === undefined ? {} : { stdin }) })).stdout.trim();
  const c = await changeFixture(f, { "visible.txt": "public addition\n" });
  // An annotated tag whose target is a public blob already in the head tree: `cat-file blob` would
  // read the target, while the patch shows the tag object, message included.
  const target = await git(["rev-parse", `${c.headSha}:visible.txt`]);
  const tag = await git(
    ["mktag"],
    `object ${target}\ntype blob\ntag t\ntagger T <t@example.com> 0 +0000\n\n${alpha}\n${beta}\n`,
  );
  const entries = (await git(["ls-tree", "-z", c.headSha]))
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta = "", name = ""] = line.split("\t");
      const [mode = "", , oid = ""] = meta.split(" ");
      return { mode: mode === "040000" ? "40000" : mode, name, oid };
    });
  entries.push({ mode: "100644", name: "a-tagged.txt", oid: tag });
  const key = (e: { mode: string; name: string }) => (e.mode === "40000" ? `${e.name}/` : e.name);
  entries.sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
  const rawPath = join(f.repo, ".git", "tagged-tree");
  writeFileSync(
    rawPath,
    Buffer.concat(
      entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, "hex")])),
    ),
  );
  const tree = await git(["hash-object", "-w", "-t", "tree", "--literally", rawPath]);
  const head = await git(["commit-tree", tree, "-p", c.headSha, "-m", "tagged head"]);
  await git(["push", "-q", cachePath(f.factory.cfg.paths, c.repo), `${head}:refs/heads/tagged`]);
  c.observe(head);
  registerCredential("TAGGED_ENTRY_MULTILINE", `${alpha}\n${beta}`);
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const page = resultValue<unknown>(
        await conn.client.callTool({
          name: "limitless_get_change",
          arguments: { run: c.run.id, headSha: head, baseSha: c.baseSha, file: 0 },
        }),
      );
      expect(JSON.stringify(page)).not.toMatch(/tagged-alpha|tagged-beta/);
      expect(page).toEqual({
        available: false,
        reason: "Local comparison commits or Git inspection unavailable.",
      });
    }
  } finally {
    await connections.close();
  }
});

test.each(["file", "symlink", "gitlink"])(
  "change view excludes deleted children of a directory replaced by a %s on both backends",
  async (replacement) => {
    const path = "nest[?]*";
    const child = `${path}/secret.txt`;
    const alpha = "replacement-alpha-secret".padEnd(600, "a");
    const beta = "replacement-beta-secret";
    const publicText = "public replacement end\n";
    const git = (args: string[]) => sh(["git", ...args], { cwd: f.repo });
    mkdirSync(join(f.repo, path));
    writeFileSync(
      join(f.repo, child),
      `${"public child line\n".repeat(810)}${alpha}\n${beta}\n${"public child line\n".repeat(1500)}`,
    );
    await git(["add", "."]);
    await git(["commit", "-qm", "base directory"]);
    rmSync(join(f.repo, path), { recursive: true });
    const link = "1".repeat(40);
    if (replacement === "symlink") symlinkSync("public-target", join(f.repo, path));
    if (replacement === "gitlink") {
      await git(["rm", "--cached", "--", child]);
      mkdirSync(join(f.repo, path));
      await git(["update-index", "--add", "--cacheinfo", `160000,${link},${path}`]);
    }
    const c = await changeFixture(f, {
      "hello.txt": "unrelated public change\n",
      ...(replacement === "file" ? { [path]: publicText } : {}),
    });
    const raw = (await git(["diff", "--no-renames", c.baseSha, c.headSha, "--", `:(literal)${path}`])).stdout;
    // A pinned page at 16000 would otherwise begin inside the deleted child's credential.
    expect(raw.indexOf(alpha)).toBeGreaterThan(0);
    expect(raw.indexOf(alpha)).toBeLessThan(16000);
    expect(raw.indexOf(beta)).toBeGreaterThan(16000);
    registerCredential("REPLACEMENT_MULTILINE", `${alpha}\n${beta}`);
    const connections = await changeConnections();
    const pin = { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha };
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const first = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        const file = first.files.find((entry) => entry.path === path)?.index;
        expect(file).toBeNumber();
        const read = async (diffOffset: number) =>
          resultValue<ChangePage>(
            await conn.client.callTool({
              name: "limitless_get_change",
              arguments: { ...pin, file, diffOffset },
            }),
          );
        let diff = "";
        for (const start of [0, 16000]) {
          let offset: number | null = start;
          while (offset !== null) {
            const page = await read(offset);
            expect(page.available).toBe(true);
            expect(page.diff.text).not.toContain(alpha);
            expect(page.diff.text).not.toContain(beta);
            expect(page.diff.text).not.toContain(child);
            expect(page.diff.text).not.toContain("public child line");
            if (start === 0) diff += page.diff.text;
            offset = page.diff.nextOffset;
          }
        }
        expect(diff.match(/^diff --git /gm)).toHaveLength(1);
        expect(diff).not.toContain("withheld");
        expect(diff).toContain(
          replacement === "file"
            ? "+public replacement end"
            : replacement === "symlink"
              ? "+public-target"
              : `+Subproject commit ${link}`,
        );
        expect(first.diff.text).toContain("+unrelated public change");
      }
    } finally {
      await connections.close();
    }
  },
);

test.each(["added", "modified", "blob to gitlink", "gitlink to blob"])(
  "change view inspects only blobs for a submodule %s on both backends",
  async (scenario) => {
    const path = "module";
    // Gitlink targets deliberately do not exist in this repository's object database.
    const oldLink = "1".repeat(40);
    const newLink = "2".repeat(40);
    const secret = "gitlink-alpha-secret\ngitlink-beta-secret";
    const git = (args: string[]) => sh(["git", ...args], { cwd: f.repo });
    if (scenario !== "added") {
      if (scenario === "blob to gitlink") {
        writeFileSync(join(f.repo, path), `${secret}\n`);
        await git(["add", path]);
      } else {
        mkdirSync(join(f.repo, path));
        await git(["update-index", "--add", "--cacheinfo", `160000,${oldLink},${path}`]);
      }
      await git(["commit", "-qm", "base submodule entry"]);
    }
    rmSync(join(f.repo, path), { recursive: true, force: true });
    if (scenario !== "gitlink to blob") {
      mkdirSync(join(f.repo, path));
      await git(["update-index", "--add", "--cacheinfo", `160000,${newLink},${path}`]);
    }
    const c = await changeFixture(f, scenario === "gitlink to blob" ? { [path]: `${secret}\n` } : {});
    registerCredential("GITLINK_MULTILINE", secret);
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const page = resultValue<ChangePage>(
          await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
        );
        expect(page.available).toBe(true);
        expect(page.files).toMatchObject([{ path, binary: false }]);
        expect(page.reports[0]).toMatchObject({
          available: true,
          text: expect.stringContaining("Factory report"),
        });
        if (scenario === "added" || scenario === "modified") {
          expect(page.diff.text).toContain(`+Subproject commit ${newLink}\n`);
          if (scenario === "modified") expect(page.diff.text).toContain(`-Subproject commit ${oldLink}\n`);
          expect(page.diff.text).not.toContain("withheld");
        } else {
          expect(page.diff.text).toBe("[withheld: private text; 1 file]");
        }
        expect(JSON.stringify(page)).not.toMatch(/gitlink-alpha|gitlink-beta/);
      }
    } finally {
      await connections.close();
    }
  },
);

test.each([
  "base",
  "head",
  "raw selection",
  "ambiguous raw selection",
  "patch selection",
  "unexpected patch selection",
  "empty patch selection",
  "unterminated patch selection",
])("change view fails closed on a required %s inspection failure", async (side) => {
  const c = await changeFixture(f, { "hello.txt": "public changed\n" });
  registerCredential("INSPECTION_MULTILINE", "inspection-alpha\ninspection-beta");
  const blob = async (sha: string) =>
    (await sh(["git", "rev-parse", `${sha}:hello.txt`], { cwd: f.repo })).stdout.trim();
  const blobs = { base: await blob(c.baseSha), head: await blob(c.headSha) };
  const original = gitCommand.worktreeGit;
  const inspect = spyOn(gitCommand, "worktreeGit").mockImplementation(async (cmd, opts) => {
    const selection = cmd.includes("--name-only") && !cmd.includes("--diff-filter=D");
    const raw = cmd.includes("--raw");
    if (
      (side === "patch selection" && selection) ||
      (side === "raw selection" && raw) ||
      ((side === "base" || side === "head") && cmd.includes("cat-file") && cmd.includes(blobs[side]))
    )
      throw new Error("private inspection diagnostic");
    if (side === "ambiguous raw selection" && raw) {
      const result = await original(cmd, opts);
      return { ...result, stdout: result.stdout + result.stdout };
    }
    if (side.endsWith("patch selection") && selection) {
      const result = await original(cmd, opts);
      return {
        ...result,
        stdout: side.startsWith("unexpected")
          ? "hello.txt\0private inspection diagnostic\0"
          : side.startsWith("empty")
            ? ""
            : "hello.txt",
      };
    }
    return original(cmd, opts);
  });
  const connections = await changeConnections();
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      expect(
        resultValue<unknown>(
          await conn.client.callTool({
            name: "limitless_get_change",
            arguments: { run: c.run.id },
          }),
        ),
      ).toEqual({ available: false, reason: "Local comparison commits or Git inspection unavailable." });
    }
  } finally {
    inspect.mockRestore();
    await connections.close();
  }
});

test("change view preserves PR text and withholds private paths, patch lines, reports and errors on both backends", async () => {
  const hidden = "hiddenScenarioSentinel";
  const c = await changeFixture(f, {
    "hello.txt": `hello\n${"safe line\n".repeat(3000)}${privacyTexts.join("\n")}\npublic neighbor after secrets\n`,
    "holdout-patch.txt": `${"safe line\n".repeat(3000)}privacy-test-credential\nsecret-host.example\npublic neighbor after secrets\n${[...hidden].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}\n`,
    [`${hidden}.txt`]: "private path\n",
    "secret-host.example.txt": "private configured path\n",
    "privacy-test-credential.txt": "private credential path\n",
  });
  writeFileSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"), "secret-host.example\n");
  registerCredential("PRIVACY_TEST_CREDENTIAL", "privacy-test-credential");
  registerCredential("UNRELATED_MULTILINE", "unrelated-first-line\nunrelated-second-line");
  f.factory.store.setRunState(c.run.id, {
    holdout: {
      scenarios: [
        {
          id: "H-1",
          description: `Check '${hidden}'`,
          steps: `Read '${hidden}'`,
          expected: hidden,
          edge_case: false,
        },
      ],
    },
  });
  f.factory.store.putArtifact(c.run.id, "report.md", "report", `${hidden}\n${privacyTexts.join("\n")}`);
  const connections = await changeConnections();
  const pin = { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha };
  try {
    for (const conn of [connections.direct, connections.proxy]) {
      const read = (args: Record<string, unknown>) =>
        conn.client.callTool({ name: "limitless_get_change", arguments: args });
      const first = resultValue<ChangePage>(await read(pin));
      expect(first.files).toHaveLength(5);
      for (const secret of privacyTexts) expect(JSON.stringify(first)).not.toContain(secret);
      for (const args of [
        ...first.files
          .filter((file) => !["hello.txt", "holdout-patch.txt"].includes(file.path))
          .map((file) => ({ ...pin, file: file.index, diffOffset: 1, reportOffset: 1 })),
        { ...pin, [hidden]: "invalid" },
      ]) {
        const output = JSON.stringify(await read(args));
        for (const secret of privacyTexts) expect(output).not.toContain(secret);
      }
      // Unsafe decoding prevents ruling out a multiline match in the complete hello.txt.
      expect(first.diff.text).toBe("[withheld: private text; 1 file]");
      const file = first.files.find((file) => file.path === "holdout-patch.txt")?.index;
      const ordinary = resultValue<ChangePage>(await read({ ...pin, file }));
      expect(ordinary.diff.text).toContain("+safe line");
      let diff = ordinary.diff.text;
      let offset = ordinary.diff.nextOffset;
      while (offset !== null) {
        const next = resultValue<ChangePage>(await read({ ...pin, file, diffOffset: offset }));
        for (const secret of privacyTexts) expect(JSON.stringify(next)).not.toContain(secret);
        diff += next.diff.text;
        offset = next.diff.nextOffset;
      }
      expect(diff).toContain("[withheld: private text; 1 line]");
      expect(diff).toContain("+public neighbor after secrets");
      expect(diff).toContain([...hidden].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""));
      expect(first.reports[0]?.text).toContain("withheld");
    }
    rmSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"));
    mkdirSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"));
    for (const conn of [connections.direct, connections.proxy]) {
      const result = await conn.client.callTool({ name: "limitless_get_change", arguments: pin });
      expect(resultValue<unknown>(result)).toEqual({
        message: "Tool output withheld; privacy policy unavailable.",
      });
    }
    const routes = createHttpRoutes(f.factory);
    const handler = routes["/api/runs/:id/change"] as Route;
    const response = await handler(
      requestWithParams("http://daemon.invalid/api/runs/id/change", undefined, { id: c.run.id }),
      localServer,
    );
    expect(await response.json()).toEqual({
      available: false,
      reason: "Privacy policy unavailable; content withheld.",
    });
  } finally {
    await connections.close();
  }
});

test.each(["hiddenScenarioSentinel", ...privacyTexts].map((report, index) => [index, report] as const))(
  "change view protects the complete report before paging on both backends (encoding %i)",
  async (_index, report) => {
    const c = await changeFixture(f, { "hello.txt": "new greeting\n" });
    const hidden = "hiddenScenarioSentinel";
    writeFileSync(join(f.factory.cfg.paths.configDir, "private-strings.txt"), "secret-host.example\n");
    registerCredential("PRIVACY_TEST_CREDENTIAL", "privacy-test-credential");
    f.factory.store.setRunState(c.run.id, {
      holdout: {
        scenarios: [{ id: "H-1", description: hidden, steps: hidden, expected: hidden, edge_case: false }],
      },
    });
    f.factory.store.putArtifact(c.run.id, "report.md", "report", `${"safe line\n".repeat(1000)}${report}`);
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const result = await conn.client.callTool({
          name: "limitless_get_change",
          arguments: { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha, reportOffset: 4000 },
        });
        const output = JSON.stringify(result);
        for (const secret of [hidden, ...privacyTexts]) expect(output).not.toContain(secret);
        if (report === hidden) {
          // Holdout text is redacted in the complete report, so later pages carry the placeholder.
          const tail = resultValue<ChangePage>(
            await conn.client.callTool({
              name: "limitless_get_change",
              arguments: { run: c.run.id, headSha: c.headSha, baseSha: c.baseSha, reportOffset: 8000 },
            }),
          );
          expect(tail.reports[0]?.text).toEndWith(
            "safe line\n[withheld: holdout result or quotation; 1 line]",
          );
          continue;
        }
        // The whole report is withheld before applying the offset, even when the secret is later.
        expect(resultValue<ChangePage>(result)).toMatchObject({
          available: true,
          reports: [{ available: true, text: "", truncated: false, nextOffset: null }],
        });
      }
    } finally {
      await connections.close();
    }
  },
);

test.each(["newer recorded head", "push in progress", "missing recorded head"])(
  "status and change view refuse a stale snapshot with %s on both backends",
  async (condition) => {
    const c = await changeFixture(f, { "hello.txt": "new greeting\n" }, true);
    const { store } = f.factory;
    if (condition === "newer recorded head") store.observePrHead(c.prUrl, c.baseSha);
    else if (condition === "push in progress") {
      const pushing = store.createRun(c.repo, { repo: c.repo.slug, prompt: "Push review changes" });
      store.beginPrPush(c.prUrl, c.headSha, pushing.id);
    } else store.db.query("DELETE FROM pr_heads WHERE pr_url = ?").run(c.prUrl);
    const connections = await changeConnections();
    try {
      for (const conn of [connections.direct, connections.proxy]) {
        const status = resultValue<{ state: string; nextAction: string; headSha: string | null }>(
          await conn.client.callTool({ name: "limitless_status", arguments: { run: c.run.id } }),
        );
        expect(status.headSha).toBeNull();
        expect(status.state).toBe(
          condition === "missing recorded head" ? "PR head unknown" : "PR head superseded",
        );
        expect(status.nextAction).not.toContain(c.headSha);
        expect(status.nextAction).not.toContain("submit limitless_review");
        expect(
          resultValue(
            await conn.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
          ),
        ).toMatchObject({
          available: false,
          reason: expect.stringContaining(
            condition === "missing recorded head" ? "unavailable" : "superseded",
          ),
        });
      }
    } finally {
      await connections.close();
    }
  },
);

test("original-run status follows in-flight, failed and delivered rounds and reviews the observed head", async () => {
  const c = await changeFixture(f, { "hello.txt": "new greeting\nroundRuntimeSecret\n" }, true);
  const { store } = f.factory;
  c.observe(c.baseSha);
  const created = store.createReviewRound(
    c.repo,
    store.getRun(c.run.id) as Run,
    { prUrl: c.prUrl, reviewedSha: c.baseSha, findings: [], cap: 3 },
    (round) => ({
      repo: c.repo.slug,
      prompt: "Fix review",
      baseBranch: "limitless/feature",
      deliveryBranch: "limitless/feature",
      sourceRef: { kind: "review-round", runId: c.run.id, round, prUrl: c.prUrl, reviewedSha: c.baseSha },
    }),
  );
  if (!("run" in created)) throw new Error("Round refused");
  const connections = await changeConnections();
  try {
    for (const status of ["running", "failed", "succeeded"] as const) {
      store.updateRun(created.run.id, { status });
      if (status === "succeeded") {
        store.markRoundDelivered(created.run.id, c.headSha);
        c.observe(c.headSha);
        store.setRunState(created.run.id, {
          holdout: {
            scenarios: [
              {
                id: "H-1",
                description: "Exercise round behavior.",
                steps: "Run the round check.",
                expected: "Check completes.",
                edge_case: false,
              },
            ],
          },
          lastVerify: { criteria: [{ id: "H-1", evidence: "Observed 'roundRuntimeSecret'." }] },
        });
        store.putArtifact(created.run.id, "report.md", "report", "Round report\nroundRuntimeSecret");
      }
      for (const conn of [connections.direct, connections.proxy]) {
        const value = resultValue<{ state: string; nextAction: string }>(
          await conn.client.callTool({ name: "limitless_status", arguments: { run: c.run.id } }),
        );
        expect(value).toMatchObject({
          run: c.run.id,
          headSha: status === "succeeded" ? c.headSha : c.baseSha,
          latestRound: {
            runId: created.run.id,
            status,
            deliveredSha: status === "succeeded" ? c.headSha : null,
          },
        });
        expect(value.state).toBe(
          status === "running"
            ? "Review changes in progress"
            : status === "failed"
              ? "Review changes failed"
              : "Review needed",
        );
        if (status === "succeeded") {
          expect(value.nextAction).toContain(c.headSha);
          expect(value.nextAction).toContain("limitless_get_change");
          expect(value.nextAction).toContain(c.run.id);
        }
      }
    }
    const view = resultValue<ChangePage>(
      await connections.proxy.client.callTool({ name: "limitless_get_change", arguments: { run: c.run.id } }),
    );
    expect(view.reports.map((report) => [report.run, report.available])).toEqual([
      [c.run.id, true],
      [created.run.id, true],
    ]);
    expect(view.headSha).toBe(c.headSha);
    expect(view.diff.text).toContain("new greeting");
    expect(view.diff.text).toContain("roundRuntimeSecret");
    expect(view.reports[1]?.text).toBe("Round report\n[withheld: holdout result or quotation; 1 line]");
  } finally {
    await connections.close();
  }
});

test("proxy maps all six tools to REST and matches Factory results, including filtered event tail", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const routes = createHttpRoutes(f.factory);
  const fetcher: Fetch = async (url, init) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    const match = path.match(/^\/api\/runs\/([^/]+)(\/events|\/cancel|\/answer|\/resolve)?$/);
    const key = match ? `/api/runs/:id${match[2] ?? ""}` : path;
    const entry = routes[key];
    const handler = (
      typeof entry === "function" ? entry : (entry as Record<string, Route>)[init?.method ?? "GET"]
    ) as Route;
    return handler(
      requestWithParams(url, init, match ? { id: decodeURIComponent(match[1] ?? "") } : {}),
      localServer,
    );
  };
  const proxy = await connect(httpBackend("http://127.0.0.1:7400/", fetcher));
  const direct = await connect(factoryBackend(f.factory));
  try {
    const call = (name: string, args: Record<string, unknown> = {}) =>
      proxy.client.callTool({ name: `limitless_${name}`, arguments: args });
    const run = resultValue<Run>(await call("create_run", { repo: f.repo, prompt: "Do work" }));
    expect(run).toMatchObject({ source: "mcp", status: "queued", profile: "auto" });
    expect(requests[0]?.url).toBe("http://127.0.0.1:7400/api/runs");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ source: "mcp", profile: "auto" });
    f.factory.store.db.transaction(() => {
      for (let i = 0; i < 5100; i++)
        f.factory.store.addEvent({
          runId: run.id,
          type: "log",
          level: i % 2 ? "debug" : "info",
          message: String(i),
        });
    })();
    for (const [name, args] of [
      ["get_run", { id: run.id }],
      ["get_run", { id: run.id, full: true }],
      ["list_runs", { status: "queued", limit: 1 }],
    ] as const) {
      expect(await call(name, args)).toEqual(
        await direct.client.callTool({ name: `limitless_${name}`, arguments: args }),
      );
    }
    expect(requests.some((r) => r.url.endsWith("/events?tail=true&excludeDebug=true&limit=20"))).toBe(true);
    expect(requests.some((r) => r.url.endsWith("/api/runs?limit=2&status=queued"))).toBe(true);
    const legacy = await fetcher(`http://127.0.0.1:7400/api/runs/${run.id}/events?limit=6000`);
    const legacyEvents = await legacy.json();
    expect(legacyEvents).toHaveLength(5000);
    expect(legacyEvents[0].message).toBe("Run created from mcp");
    expect(resultValue(await call("providers"))).toMatchObject([
      { id: "fake", enabled: true, windows: {}, spendUsd: null, budgetUsd: null },
    ]);
    expect(requests.at(-1)?.url).toEndWith("/api/providers");
    const waiting = resultValue<Run>(
      await call("create_run", { repo: f.repo, prompt: "next", dependsOn: [` ${run.id} `, run.id] }),
    );
    expect(waiting).toMatchObject({ status: "waiting", dependsOn: [run.id] });
    expect(resultValue(await call("get_run", { id: waiting.id }))).toMatchObject({
      dependsOn: [run.id],
      status: "waiting",
    });
    expect(
      resultValue<{ runs: Run[] }>(await call("list_runs", { status: "waiting" })).runs.map((r) => r.id),
    ).toEqual([waiting.id]);
    expect(
      resultValue(await call("list_runs", { repo: run.repoSlug, status: "waiting", limit: 1 })),
    ).toMatchObject({
      runs: [{ id: waiting.id }],
      hasMore: false,
    });
    expect(resultValue<unknown>(await call("list_runs", { repo: "missing/repo" }))).toEqual({
      runs: [],
      hasMore: false,
    });
    expect((await call("create_run", { repo: f.repo, prompt: "bad", dependsOn: ["unknown"] })).isError).toBe(
      true,
    );
    for (const dependsOn of [null, [""], [false], ["unknown"]]) {
      const response = await fetcher("http://127.0.0.1:7400/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: f.repo, prompt: "bad", dependsOn }),
      });
      expect(response.status).toBe(400);
    }

    f.factory.store.askQuestion(run.id, "What?");
    const answer = resultValue<Question[]>(await call("answer_question", { id: run.id, answer: "All good" }));
    expect(answer[0]).toMatchObject({ answer: "All good", answeredBy: "mcp" });
    expect(requests.at(-1)?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "All good", by: "mcp" }),
    });
    expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
      cancelled: true,
    });
    expect(requests.at(-1)?.url).toEndWith(`/api/runs/${run.id}/cancel`);
    expect(requests.at(-1)?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
      cancelled: false,
    });
    // Cancelled is not resolvable; the daemon's 409 surfaces once, and manual merged never leaves the client.
    const conflict = await call("resolve_run", { id: run.id, kind: "wont_do" });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.content)).toContain("409");
    const sent = requests.length;
    expect((await call("resolve_run", { id: run.id, kind: "merged" })).isError).toBe(true);
    expect(requests).toHaveLength(sent);
    f.factory.store.updateRun(waiting.id, { status: "needs_human" });
    const resolved = resultValue<Run>(
      await call("resolve_run", { id: waiting.id, kind: "superseded", ref: run.id, note: "redone" }),
    );
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: { kind: "superseded", ref: run.id, note: "redone", by: "human" },
    });
    expect(requests.at(-1)?.url).toBe(`http://127.0.0.1:7400/api/runs/${waiting.id}/resolve`);
    expect(requests.at(-1)?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ kind: "superseded", ref: run.id, note: "redone" }),
    });
    f.factory.store.updateRun(run.id, { status: "failed" });
    const viaDirect = await direct.client.callTool({
      name: "limitless_resolve_run",
      arguments: { id: run.id, kind: "done_elsewhere" },
    });
    expect(resultValue<Run>(viaDirect).resolution).toMatchObject({ kind: "done_elsewhere", by: "human" });
    const again = await direct.client.callTool({
      name: "limitless_resolve_run",
      arguments: { id: run.id, kind: "wont_do" },
    });
    expect(JSON.stringify(again.content)).toContain("run is resolved");
    for (const name of ["get_run", "cancel_run", "answer_question", "resolve_run"]) {
      const result = await call(name, {
        id: "missing",
        ...(name === "answer_question" ? { answer: "x" } : {}),
        ...(name === "resolve_run" ? { kind: "wont_do" } : {}),
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("not found");
    }
    expect((await call("answer_question", { id: run.id, answer: "again" })).isError).toBe(true);
    const before = requests.length;
    expect((await call("create_run", { repo: "", prompt: "x" })).isError).toBe(true);
    expect(requests).toHaveLength(before);
  } finally {
    await proxy.close();
    await direct.close();
  }
});

test("ids are encoded in every proxy path", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "x" });
  const urls: string[] = [];
  const backend = httpBackend("http://localhost:7400", async (url) => {
    urls.push(url);
    return Response.json(f.factory.store.getRunDetail(run.id));
  });
  const id = "id/with ?#%";
  await backend.detail(id);
  await backend.events(id);
  await backend.cancel(id);
  await backend.answer(id, "answer");
  await backend.resolve(id, { kind: "wont_do" });
  await backend.review(id, { verdict: "approve", reviewedSha: "a".repeat(40), findings: [] });
  expect(
    urls.every((url) => url.startsWith(`http://localhost:7400/api/runs/${encodeURIComponent(id)}`)),
  ).toBe(true);
});

test("review and land forward validated payloads and return API results", async () => {
  const requests: { path: string; body: unknown; method: string | undefined }[] = [];
  const sha = "a".repeat(40);
  const finding = { severity: "major", title: "Bug", file: "app.ts", line: 2, detail: "Fix it" };
  let response: unknown = { approval: { sha, stale: false } };
  const proxy = await connect(
    httpBackend("http://daemon.invalid", async (url, init) => {
      requests.push({
        path: new URL(url).pathname,
        body: JSON.parse(String(init?.body)),
        method: init?.method,
      });
      return Response.json(response);
    }),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    proxy.client.callTool({ name: `limitless_${name}`, arguments: args });
  try {
    expect(
      resultValue<unknown>(
        await call("review", {
          run: "r/1",
          verdict: "approve",
          reviewedSha: sha.toUpperCase(),
          findings: [],
        }),
      ),
    ).toEqual({ approval: { sha, stale: false } });
    expect(
      resultValue<unknown>(await call("review", { run: "r/1", verdict: "approve", reviewedSha: sha })),
    ).toEqual({ approval: { sha, stale: false } });
    response = { round: { id: "round1", status: "queued" } };
    expect(
      resultValue<unknown>(
        await call("review", { run: "r/1", verdict: "changes", reviewedSha: sha, findings: [finding] }),
      ),
    ).toEqual({ round: { id: "round1", status: "queued" } });
    response = { id: 7, state: "queued" };
    expect(resultValue<unknown>(await call("land", { run: "r/1" }))).toEqual({ id: 7, state: "queued" });
    expect(resultValue<unknown>(await call("land", { run: "r/1", sha }))).toEqual({ id: 7, state: "queued" });
    expect(requests).toEqual([
      {
        path: "/api/runs/r%2F1/review",
        method: "POST",
        body: { verdict: "approve", reviewedSha: sha, findings: [], reviewer: "mcp" },
      },
      {
        path: "/api/runs/r%2F1/review",
        method: "POST",
        body: { verdict: "approve", reviewedSha: sha, findings: [], reviewer: "mcp" },
      },
      {
        path: "/api/runs/r%2F1/review",
        method: "POST",
        body: { verdict: "changes", reviewedSha: sha, findings: [finding], reviewer: "mcp" },
      },
      { path: "/api/land", method: "POST", body: { target: "r/1" } },
      { path: "/api/land", method: "POST", body: { target: "r/1", sha } },
    ]);
    for (const input of [
      { verdict: "approve", findings: [finding] },
      { verdict: "changes", findings: [] },
      { verdict: "other", findings: [] },
      { verdict: "approve", findings: [], reviewedSha: "short" },
      { verdict: "changes" },
      { verdict: "changes", findings: [{ ...finding, line: 0 }] },
      { verdict: "changes", findings: [{ ...finding, title: " " }] },
      { verdict: "changes", findings: [{ ...finding, severity: "critical" }] },
      { verdict: "approve", findings: [], extra: true },
    ])
      expect((await call("review", { run: "r/1", reviewedSha: sha, ...input })).isError).toBe(true);
    expect((await call("land", { run: " " })).isError).toBe(true);
    expect((await call("land", { run: "r/1", sha: 12 })).isError).toBe(true);
    expect(requests).toHaveLength(5);
  } finally {
    await proxy.close();
  }
});

test("review and land refusals or uncertain responses are MCP errors without retries", async () => {
  for (const response of [
    () => Response.json({ error: "reviewed SHA moved; land rejected" }, { status: 409 }),
    () => {
      throw new Error("connection lost");
    },
    () => new Response("invalid JSON"),
  ]) {
    let requests = 0;
    const proxy = await connect(
      httpBackend("http://daemon.invalid", async () => {
        requests++;
        return response();
      }),
    );
    try {
      for (const name of ["review", "land"]) {
        const result = await proxy.client.callTool({
          name: `limitless_${name}`,
          arguments:
            name === "review"
              ? { run: "r1", verdict: "approve", reviewedSha: "a".repeat(40), findings: [] }
              : { run: "r1" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/HTTP 409|Cannot reach|Malformed JSON/);
      }
      expect(requests).toBe(2);
    } finally {
      await proxy.close();
    }
  }
});

test("status explains review, input, land and terminal states using saved observations", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
  const sha = "a".repeat(40),
    prUrl = "https://github.com/o/r/pull/1";
  const base = {
    ...f.factory.store.getRunDetail(run.id),
    run: { ...run, status: "succeeded", prUrl },
    prSnapshot: { state: "OPEN", headRefOid: sha },
    prHead: { sha, version: 1, pushing: false },
    review: { approval: null, rounds: [] },
  };
  const entry = { id: 1, runId: run.id, prUrl, state: "queued", reason: null };
  let detail: unknown = base;
  let lands: unknown = [];
  const urls: string[] = [];
  const proxy = await connect(
    httpBackend("http://daemon.invalid", async (url) => {
      urls.push(new URL(url).pathname);
      if (url.includes("missing")) return Response.json({ error: "not found" }, { status: 404 });
      const parsed = new URL(url);
      if (parsed.pathname === "/api/land") expect(parsed.searchParams.get("run")).toBe(run.id);
      return Response.json(parsed.pathname === "/api/land" ? lands : detail);
    }),
  );
  const read = () => proxy.client.callTool({ name: "limitless_status", arguments: { run: run.id } });
  try {
    for (const [patch, land, state, action] of [
      [{}, [], "Review needed", "limitless_review"],
      [{ prSnapshot: { state: "OPEN" } }, [], "PR head unknown", "current PR head"],
      [{ prSnapshot: { state: "OPEN", headRefOid: "bad" } }, [], "PR head unknown", "current PR head"],
      [{ prSnapshot: { state: "OPEN", headRefOid: null } }, [], "PR head unknown", "current PR head"],
      [{ prSnapshot: null }, [], "PR state unknown", "Inspect the PR"],
      [
        { prSnapshot: { state: "OPEN" }, review: { approval: { sha, stale: false }, rounds: [] } },
        [],
        "PR head unknown",
        "current PR head",
      ],
      [
        { review: { approval: { sha, stale: false }, rounds: [] } },
        [],
        "Approved; landing not queued",
        "limitless_land",
      ],
      [{ review: { approval: { sha, stale: true }, rounds: [] } }, [], "Review needed", "limitless_review"],
      [
        {
          prSnapshot: { state: "OPEN", headRefOid: "b".repeat(40) },
          prHead: { sha: "b".repeat(40), version: 2, pushing: false },
          review: { approval: { sha, stale: false }, rounds: [] },
        },
        [],
        "Review needed",
        "limitless_review",
      ],
      [{}, [entry], "Landing in progress (queued)", "Wait"],
      [{}, [{ ...entry, state: "waiting_ci" }], "Landing in progress (waiting_ci)", "Wait"],
      [{}, [{ ...entry, state: "blocked", reason: "CI failed" }], "Landing blocked", "resolve the blocker"],
      [{}, [{ ...entry, state: "landed" }], "Landed", "No action needed"],
      [{ prSnapshot: { state: "MERGED" } }, [], "Landed", "No action needed"],
      [{ run: { ...run, status: "succeeded", prUrl: null } }, [], "Completed", "delivery results"],
      [{ run: { ...run, status: "failed" } }, [], "Failed", "error"],
      [{ run: { ...run, status: "cancelled" } }, [], "Cancelled", "new run"],
      [{ run: { ...run, status: "queued" } }, [], "Work pending", "Wait"],
      [{ questions: [{ answer: null }] }, [], "Input needed", "limitless_answer_question"],
      [
        { review: { approval: null, rounds: [{ runId: "round1", status: "running" }] } },
        [],
        "Review changes in progress",
        "round1",
      ],
      [
        { review: { approval: null, rounds: [{ runId: "round1", status: "waiting_input" }] } },
        [],
        "Input needed",
        "round1",
      ],
      [
        { review: { approval: null, rounds: [{ runId: "round1", status: "failed" }] } },
        [],
        "Review changes failed",
        "round1",
      ],
      [
        {
          review: {
            approval: { sha, stale: false },
            approvedAt: 20,
            rounds: [
              { runId: "newer", status: "waiting_input", createdAt: 30 },
              { runId: "older", status: "failed", createdAt: 10 },
            ],
          },
        },
        [],
        "Input needed",
        "newer",
      ],
      [
        {
          review: {
            approval: { sha, stale: false },
            approvedAt: 20,
            rounds: [{ runId: "delivered", status: "succeeded", createdAt: 30 }],
          },
        },
        [],
        "Review needed",
        "limitless_review",
      ],
    ] as const) {
      detail = { ...base, ...patch };
      lands = land;
      const result = resultValue<{ state: string; nextAction: string }>(await read());
      expect(result.state).toBe(state);
      expect(result.nextAction).toContain(action);
      if (state === "Review needed") {
        expect(result.nextAction).toMatch(/[a-f0-9]{40}/);
        expect(result.nextAction).toContain("limitless_get_change");
      }
      if (state === "PR head unknown") expect(result.nextAction).not.toContain("limitless_review");
    }
    lands = [
      { ...entry, id: 2, state: "landed" },
      { ...entry, state: "blocked" },
    ];
    detail = base;
    expect(resultValue<unknown>(await read())).toMatchObject({ state: "Landed" });
    const before = urls.length;
    const missing = await proxy.client.callTool({ name: "limitless_status", arguments: { run: "missing" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("not found");
    expect(urls.slice(before)).toEqual(["/api/runs/missing"]);
  } finally {
    await proxy.close();
  }
});

test.each(["failed", "cancelled"] as const)(
  "status lets a later approval supersede a %s round on both backends",
  async (status) => {
    const { store } = f.factory;
    const repo = store.upsertRepo({
      slug: "o/r",
      kind: "github",
      url: "https://github.com/o/r",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "work" });
    const prUrl = "https://github.com/o/r/pull/1",
      sha = "a".repeat(40);
    store.updateRun(run.id, { status: "succeeded", prUrl, branch: "limitless/feature" });
    store.saveGithubPr({
      url: prUrl,
      repo: "o/r",
      runId: run.id,
      delivered: 1,
      nodeId: "PR_1",
      data: JSON.stringify({ state: "OPEN", headRefOid: sha }),
    });
    const round = store.createReviewRound(
      repo,
      store.getRun(run.id) as Run,
      { prUrl, reviewedSha: sha, findings: [{ severity: "major", title: "Fix", detail: "Bug" }], cap: 3 },
      (round) => ({
        repo: repo.slug,
        prompt: "Fix findings",
        baseBranch: "limitless/feature",
        deliveryBranch: "limitless/feature",
        sourceRef: { kind: "review-round", runId: run.id, round, prUrl, reviewedSha: sha },
      }),
    );
    if (!("run" in round)) throw new Error("Expected a review round");
    store.updateRun(round.run.id, { status });
    store.db.query("UPDATE review_rounds SET created_at = ? WHERE run_id = ?").run(10, round.run.id);
    store.observePrHead(prUrl, sha);
    store.recordApproval(run.id, prUrl, sha, "reviewer");
    store.db.query("UPDATE review_approvals SET created_at = ? WHERE pr_url = ?").run(20, prUrl);
    const routes = createHttpRoutes(f.factory);
    const proxy = await connect(
      httpBackend("http://daemon.invalid", async (url, init) => {
        const path = new URL(url).pathname;
        const route = routes[path === "/api/land" ? path : "/api/runs/:id"];
        const handler = (typeof route === "function" ? route : (route as { GET: Route }).GET) as Route;
        return handler(requestWithParams(url, init, { id: run.id }), localServer);
      }),
    );
    const direct = await connect(factoryBackend(f.factory));
    try {
      for (const conn of [proxy, direct]) {
        const result = resultValue<{ state: string; nextAction: string }>(
          await conn.client.callTool({ name: "limitless_status", arguments: { run: run.id } }),
        );
        expect(result.state).toBe("Approved; landing not queued");
        expect(result.nextAction).toContain("limitless_land");
      }
    } finally {
      await proxy.close();
      await direct.close();
    }
  },
);

test("status finds the latest land by run or PR beyond 100 historical entries on both backends", async () => {
  const { store } = f.factory;
  const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
  const prUrl = "https://github.com/o/r/pull/101";
  const sha = "a".repeat(40);
  store.updateRun(run.id, { status: "succeeded", prUrl });
  store.saveGithubPr({
    url: prUrl,
    repo: "o/r",
    runId: run.id,
    delivered: 1,
    nodeId: "PR_101",
    data: JSON.stringify({ state: "OPEN", headRefOid: sha }),
  });
  store.recordApproval(run.id, prUrl, sha, "reviewer");
  const createEntry = (runId: string, pr: string) =>
    store.createLandEntry({
      runId,
      repo: "o/r",
      prUrl: pr,
      baseBranch: "main",
      headBranch: "pr-branch",
      approvedSha: sha,
    });
  store.db.transaction(() => {
    for (let i = 1; i <= 100; i++) {
      const entry = createEntry(`historical-${i}`, `https://github.com/o/r/pull/${i}`);
      store.updateLandEntry(entry.id, { state: "landed" });
    }
  })();
  const blocked = createEntry("review-round", prUrl);
  store.updateLandEntry(blocked.id, { state: "blocked", reason: "CI failed" });
  const routes = createHttpRoutes(f.factory);
  const proxy = await connect(
    httpBackend("http://daemon.invalid", async (url, init) => {
      const path = new URL(url).pathname;
      const route = routes[path === "/api/land" ? path : "/api/runs/:id"];
      const handler = (typeof route === "function" ? route : (route as { GET: Route }).GET) as Route;
      return handler(requestWithParams(url, init, { id: run.id }), localServer);
    }),
  );
  const direct = await connect(factoryBackend(f.factory));
  const check = async (state: string, id: number, reason: string | null) => {
    for (const conn of [proxy, direct]) {
      const result = await conn.client.callTool({ name: "limitless_status", arguments: { run: run.id } });
      expect(resultValue(result)).toMatchObject({ state, land: { id, reason } });
    }
  };
  try {
    expect(f.factory.land.list()).toHaveLength(100);
    await check("Landing blocked", blocked.id, "CI failed");
    const queued = createEntry(run.id, prUrl);
    await check("Landing in progress (queued)", queued.id, null);
    store.updateLandEntry(queued.id, { state: "landed" });
    await check("Landed", queued.id, null);
  } finally {
    await proxy.close();
    await direct.close();
  }
});

test.each([
  ["direct", "readable"],
  ["proxy", "readable"],
  ["direct", "unreadable"],
  ["proxy", "unreadable"],
  ["direct", "invalid UTF-8"],
  ["proxy", "invalid UTF-8"],
] as const)("status protects every output field on %s with a %s denylist", async (backend, policy) => {
  const previousConfigDir = process.env.LIMITLESS_CONFIG_DIR;
  const configDir = join(f.home, "status-config");
  mkdirSync(configDir);
  process.env.LIMITLESS_CONFIG_DIR = configDir;
  const file = join(configDir, "private-strings.txt");
  const credential = "status-test-long-credential";
  const sensitive = `Private Prospect ${credential}`;
  registerCredential("STATUS_TEST_CREDENTIAL", credential);
  const { store } = f.factory;
  const run = await f.factory.createRun({ repo: f.repo, prompt: "work", title: sensitive });
  const prUrl = `https://github.com/o/r/pull/1?${sensitive}`;
  store.updateRun(run.id, { status: "succeeded", prUrl });
  store.askQuestion(run.id, `Question about ${sensitive}`);
  const land = store.createLandEntry({
    runId: sensitive,
    repo: "o/r",
    prUrl,
    baseBranch: "main",
    headBranch: "feature",
    approvedSha: "a".repeat(40),
  });
  store.updateLandEntry(land.id, { state: "blocked", reason: `CI failed for ${sensitive}` });
  if (policy === "readable") writeFileSync(file, "Private Prospect\nLanding blocked\nInspect\n");
  else if (policy === "unreadable") mkdirSync(file);
  else writeFileSync(file, Buffer.from([0xff]));
  const routes = createHttpRoutes(f.factory);
  const conn = await connect(
    backend === "direct"
      ? factoryBackend(f.factory)
      : httpBackend("http://daemon.invalid", async (url, init) => {
          const path = new URL(url).pathname;
          const route = routes[path === "/api/land" ? path : "/api/runs/:id"];
          const handler = (typeof route === "function" ? route : (route as { GET: Route }).GET) as Route;
          return handler(requestWithParams(url, init, { id: run.id }), localServer);
        }),
  );
  try {
    const result = await conn.client.callTool({ name: "limitless_status", arguments: { run: run.id } });
    const text = JSON.stringify(result);
    expect(text).not.toContain("Private Prospect");
    expect(text).not.toContain(credential);
    if (policy === "readable") {
      expect(resultValue(result)).toMatchObject({
        run: run.id,
        state: "[withheld: private text]",
        nextAction: "[withheld: private text]",
        land: { id: land.id, runId: "[withheld: private text]", reason: "[withheld: private text]" },
      });
    } else {
      expect(resultValue<unknown>(result)).toEqual({
        land: { id: land.id, state: "blocked" },
        openQuestions: 1,
      });
      expect(text).not.toContain(run.id);
      expect(text).not.toContain("CI failed");
    }
  } finally {
    await conn.close();
    if (previousConfigDir === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
    else process.env.LIMITLESS_CONFIG_DIR = previousConfigDir;
  }
});

test.each(["direct", "proxy"] as const)(
  "%s MCP withholds encoded private fields and errors",
  async (backend) => {
    const previous = process.env.LIMITLESS_CONFIG_DIR;
    const configDir = join(f.home, "privacy-config");
    mkdirSync(configDir);
    process.env.LIMITLESS_CONFIG_DIR = configDir;
    const file = join(configDir, "private-strings.txt");
    writeFileSync(file, "secret-host.example\n");
    registerCredential("PRIVACY_TEST_CREDENTIAL", "privacy-test-credential");
    const routes = createHttpRoutes(f.factory);
    const conn = await connect(
      backend === "direct"
        ? factoryBackend(f.factory)
        : httpBackend("http://daemon.invalid", async (url, init) => {
            const path = new URL(url).pathname;
            const match = path.match(/^\/api\/runs\/([^/]+)(\/events)?$/);
            const route = routes[match ? `/api/runs/:id${match[2] ?? ""}` : path];
            const handler = (typeof route === "function" ? route : (route as { GET: Route }).GET) as Route;
            return handler(
              requestWithParams(url, init, { id: decodeURIComponent(match?.[1] ?? "") }),
              localServer,
            );
          }),
    );
    try {
      for (const text of privacyTexts) {
        const after = f.factory.store.readFeed({ from: "now" }).nextAfter;
        const run = await f.factory.createRun({ repo: f.repo, prompt: "work", title: `Title ${text}` });
        f.factory.store.updateRun(run.id, { status: "failed", error: `Failure ${text}` });
        f.factory.store.askQuestion(run.id, `Question ${text}`);
        const land = f.factory.store.createLandEntry({
          runId: run.id,
          repo: "o/r",
          prUrl: "https://github.com/o/r/pull/1",
          baseBranch: "main",
          headBranch: "feature",
          approvedSha: "a".repeat(40),
        });
        f.factory.store.updateLandEntry(land.id, { state: "blocked", reason: `Reason ${text}` });
        const detail = resultValue<{ title: string; error: string; questions: { question: string }[] }>(
          await conn.client.callTool({ name: "limitless_get_run", arguments: { id: run.id, full: true } }),
        );
        expect(detail).toMatchObject({
          title: "[withheld: private text]",
          error: "[withheld: private text]",
          questions: [{ question: "[withheld: private text]" }],
        });
        const status = resultValue<{ land: { reason: string }; state: string }>(
          await conn.client.callTool({ name: "limitless_status", arguments: { run: run.id } }),
        );
        expect(status).toMatchObject({
          state: "Landing blocked",
          land: { reason: "[withheld: private text]" },
        });
        f.factory.store.db
          .query(`INSERT INTO feed (ts, kind, run_id, title, summary, data, dedupe_key)
          VALUES (1, 'review.round_delivered', ?, 'Safe round title', ?, ?, ?)`)
          .run(run.id, `Round ${text}`, JSON.stringify({ nested: [{ [text]: text }] }), run.id);
        const feed = resultValue<FeedPage>(
          await conn.client.callTool({ name: "limitless_feed", arguments: { after } }),
        );
        expect(feed.items.filter((item) => item.runId === run.id).map((item) => item.summary)).toEqual([
          "[withheld: private text]",
          "[withheld: private text]",
          "[withheld: private text]",
        ]);
        expect(
          feed.items.find((item) => item.runId === run.id && item.kind === "review.round_delivered")?.data,
        ).toEqual({ nested: [{ "[withheld: private text]": "[withheld: private text]" }] });
        const error = await conn.client.callTool({ name: "limitless_status", arguments: { run: text } });
        expect(error.isError).toBe(true);
        expect(error.content).toEqual([
          {
            type: "text",
            text:
              backend === "direct" ? "[withheld: private text]" : 'Daemon HTTP 404: {"error":"not found"}',
          },
        ]);
      }
      mkdirSync(join(configDir, "bad"));
      process.env.LIMITLESS_CONFIG_DIR = join(configDir, "bad");
      mkdirSync(join(configDir, "bad", "private-strings.txt"));
      const error = await conn.client.callTool({
        name: "limitless_status",
        arguments: { run: privacyTexts[0] },
      });
      expect(error.isError).toBe(true);
      expect(error.content).toEqual([{ type: "text", text: "MCP tool failed; privacy policy unavailable." }]);
    } finally {
      await conn.close();
      if (previous === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
      else process.env.LIMITLESS_CONFIG_DIR = previous;
    }
  },
);

test("status filters proxy response and connection exception text, including unreadable policy", async () => {
  const previous = process.env.LIMITLESS_CONFIG_DIR;
  const configDir = join(f.home, "proxy-error-config");
  mkdirSync(configDir);
  process.env.LIMITLESS_CONFIG_DIR = configDir;
  writeFileSync(join(configDir, "private-strings.txt"), "secret-host.example\n");
  registerCredential("PRIVACY_TEST_CREDENTIAL", "privacy-test-credential");
  try {
    for (const mode of ["http", "json", "connection", "unreadable"] as const) {
      if (mode === "unreadable") process.env.LIMITLESS_CONFIG_DIR = join(configDir, "private-strings.txt");
      for (const text of privacyTexts) {
        const conn = await connect(
          httpBackend(`http://daemon.invalid/${text}`, async () => {
            if (mode === "connection") throw new Error(`Connection ${text}`);
            if (mode === "json") return Response.json({ error: `Upstream ${text}` }, { status: 503 });
            return new Response(`Upstream ${text}`, { status: 503 });
          }),
        );
        try {
          const result = await conn.client.callTool({
            name: "limitless_status",
            arguments: { run: "missing" },
          });
          expect(result.isError).toBe(true);
          expect(result.content).toEqual([
            {
              type: "text",
              text:
                mode === "unreadable"
                  ? "MCP tool failed; privacy policy unavailable."
                  : "[withheld: private text]",
            },
          ]);
        } finally {
          await conn.close();
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
    else process.env.LIMITLESS_CONFIG_DIR = previous;
  }
});

test("connection, HTTP and malformed responses are MCP errors and mutations are never retried", async () => {
  for (const [response, expected] of [
    [
      () => {
        throw new Error("offline");
      },
      "Cannot reach",
    ],
    [() => new Response("upstream failed", { status: 503 }), "HTTP 503"],
    [() => new Response("not JSON"), "Malformed JSON"],
    [() => Response.json({ unexpected: true }), "Invalid"],
  ] as const) {
    let calls = 0;
    const proxy = await connect(
      httpBackend("http://daemon.invalid", async () => {
        calls++;
        return response();
      }),
    );
    try {
      const result = await proxy.client.callTool({
        name: "limitless_create_run",
        arguments: { repo: f.repo, prompt: "x" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(expected);
      expect(calls).toBe(1);
      calls = 0;
      const resolved = await proxy.client.callTool({
        name: "limitless_resolve_run",
        arguments: { id: "run", kind: "wont_do" },
      });
      expect(resolved.isError).toBe(true);
      expect(calls).toBe(1);
      expect((await proxy.client.listTools()).tools).toHaveLength(13);
    } finally {
      await proxy.close();
    }
  }
});

test("stdio streams emit only protocol JSON and survive daemon errors", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const server = createMcpServer(
    httpBackend("http://daemon.invalid", async () => {
      throw new Error("offline");
    }),
  );
  await server.connect(new StdioServerTransport(stdin, stdout));
  try {
    for (const message of [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "limitless_providers", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    ])
      stdin.write(`${JSON.stringify(message)}\n`);
    for (let i = 0; i < 100 && output.trim().split("\n").length < 3; i++) await Bun.sleep(5);
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.jsonrpc === "2.0")).toBe(true);
    expect(messages.find((m) => m.id === 2).result.isError).toBe(true);
    expect(messages.find((m) => m.id === 3).result.tools).toHaveLength(13);
  } finally {
    await server.close();
    stdin.destroy();
    stdout.destroy();
  }
});

test("stdio MCP returns only public records across every tool and error", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "private diagnostics" });
  const marker = "OWNER_MCP_STDIO_ONLY_423";
  f.factory.store.recordOwnerDiagnostic({ runId: run.id, kind: "run-error", text: marker }, "public");
  expect(diagnosticCatalogue.ownerDiagnostics(f.factory.store.db, run.id)).toMatchObject([{ text: marker }]);
  f.factory.store.updateRun(run.id, { status: "failed", error: "public" });
  f.factory.store.addEvent({ runId: run.id, type: "log", message: "public event" });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = createMcpServer(factoryBackend(f.factory));
  const direct = await connect(factoryBackend(f.factory));
  const tools = (await direct.client.listTools()).tools;
  await direct.close();
  const responses = new Map<number, (value: unknown) => void>();
  let buffer = "";
  stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      responses.get(message.id)?.(message);
    }
  });
  await server.connect(new StdioServerTransport(stdin, stdout));
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      responses.set(++id, resolve);
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await call("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const reads = [
      [
        "limitless_get_run",
        { id: run.id, full: true },
        {
          id: run.id,
          error: "public",
          events: expect.arrayContaining([expect.objectContaining({ message: "public event" })]),
        },
      ],
      [
        "limitless_list_runs",
        { status: "failed", limit: 1 },
        { runs: [{ id: run.id, error: "public" }], hasMore: false },
      ],
      ["limitless_feed", { after: 0, wait: 0 }, { items: [{ runId: run.id }] }],
      ["limitless_status", { run: run.id }, { run: run.id, state: "Failed" }],
      ["limitless_providers", {}, [{ id: "fake" }]],
    ] as const;
    for (const [name, args, expected] of reads) {
      const message = await call("tools/call", { name, arguments: args });
      const result = CallToolResultSchema.parse(JSONRPCResultResponseSchema.parse(message).result);
      expect(result.isError).not.toBe(true);
      expect(resultValue(result)).toMatchObject(expected);
      expect(JSON.stringify(message)).not.toContain(marker);
    }
    for (const tool of tools) {
      if (reads.some(([name]) => name === tool.name)) continue;
      const message = await call("tools/call", { name: tool.name, arguments: {} });
      expect(CallToolResultSchema.parse(JSONRPCResultResponseSchema.parse(message).result).isError).toBe(
        true,
      );
      expect(JSON.stringify(message)).not.toContain(marker);
    }
  } finally {
    await server.close();
    stdin.destroy();
    stdout.destroy();
  }
});

test("proxy feed tools match the direct backend and allow a 45-second long poll", async () => {
  const routes = createHttpRoutes(f.factory);
  const fetcher: Fetch = async (url, init) => {
    const path = new URL(url).pathname as "/api/feed" | "/api/feed/ack";
    const handler = (routes[path] as Record<string, Route>)[init?.method ?? "GET"] as Route;
    return handler(requestWithParams(url, init), localServer);
  };
  const proxy = await connect(httpBackend("http://127.0.0.1:7400", fetcher));
  const direct = await connect(factoryBackend(f.factory));
  const timeouts = spyOn(AbortSignal, "timeout");
  try {
    const run = await f.factory.createRun({ repo: f.repo, prompt: "work" });
    f.factory.store.updateRun(run.id, { status: "needs_human", error: "pick a name" });
    f.factory.store.askQuestion(run.id, "Which name?");
    const read = (conn: typeof proxy, args: Record<string, unknown>) =>
      conn.client.callTool({ name: "limitless_feed", arguments: args });
    for (const args of [{ consumer: "proxy" }, { after: 1 }, {}])
      expect(resultValue<unknown>(await read(proxy, args))).toEqual(
        resultValue<unknown>(await read(direct, args)),
      );
    timeouts.mockClear();
    expect(resultValue<unknown>(await read(proxy, { consumer: "proxy", wait: 45 }))).toEqual(
      resultValue<unknown>(await read(direct, { consumer: "proxy", wait: 45 })),
    );
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([75_000]);
    timeouts.mockClear();
    const ack = await proxy.client.callTool({
      name: "limitless_feed_ack",
      arguments: { consumer: "proxy", id: 1 },
    });
    expect(resultValue<unknown>(ack)).toEqual({ consumer: "proxy", id: 1 });
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([30_000]);
    const page = resultValue<{ items: { id: number }[] }>(await read(proxy, { consumer: "proxy" }));
    expect(page.items.map((i) => i.id)).toEqual([2]);
    expect(resultValue<unknown>(await read(proxy, { consumer: "proxy" }))).toEqual(
      resultValue<unknown>(await read(direct, { consumer: "proxy" })),
    );
    expect((await read(proxy, { wait: 46 })).isError).toBe(true);
  } finally {
    timeouts.mockRestore();
    await proxy.close();
    await direct.close();
  }
});

test("cancelling a proxied feed long poll aborts the daemon request", async () => {
  let seen: AbortSignal | undefined;
  const fetcher: Fetch = (_url, init) =>
    new Promise((_, reject) => {
      seen = init?.signal ?? undefined;
      seen?.addEventListener("abort", () => reject(seen?.reason));
    });
  const proxy = await connect(httpBackend("http://127.0.0.1:7400", fetcher));
  try {
    const controller = new AbortController();
    const pending = proxy.client
      .callTool({ name: "limitless_feed", arguments: { wait: 45 } }, undefined, { signal: controller.signal })
      .catch(() => "cancelled");
    await Bun.sleep(20);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(await pending).toBe("cancelled");
    await Bun.sleep(20);
    expect(seen?.aborted).toBe(true);
  } finally {
    await proxy.close();
  }
});
