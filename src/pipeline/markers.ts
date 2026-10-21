import { createHash } from "node:crypto";
import { worktreeGit } from "../git/command.ts";

/** Delivery idempotency accepts both modes, including after an operator changes the setting. */
export function deliveryMarker(kind: string, runId: string, discreet = false) {
  const label = kind === "verification" ? kind : `${kind}-round`;
  const legacy = `<!-- limitless-${label}:${runId} -->`;
  const opaque = `<!-- ${label}:${createHash("sha256").update(runId).digest("hex").slice(0, 12)} -->`;
  return {
    marker: discreet ? opaque : legacy,
    includes: (text?: string) => !!text && (text.includes(legacy) || text.includes(opaque)),
  };
}

export class DiscreetError extends Error {}

// Explicit addresses only: a person's email local part is not evidence of tooling.
const toolingEmails = new Set([
  "limitless@localhost",
  "noreply@anthropic.com",
  "noreply@openai.com",
  "codex@openai.com",
  "copilot@github.com",
  "copilot-swe-agent[bot]@users.noreply.github.com",
  "198982749+copilot[bot]@users.noreply.github.com",
  "198982749+copilot@users.noreply.github.com",
  "167198135+copilot[bot]@users.noreply.github.com",
  "199175422+chatgpt-codex-connector[bot]@users.noreply.github.com",
  "223556219+copilot@users.noreply.github.com",
]);
const toolName = /^(?:Limitless|Claude(?: Code)?|Codex|ChatGPT|GitHub Copilot|Gemini|Cursor|Aider)$/i;
const versionedTool =
  /^(?:(?:Limitless|Claude(?: Code)?|Codex|ChatGPT|GitHub Copilot|Gemini|Cursor|Aider)\b[\w .-]*\b\d+(?:[.-]\d+)*|GPT-\d+(?:\.\d+)* Codex)$/i;
const generationToolPrefix =
  /^(?:Limitless|Claude(?: Code)?|Codex|ChatGPT|GitHub Copilot|Gemini|Cursor|Aider|GPT-\d+(?:\.\d+)* Codex)\b/i;
const attributionTrailer =
  /^(co-?(?:authored|developed)-by|(?:signed-off|authored|reviewed|tested|suggested|acked|helped|assisted)-by|generated-(?:by|with))\s*[:=#]\s*(.*)$/is;

function attributionLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const previous = lines.at(-1);
    // Only trailers fold: an indented attribution after ordinary prose is still a new line.
    if (/^[ \t]/.test(line) && previous !== undefined && attributionTrailer.test(previous.trim()))
      lines[lines.length - 1] = `${previous}\n${line}`;
    else lines.push(line);
  }
  return lines;
}

function toolingIdentity(value: string): boolean {
  value = value.trim();
  const identity = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  const name = (identity?.[1] ?? value).trim();
  const email = (identity?.[2] ?? (value.includes("@") ? value : "")).trim().toLowerCase();
  return (
    toolingEmails.has(email) ||
    /^Limitless(?: Factory| Bot)?$/i.test(name) ||
    versionedTool.test(name) ||
    // Claude with a human email can be a person's first name; product names remain tooling.
    (toolName.test(name) && (!email || !/^Claude$/i.test(name)))
  );
}

/** Classify complete lines before quoting, clipping or table rendering can hide their structure. */
function toolingAttribution(line: string): boolean {
  const plain = line
    .replace(/\n[ \t]+/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/^\s*(?:>\s*|[-+]\s+)*/, "")
    .trim();
  if (/(?:built|verified|generated)\s+(?:by|with)\s+Limitless\b/i.test(plain)) return true;
  const trailer = attributionTrailer.exec(plain);
  const generation =
    /^(?:🤖\s*)?(generated|created|co-authored|co-developed|authored|assisted|built|verified)\s+(?:by|with)\s+(.+?)\.?$/i.exec(
      plain,
    );
  const value = trailer?.[2] ?? generation?.[2];
  if (value === undefined) return false;
  if (toolingIdentity(value)) return true;
  if (trailer || generation?.[1]?.toLowerCase() === "verified") return false;
  const identityPrefix = /^(?:.*?<[^<>]+>|\S+)/.exec(value)?.[0] ?? "";
  return generationToolPrefix.test(value) || toolingIdentity(identityPrefix);
}

