/** Offline agent fixtures: real pipes and the same JSON/value redaction used by both harnesses. */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Holdout } from "../src/pipeline/schemas.ts";
import { type Context, type Fn, field, type Job, validate } from "./benchmark-gate-output-support.ts";

const holdout: Holdout = {
  scenarios: Array.from({ length: 8 }, (_, i) => ({
    id: `H-${i}`,
    description: `concealed phrase ${i}`,
    steps: `'privateScenario_${i}'`,
    expected: `hidden result ${i}`,
    edge_case: false,
  })),
};
const withheld = "[value withheld: holdout redaction limit or matcher failure]";
export const agentRegistry: Record<string, (c: Context) => Promise<Job[]> | Job[]> = {
  "agent-stream": async ({ a, cwd, env }) => {
    const bytes = 5 * 1048576,
      count = 2000,
      publicSources = "public fixture ".repeat(1600).slice(0, 20 * 1024);
    const secret = "synthetic-agent-benchmark-credential";
    (a.registerCredential as Fn)("AGENT_BENCHMARK", secret);
    const inputs: string[] = [],
      transcripts: string[] = [],
      parsed: string[] = [];
    for (let i = 0; i < count; i++) {
      const size = Math.floor(bytes / count) + Number(i < bytes % count);
      const prefix = `privateScenario_${i % 8} ${secret} `;
      const overhead = JSON.stringify({ type: "message", index: i, text: prefix }).length + 1;
      const padding = "ordinary ".repeat(400).slice(0, size - overhead);
      inputs.push(`${JSON.stringify({ type: "message", index: i, text: prefix + padding })}\n`);
      transcripts.push(
        JSON.stringify({
          type: "message",
          index: i,
          text: `[private detail] [redacted] ${padding} [1 private details withheld]`,
        }),
      );
      parsed.push(
        JSON.stringify({ type: "message", index: i, text: `privateScenario_${i % 8} [redacted] ${padding}` }),
      );
    }
    const text = inputs.join("");
    validate(Buffer.byteLength(text) === bytes, "exactly 5 MiB / 2000 lines");
    const file = join(cwd, "agent-stream");
    await fs.writeFile(file, text);
    const run = async () => {
      const redact = (a.holdoutRedactor as Fn)(holdout, publicSources) as Fn;
      const transcript: unknown[] = [],
        parser: unknown[] = [];
      const result = await (a.runProcess as Fn)({
        cmd: ["/bin/cat", file],
        cwd,
        env,
        onStdoutLine: (line: string) => {
          transcript.push(
            (a.redactJsonLine as Fn)(line, (s: string) => (a.redactCredentials as Fn)(redact(s))),
          );
          parser.push((a.redactJsonLine as Fn)(line, a.redactCredentials));
        },
      });
      return { result, transcript, parser };
    };
    return [
      [
        "runProcess/agent-stream",
        bytes,
        run,
        (v) => {
          validate(
            field(v, "result.exitCode") === 0 && !field(v, "result.capture"),
            "non-capture normal completion",
          );
          validate(
            JSON.stringify(field(v, "transcript")) === JSON.stringify(transcripts),
            "2000 ordered fully redacted transcripts",
          );
          return validate(
            JSON.stringify(field(v, "parser")) === JSON.stringify(parsed),
            "2000 ordered credential-redacted parser lines",
          );
        },
      ],
    ];
  },
  "holdout-repetitive": ({ a }) => {
    const publicSources = "a ".repeat(131072);
    const values = Array.from({ length: 8 }, (_, i) => `"${"a ".repeat(1900)}X${i}"`);
    // Cold cache, all eight observations in one classification operation.
    const run = () =>
      (
        (a.holdoutRedactor as Fn)(
          {
            scenarios: [
              { id: "H-1", description: "private", steps: "private", expected: "ok", edge_case: false },
            ],
          },
          publicSources,
        ) as Fn
      )(values.join("\n"));
    const safeBaseline = `${values.map(() => '"[private detail]"').join("\n")} [8 private details withheld]`;
    return [
      [
        "holdoutRedactor/cold-repetitive",
        publicSources.length,
        run,
        (v) =>
          validate(
            v === withheld || v === safeBaseline,
            v === withheld ? "bounded; wholly withheld" : "baseline; eight private literals removed",
          ),
      ],
    ];
  },
};
