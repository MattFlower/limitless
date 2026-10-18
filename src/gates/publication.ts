import { decodeHTML } from "entities";
import { checkPrivateText, type PrivateStrings } from "./private.ts";

/** Rewrite local paths only on publication copies, after stripping report metadata. */
export function sanitizePublication(text: string, worktree: string, dataDirectory: string): string {
  const roots = [worktree, dataDirectory].map((root) => root.replace(/\/+$/u, ""));
  const rewrite = (path: string): string => {
    const index = roots.findIndex((root) => root && (path === root || path.startsWith(`${root}/`)));
    if (index < 0) return path;
    const suffix = path.slice(roots[index]?.length);
    return index === 0 ? suffix.slice(1) || "." : `<data>${suffix}`;
  };
  const links = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]|\([^()\n]*\))+))(?:\s+"[^"\n]*")?\s*\)/gu;
  const prefixes = roots.filter(Boolean).map((root) => root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (!prefixes.length) return text;
  const paths = new RegExp(
    `${links.source}|https?://[^\\s\x60<>"']+|(?<![\\w/.:~%-])(?:${prefixes.join("|")})(?=/|$|[\\s\x60<>"'()\\[\\]{},;!?])(?:/[^\\s\x60<>"'()\\[\\]{},;!?]*)?`,
    "gu",
  );
  return text.replace(paths, (match: string, angle: string | undefined, bare: string | undefined) => {
    const path = angle ?? bare;
    if (path === undefined) return rewrite(match);
    const result = rewrite(path);
    if (result === path) return match;
    return result.startsWith("<data>") ? result : `[${result}](${angle ? `<${result}>` : result})`;
  });
}

/** Check both the outgoing Markdown and the text exposed by HTML character references. */
export function checkPublicationText(text: string, location: string, entries: PrivateStrings): void {
  checkPrivateText(text, location, entries);
  checkPrivateText(decodeHTML(text).replace(/\s+/g, " "), location, entries);
}