export function stripToolAttribution(text: string): string {
  return attributionLines(text)
    .filter((line) => !toolingAttribution(line))
    .join("\n");
}

/** Only pass model-written fields here; factory-authored text must fail validation instead. */
export function discreetModelText<T>(value: T, discreet: boolean): T {
  return discreet
    ? JSON.parse(
        JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? stripToolAttribution(v) : v)),
      )
    : value;
}

/** One definition for outgoing reports, comments and commit messages/identities. */
export function hasFactoryMark(text: string, runId: string, uiUrl = "", identities: string[] = []): boolean {
  return (
    /^limitless:|^Run:\s/im.test(text) ||
    attributionLines(text).some(toolingAttribution) ||
    (!!runId && text.includes(runId)) ||
    (!!uiUrl && text.includes(`${uiUrl}/runs/`)) ||
    [0, 2].some((i) => toolingIdentity(`${identities[i] ?? ""} <${identities[i + 1] ?? ""}>`))
  );
}

export async function checkDiscreetCommits(
  cwd: string,
  range: string,
  base: string,
  runId: string,
  uiUrl = "",
) {
  const log = await worktreeGit(
    [
      "git",
      "log",
      "--encoding=UTF-8",
      "-z",
      "--format=%H%x00%B%x00%an%x00%ae%x00%cn%x00%ce",
      range,
      `^${base}`,
      "--",
    ],
    { cwd },
  ).catch(() => {
    throw new DiscreetError("Discreet mode cannot inspect unpublished commits");
  });
  const fields = log.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 6) throw new DiscreetError("Discreet mode cannot inspect unpublished commits");
  let trailerFlags: string[];
  const trailerEnv = { ...(process.env as Record<string, string>) };
  try {
    const config = await worktreeGit(
      ["git", "config", "--null", "--name-only", "--get-regexp", "^trailer\\."],
      { cwd, allowFail: true },
    );
    if (config.exitCode !== 0 && config.exitCode !== 1) throw new Error("Cannot read trailer config");
    // Restore Git's defaults for aliases as well as global options; --parse never adds trailers.
    const defaults: Record<string, string> = {
      where: "end",
      ifexists: "addIfDifferentNeighbor",
      ifmissing: "add",
    };
    trailerFlags = [...new Set(config.stdout.split("\0").filter(Boolean))].flatMap((key, i) => {
      const option = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
      const value = option === "key" ? key.slice("trailer.".length, -4) : (defaults[option] ?? "");
      const variable = `LIMITLESS_TRAILER_DEFAULT_${i}`;
      trailerEnv[variable] = value;
      // Subsection names may contain '='; --config-env splits at the last one.
      return [`--config-env=${key}=${variable}`];
    });
    trailerFlags.push("-c", "trailer.separators=:");
  } catch {
    throw new DiscreetError("Discreet mode cannot inspect commit attribution: trailer configuration");
  }
  const marked: string[] = [];
  for (let i = 0; i < fields.length; i += 6) {
    const sha = fields[i] ?? "";
    const message = fields[i + 1] ?? "";
    let trailers: string;
    try {
      trailers = (
        await worktreeGit(["git", ...trailerFlags, "interpret-trailers", "--parse", "--no-divider"], {
          cwd,
          stdin: message,
          env: trailerEnv,
        })
      ).stdout;
    } catch {
      throw new DiscreetError(`Discreet mode cannot inspect commit attribution: ${sha}`);
    }
    if (hasFactoryMark(`${trailers}\n${message}`, runId, uiUrl, fields.slice(i + 2, i + 6))) marked.push(sha);
  }
  if (marked.length)
    throw new DiscreetError(`Discreet mode blocked factory-marked commits: ${marked.join(", ")}`);
}
