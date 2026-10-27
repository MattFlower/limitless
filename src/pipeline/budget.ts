import { unquoteGitHub } from "../integrations/github.ts";
import { redactCredentials } from "../util/proc.ts";

export type StatedBudget =
  | { kind: "figure"; lines: number; text: string }
  | { kind: "zero" | "ambiguous"; text: string }
  | null;
export function statedBudget(prompt: string, redact = redactCredentials): StatedBudget {
  const quoted = unquoteGitHub(prompt);
  const sources =
    quoted?.kind === "issue"
      ? [quoted.data.body]
      : quoted?.kind === "comment"
        ? [quoted.data.request, quoted.data.issueBody]
        : [prompt];
  for (const source of sources.filter((s) => typeof s === "string")) {
    let fence = "",
      depth = 0;
    const lines = source
      .split(/\r?\n/)
      .map((line) => {
        if (fence) {
          if (new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = "";
          return "";
        }
        fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? "";
        return fence ? "" : line;
      })
      .join("\n")
      .split(/(<\/?details\b[^>]*>)/gi)
      .filter((part) => {
        const tag = /^<(\/?)details\b/i.exec(part);
        if (tag) depth = Math.max(0, depth + (tag[1] ? -1 : 1));
        return !tag && depth === 0;
      })
      .join("")
      .split("\n");
    let start = lines.findIndex((line) => /^\s*#{1,6}\s+budget(?:\s+#+)?\s*$/i.test(line));
    if (start < 0)
      start = lines.findIndex((line) =>
        /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:Budget:|\*\*Budget\*\*:|\*\*Budget:\*\*)/i.test(line),
      );
    if (start < 0) continue;
    const level = /^\s*(#+)/.exec(lines[start] ?? "")?.[1]?.length;
    const end = lines.findIndex(
      (line, i) =>
        i > start &&
        (level ? (/^\s*(#{1,6})\s+/.exec(line)?.[1]?.length ?? Infinity) <= level : !line.trim()),
    );
    const section = lines.slice(start, end < 0 ? undefined : end).join("\n");
    const figure =
      /(?<![\w.,])\b(\d+(?:,\d{3})*)(?:\s*(?:[–—-]|to)\s*(\d+(?:,\d{3})*))?(?=(?:\s+\S+){0,3}\s+lines?\b)/gi;
    const figures = [...section.matchAll(figure)];
    if (!figures.length) continue;
    const text = redact(redactCredentials(section)).replace(/\s+/g, " ").trim().slice(0, 200);
    if (figures.length > 1) return { kind: "ambiguous", text };
    const linesCount = Number((figures[0]?.[2] ?? figures[0]?.[1])?.replaceAll(",", ""));
    return linesCount === 0 ? { kind: "zero", text } : { kind: "figure", lines: linesCount, text };
  }
  return null;
}
