import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { Repo } from "../core/types.ts";
import { loadPrivateStrings, type PrivateStrings } from "../gates/private.ts";
import { checkPublicationText } from "../gates/publication.ts";
import { registeredCredentials } from "../util/proc.ts";
import type { GitHubIdentity } from "./github-identity.ts";

const blocked = { status: "blocked", diagnostic: "Defect publication blocked" } as const;
const text = (bytes = 256) => z.string().refine((v) => Buffer.byteLength(v) <= bytes);
const privateIp = /^(?:127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$)/u;
const identity = text().refine((v) => {
  const url = URL.parse(v);
  if (url?.protocol === "file:" || /\[redacted[^\]]*\]|^\s*(?:[/~]|[a-z]:|\\\\)/iu.test(v)) return false;
  const host = (url?.hostname ?? "").toLowerCase().replace(/^\[|\]$|\.$/gu, "");
  return !!v.trim() && !/^localhost$|\.local$/u.test(host) && !(isIP(host) && privateIp.test(host));
});
const slug = identity.refine((v) =>
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/(?!\.{1,2}$)[a-z0-9_.-]+$/iu.test(v),
);
const refs = z.array(identity).max(8).default([]);
const evidence = z.strictObject({
  sourceId: identity,
  detector: text(32).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u),
  class: text(64).refine((v) => !!v.trim()),
  history: z.array(text(64)).max(8).default([]),
  phase: z.enum(["setup", "check"]),
  checkIdentity: identity,
  shas: z
    .array(text().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u))
    .max(8)
    .default([]),
  runRefs: refs,
  landRefs: refs,
  checkedPrContext: z.array(z.number().int().positive()).max(8).default([]),
  timestamps: z.array(text().datetime()).max(8).default([]),
  machineRole: text().default("unknown"),
});
export type DefectEvidence = z.input<typeof evidence>;
type PrivacyDeps = {
  loadPrivateStrings?: () => PrivateStrings;
  registeredCredentials?: () => readonly string[];
};
export type DefectPreparationDeps = PrivacyDeps & {
  repos: readonly Repo[];
  factory: string;
  policy: (repo: Repo | string) => Promise<{ discreet: boolean } | undefined>;
  identity: (repo: string) => Promise<GitHubIdentity | undefined>;
};

/** Compact JSON codec; JSON.parse recovers every logical value before privacy checking. */
function encodeData(data: unknown): string {
  return JSON.stringify(data).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) =>
    c
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}
function logicalStrings(data: unknown): string[] {
  if (typeof data === "string") return [data];
  if (Array.isArray(data)) return data.flatMap(logicalStrings);
  return data && typeof data === "object" ? Object.values(data).flatMap(logicalStrings) : [];
}

/** Reusable pre-persistence / pre-POST guard. Refusals never expose payloads or exceptions. */
export function guardDefectPublication(payload: { title: string; body: string }, deps: PrivacyDeps) {
  try {
    const projection = `${payload.title}\n${payload.body}`;
    if (Buffer.byteLength(projection) > 32 * 1024) return blocked;
    const lines = payload.body.split("\n");
    const encoded = lines.at(-2) ?? "";
    const fence = lines.at(-1) ?? "";
    if (!/^`{3,}$/u.test(fence) || lines.at(-3) !== `${fence}json`) return blocked;
    const data: unknown = JSON.parse(encoded);
    if (encodeData(data) !== encoded) return blocked;
    const policy = (deps.loadPrivateStrings ?? loadPrivateStrings)();
    const credentials = (deps.registeredCredentials ?? registeredCredentials)();
    const offset = Math.max(0, ...policy.map((entry) => entry.entry));
    const entries = [...policy, ...credentials.map((value, i) => ({ value, entry: offset + i + 1 }))];
    for (const value of [...logicalStrings(data), projection]) checkPublicationText(value, "Defect", entries);
    return { status: "safe" } as const;
  } catch {
    return blocked;
  }
}

export function parseDefectEnvelope(body: string, kind: "issue" | "comment") {
  const newline = body.indexOf("\n");
  if (newline < 0) return undefined;
  const first = body.slice(0, newline);
  const match = /^<!-- limitless-defect:v1:(issue|comment):([a-f0-9]{64}):([a-f0-9]{32}) -->$/u.exec(first);
  return match?.[1] === kind ? { signature: match[2], occurrence: match[3] } : undefined;
}

/** Data preparation only: no posting authority and no production caller in D1a.1. */
export async function prepareDefectPublication(
  input: DefectEvidence,
  deps: DefectPreparationDeps,
  envelopeKind: "issue" | "comment" = "issue",
) {
  try {
    const finding = evidence.parse(input);
    const sources = deps.repos.filter((repo) => repo.id === finding.sourceId);
    const source = sources[0];
    if (sources.length !== 1 || !source || !["github", "local"].includes(source.kind)) return blocked;
    const sourceIdentity =
      source.kind === "github" ? slug.parse(source.slug).toLowerCase() : identity.parse(source.id);
    if (
      deps.repos.filter(
        (repo) =>
          repo.kind === source.kind &&
          (repo.kind === "github" ? repo.slug.toLowerCase() : repo.id) === sourceIdentity,
      ).length !== 1
    )
      return blocked;
    const destination = slug.parse(deps.factory).toLowerCase();
    const sourcePolicy = await deps.policy(source);
    const destinationPolicy = await deps.policy(destination);
    if (sourcePolicy?.discreet !== false || destinationPolicy?.discreet !== false) return blocked;
    const app = await deps.identity(destination);
    if (app?.kind !== "app" || !identity.safeParse(app.botLogin).success) return blocked;
    if (["regression", "base_failure"].includes(finding.class)) return { status: "no-report" } as const;
    const kind = ["setup", "confinement", "load"].includes(finding.class) ? "defect" : "triage";
    const signature = createHash("sha256")
      .update(
        JSON.stringify([
          "defect/1",
          finding.detector,
          [source.kind, sourceIdentity],
          finding.class,
          finding.phase,
          finding.checkIdentity,
        ]),
      )
      .digest("hex");
    const occurrence = randomBytes(16).toString("hex");
    const { sourceId: _sourceId, machineRole, ...supplied } = finding;
    const encoded = encodeData({
      ...supplied,
      sourceKind: source.kind,
      sourceIdentity,
      machineRole: ["coordinator", "worker"].includes(machineRole) ? machineRole : "unknown",
      introducingPr: "unknown",
    });
    const longest = Math.max(2, ...[...encoded.matchAll(/`+/gu)].map(([run]) => run.length));
    const fence = "`".repeat(longest + 1);
    const title = kind === "defect" ? "Factory defect" : "Factory defect triage";
    const prose =
      kind === "triage" ? "Destination unresolved; owner triage required." : "Recorded factory defect.";
    const body = `<!-- limitless-defect:v1:${envelopeKind}:${signature}:${occurrence} -->\n\n${prose}\n\n${fence}json\n${encoded}\n${fence}`;
    if (guardDefectPublication({ title, body }, deps).status !== "safe") return blocked;
    return { status: "prepared", destination, title, body, signature, occurrence, kind } as const;
  } catch {
    return blocked;
  }
}

