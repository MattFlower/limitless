import { createHash } from "node:crypto";
import { z } from "zod";

const marker = "<!-- limitless-report:";
const spanSchema = z.object({
  kind: z.enum(["private", "verifier", "implementer", "prose"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  /** Complete rendering before clipping, so privacy matching never sees partial syntax. */
  source: z.string().optional(),
});
type Span = z.infer<typeof spanSchema>;
const manifestSchema = z.object({ digest: z.string(), spans: z.array(spanSchema) });
const digest = (body: string, spans: Span[]) =>
  createHash("sha256").update(body).update(JSON.stringify(spans)).digest("hex");

export type ReportPart = string | { kind: Span["kind"]; text: string; source?: string } | ReportPart[];

export function reportText(kind: Span["kind"], text: string, source?: string): ReportPart {
  return { kind, text, source };
}

export function reportJoin(parts: ReportPart[], separator: string): ReportPart[] {
  return parts.flatMap((part, index) => (index ? [separator, part] : [part]));
}

/** Keep Markdown unchanged and record the factory's spans in an integrity-checked manifest. */
export function markReport(blocks: ReportPart[]): string {
  let body = "";
  const spans: Span[] = [];
  const append = (part: ReportPart): void => {
    if (typeof part === "string") body += part;
    else if (Array.isArray(part)) part.forEach(append);
    else {
      spans.push({
        kind: part.kind,
        start: body.length,
        end: body.length + part.text.length,
        ...(part.source !== undefined ? { source: part.source } : {}),
      });
      body += part.text;
    }
  };
  append(reportJoin(blocks, "\n\n"));
  body += "\n";
  const manifest = Buffer.from(JSON.stringify({ digest: digest(body, spans), spans })).toString("base64url");
  return `${body}\n${marker}v3:${manifest} -->\n`;
}

/** null means a damaged marked report; undefined means a legacy, unmarked report. */
export function reportStructure(report: string): { body: string; spans: Span[] } | null | undefined {
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
    return parsed.data.digest === digest(body, spans) ? { body, spans } : null;
  } catch {
    return null;
  }
}

/** Publication keeps the Markdown body; only the stored change-view artifact needs metadata. */
export function stripReportManifest(report: string): string {
  return report.replace(/(?:^|\n)<!-- limitless-report:[^\n]*\n?$/u, "");
}
