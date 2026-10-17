import { createHash } from "node:crypto";
import { z } from "zod";
import { redactGateOutput } from "../gates/output.ts";

const marker = "<!-- limitless-report:";
const spanSchema = z.strictObject({
  kind: z.enum(["private", "verifier", "implementer", "prose"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  clipped: z.boolean().optional(),
});
type Span = z.infer<typeof spanSchema>;
const manifestSchema = z.object({ digest: z.string(), spans: z.array(spanSchema) });
const digest = (body: string, spans: Span[]) =>
  createHash("sha256").update(body).update(JSON.stringify(spans)).digest("hex");

export type ReportPart = string | { kind: Span["kind"]; text: string; source?: string } | ReportPart[];

export function reportText(kind: Span["kind"], text: string, source?: string) {
  return { kind, text, source };
}

export function reportJoin(parts: ReportPart[], separator: string): ReportPart[] {
  return parts.flatMap((part, index) => (index ? [separator, part] : [part]));
}

export const reportSourcesSchema = z.strictObject({
  digest: z.string(),
  sources: z.record(z.string(), z.string()),
});
export type ReportArtifacts = { report: string; sources: z.infer<typeof reportSourcesSchema> };

export function markReport(blocks: ReportPart[]): string {
  return markReportArtifacts(blocks).report;
}

/** Sanitize before measuring spans and hashing so the artifact boundary preserves the manifest. */
export function markReportArtifacts(blocks: ReportPart[]): ReportArtifacts {
  let body = "";
  const spans: Span[] = [];
  const sources: Record<string, string> = {};
  const append = (part: ReportPart): void => {
    if (typeof part === "string") body += redactGateOutput(part);
    else if (Array.isArray(part)) part.forEach(append);
    else {
      const text = redactGateOutput(part.text);
      if (part.source !== undefined) sources[spans.length] = redactGateOutput(part.source);
      spans.push({
        kind: part.kind,
        start: body.length,
        end: body.length + text.length,
        ...(part.source !== undefined ? { clipped: true } : {}),
      });
      body += text;
    }
  };
  append(reportJoin(blocks, "\n\n"));
  body += "\n";
  const hash = digest(body, spans);
  const manifest = Buffer.from(JSON.stringify({ digest: hash, spans })).toString("base64url");
  return { report: `${body}\n${marker}v3:${manifest} -->\n`, sources: { digest: hash, sources } };
}

/** null means a damaged marked report; undefined means a legacy, unmarked report. */
export function reportStructure(
  report: string,
): { body: string; spans: Span[]; digest: string } | null | undefined {
  if (!report.includes(marker)) return undefined;
  const footer = /\n<!-- limitless-report:v3:([A-Za-z0-9_-]+) -->\n$/u.exec(report);
  if (!footer) return null;
  try {
    const parsed = manifestSchema.safeParse(
      JSON.parse(Buffer.from(footer[1] ?? "", "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    const body = report.slice(0, footer.index);
    const { spans } = parsed.data;
    let end = 0;
    for (const span of spans) {
      if (span.start < end || span.end < span.start || span.end > body.length) return null;
      end = span.end;
    }
    return parsed.data.digest === digest(body, spans) ? { body, spans, digest: parsed.data.digest } : null;
  } catch {
    return null;
  }
}

/** Publication keeps the Markdown body; only the stored change-view artifact needs metadata. */
export function stripReportManifest(report: string): string {
  return report.replace(/(?:^|\n)<!-- limitless-report:[^\n]*\n?$/u, "");
}