const content = z.object({
  body: z.string(),
  author: z
    .object({ login: z.string().min(1), type: z.string().optional(), __typename: z.string().optional() })
    .nullable(),
  lastEditedAt: z.string().datetime({ offset: true }).nullable().optional(),
  includesCreatedEdit: z.boolean().nullable().optional(),
});
const item = content.extend({
  number: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  pull_request: z.unknown().optional(),
});
export type DefectItem = z.infer<typeof item>;

/** Shared issue/comment authentication; unavailable provenance requires reconciliation. */
export function defectRecordStatus(
  record: unknown,
  app: GitHubIdentity,
  signature: string,
  kind: "issue" | "comment",
): "match" | "blocked" | "ignored" {
  const parsed = content.safeParse(record);
  if (!parsed.success || app?.kind !== "app" || !identity.safeParse(app.botLogin).success) return "ignored";
  const value = parsed.data;
  if (
    !value.author ||
    value.author.login.toLowerCase() !== app.botLogin.toLowerCase() ||
    (value.author.type !== undefined && value.author.type !== "Bot") ||
    (value.author.__typename !== undefined && value.author.__typename !== "Bot") ||
    parseDefectEnvelope(value.body, kind)?.signature !== signature
  )
    return "ignored";
  return value.lastEditedAt === null && value.includesCreatedEdit === false ? "match" : "blocked";
}

type PageReader = (
  repo: string,
  options: {
    state: "all";
    page: number;
    perPage: number;
    signal?: AbortSignal;
  },
) => Promise<unknown>;
type Lookup =
  | { status: "unknown" | "blocked" | "absent" }
  | { status: "found"; issue: DefectItem; diagnostic?: "Duplicate defect issues" };

export async function lookupDefectIssue(
  factory: string,
  app: GitHubIdentity,
  signature: string,
  readPage: PageReader,
  signal?: AbortSignal,
): Promise<Lookup> {
  try {
    const destination = slug.parse(factory).toLowerCase();
    if (app.kind !== "app" || !identity.safeParse(app.botLogin).success || !/^[a-f0-9]{64}$/u.test(signature))
      return { status: "unknown" };
    const matches: DefectItem[] = [];
    let edited = false;
    for (let page = 1; ; page++) {
      signal?.throwIfAborted();
      const values = z
        .array(item)
        .max(100)
        .parse(await readPage(destination, { state: "all", page, perPage: 100, signal }));
      signal?.throwIfAborted();
      for (const value of values) {
        if ("pull_request" in value) continue;
        const status = defectRecordStatus(value, app, signature, "issue");
        if (status === "blocked") edited = true;
        if (status === "match") matches.push(value);
      }
      if (values.length < 100) break;
    }
    if (edited) return { status: "blocked" };
    matches.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
    const issue = matches[0];
    return issue
      ? {
          status: "found",
          issue,
          ...(matches.length > 1 ? { diagnostic: "Duplicate defect issues" as const } : {}),
        }
      : { status: "absent" };
  } catch {
    return { status: "unknown" };
  }
}
