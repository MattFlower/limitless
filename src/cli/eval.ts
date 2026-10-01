import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvalRequestSchema } from "../evals/cases.ts";
import { policyDiff, proposedOverlay, renderEvidence } from "../evals/evidence.ts";
import { formatEvalReport } from "../evals/format.ts";
import {
  OVERRIDES_PATH,
  parseOverrides,
  pinEvaluation,
  pinMessage,
  unevaluatedPins,
} from "../evals/overrides.ts";
import type { EvalPolicyResponse } from "../evals/policy.ts";
import type { EvalRegradeResult } from "../evals/runner.ts";
import type { EvalReport } from "../evals/stats.ts";
import { type EvalReviewSystem, parseEvalReviewSystems } from "../pipeline/review-system.ts";
import { DEFAULT_POLICY } from "../router/catalog.ts";
import { overlayPolicy, parsePolicy, validatePolicy } from "../router/policy.ts";

export { formatEvalReport } from "../evals/format.ts";

export interface EvalCliIO {
  files?: {
    read: (path: string) => Promise<string | null>;
    write: (path: string, text: string) => Promise<void>;
  };
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  print: (text: string) => void;
  wait: (ms: number) => Promise<unknown>;
}
export async function evalCommand(
  args: string[],
  flags: Record<string, string | boolean | undefined>,
  io: EvalCliIO,
): Promise<void> {
  const [action, value] = args;
  if (action === "policy") {
    if (args.length !== 1) throw new Error("usage: limitless eval policy [--evals id,id] [--write]");
    if (
      flags.evals !== undefined &&
      (typeof flags.evals !== "string" || flags.evals.split(",").some((id) => !id.trim()))
    )
      throw new Error("--evals requires nonempty eval IDs");
    const query = typeof flags.evals === "string" ? `?evals=${encodeURIComponent(flags.evals)}` : "";
    const data = await io.api<EvalPolicyResponse>(`/api/evals/policy${query}`);
    const files = io.files ?? {
      async read(path: string) {
        try {
          return await readFile(join(process.cwd(), path), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      async write(path: string, text: string) {
        await mkdir(join(process.cwd(), "routing"), { recursive: true });
        await writeFile(join(process.cwd(), path), text);
      },
    };
    const path = "routing/policy.json";
    const old = await files.read(path);
    const existing = old === null ? {} : parsePolicy(old, data.models, path, data.providers);
    const pins = parseOverrides(await files.read(OVERRIDES_PATH), existing);
    const evaluation = pinEvaluation(data.evaluation, pins);
    const proposed = validatePolicy(proposedOverlay(existing, evaluation), data.models, data.providers);
    const document = `${JSON.stringify(proposed, null, 2)}\n`;
    const unevaluated = unevaluatedPins(evaluation, pins);
    const evidence = `${renderEvidence(evaluation)}${unevaluated.map(([key, pin]) => `## ${key.replace(/\.default$/, "")}\n\n${pinMessage(pin)}\n\n`).join("")}`;
    const unpinned = {
      ...evaluation,
      roles: evaluation.roles.filter((r) => !pins.has(`${r.role}.${r.cell}`)),
    };
    io.print(policyDiff(data.policy, overlayPolicy(DEFAULT_POLICY, proposed), unpinned));
    for (const [key, pin] of [...pins].sort(([a], [b]) => (a < b ? -1 : 1)))
      io.print(`${key}: ${pinMessage(pin)}`);
    if (old === null)
      io.print("routing/policy.json is absent; --write creates the overlay and evidence files.");
    else if (JSON.stringify(existing) === JSON.stringify(proposed))
      io.print("Overlay unchanged; --write refreshes evidence.");
    if (flags.write) {
      await files.write(path, document);
      await files.write("routing/EVIDENCE.md", evidence);
      io.print(
        "Wrote routing/policy.json and routing/EVIDENCE.md. Review the diff; deploy/restart to activate.",
      );
    }
    return;
  }
  if (args.length !== 2 || !value || !["run", "report", "regrade", "resume", "cancel"].includes(action ?? ""))
    throw new Error(
      "usage: limitless eval run <role> --models model[@effort],model[@effort] | eval run review --systems <file.json> | eval report <eval-id> [--json] | eval regrade <eval-id> | eval resume <eval-id> [--allow-changed] | eval cancel <eval-id>",
    );
  if (action === "resume") {
    const { id } = await io.api<{ id: string }>(`/api/evals/${encodeURIComponent(value)}/resume`, {
      method: "POST",
      body: JSON.stringify(flags["allow-changed"] ? { allowChanged: true } : {}),
    });
    io.print(`${id} (resumes ${value})`);
    return;
  }
  if (action === "cancel") {
    const { status } = await io.api<{ status: string }>(`/api/evals/${encodeURIComponent(value)}/cancel`, {
      method: "POST",
      body: "{}",
    });
    io.print(`${value}: ${status}`);
    return;
  }
  if (action === "regrade") {
    const path = `/api/evals/${encodeURIComponent(value)}`;
    const result = await io.api<EvalRegradeResult>(`${path}/regrade`, { method: "POST", body: "{}" });
    io.print(
      `Regraded ${result.regraded} stored review trials from their outputs (${result.changed} changed); no model calls.`,
    );
    for (const s of result.skipped)
      io.print(`  kept stored grade: ${s.caseId} ${s.modelId} #${s.trial}: ${s.reason}`);
    io.print(formatEvalReport(await io.api<EvalReport>(path)));
    return;
  }
  if (action === "report") {
    const report = await io.api<EvalReport>(`/api/evals/${encodeURIComponent(value)}`);
    io.print(flags.json ? JSON.stringify(report) : formatEvalReport(report));
    return;
  }
  if (flags.systems !== undefined && flags.models !== undefined)
    throw new Error("--models and --systems are mutually exclusive");
  let systems: EvalReviewSystem[] | undefined;
  if (flags.systems !== undefined) {
    if (value !== "review") throw new Error("--systems is only supported for review evals");
    if (typeof flags.systems !== "string" || !flags.systems.trim())
      throw new Error("--systems requires a JSON file path");
    let text: string;
    try {
      text = await readFile(flags.systems, "utf8");
    } catch (error) {
      throw new Error(`cannot read --systems file ${flags.systems}: ${(error as Error).message}`);
    }
    systems = parseEvalReviewSystems(text, flags.systems);
  } else if (typeof flags.models !== "string" || !flags.models.trim())
    throw new Error(
      "--models model[@effort],model[@effort] (or, for review, --systems <file.json>) is required",
    );
  const numeric = (key: string) => {
    const raw = flags[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(Number(raw)))
      throw new Error(`--${key} must be a finite number`);
    return Number(raw);
  };
  const request = {
    role: value,
    ...(systems ? { systems } : { models: String(flags.models).split(",") }),
    k: numeric("k"),
    maxUsd: numeric("max-usd"),
    caseIds: typeof flags.cases === "string" ? flags.cases.split(",") : undefined,
    cache: !flags["no-cache"],
    concurrency: numeric("concurrency"),
    rounds: numeric("rounds"),
    strategy: flags.strategy,
  };
  EvalRequestSchema.parse(request);
  const { id } = await io.api<{ id: string }>("/api/evals", {
    method: "POST",
    body: JSON.stringify(request),
  });
  io.print(id);
  if (!flags.follow) return;
  for (;;) {
    const report = await io.api<EvalReport>(`/api/evals/${encodeURIComponent(id)}`);
    if (report.run.status !== "queued" && report.run.status !== "running") {
      io.print(formatEvalReport(report));
      return;
    }
    await io.wait(500);
  }
}
