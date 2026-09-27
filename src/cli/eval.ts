import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvalRequestSchema } from "../evals/cases.ts";
import { policyDiff, proposedOverlay, renderEvidence } from "../evals/evidence.ts";
import { formatEvalReport } from "../evals/format.ts";
import type { EvalPolicyResponse } from "../evals/policy.ts";
import type { EvalReport } from "../evals/stats.ts";
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
    const proposed = validatePolicy(proposedOverlay(existing, data.evaluation), data.models, data.providers);
    const document = `${JSON.stringify(proposed, null, 2)}\n`;
    const evidence = renderEvidence(data.evaluation);
    io.print(policyDiff(data.policy, overlayPolicy(DEFAULT_POLICY, proposed), data.evaluation));
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
  if (args.length !== 2 || !value || !["run", "report"].includes(action ?? ""))
    throw new Error(
      "usage: limitless eval run <role> --models model[@effort],model[@effort] | eval report <eval-id> [--json]",
    );
  if (action === "report") {
    const report = await io.api<EvalReport>(`/api/evals/${encodeURIComponent(value)}`);
    io.print(flags.json ? JSON.stringify(report) : formatEvalReport(report));
    return;
  }
  if (typeof flags.models !== "string" || !flags.models.trim())
    throw new Error("--models model[@effort],model[@effort] is required");
  const numeric = (key: string) => {
    const raw = flags[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(Number(raw)))
      throw new Error(`--${key} must be a finite number`);
    return Number(raw);
  };
  const request = {
    role: value,
    models: flags.models.split(","),
    k: numeric("k"),
    maxUsd: numeric("max-usd"),
    caseIds: typeof flags.cases === "string" ? flags.cases.split(",") : undefined,
    cache: !flags["no-cache"],
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
