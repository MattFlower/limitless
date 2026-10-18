import { realpathSync } from "node:fs";
import { decodeHTML } from "entities";
import { checkPrivateText, type PrivateStrings } from "./private.ts";

/** Rewrite local paths only on publication copies, after stripping report metadata. */
export function sanitizePublication(text: string, worktree: string, dataDirectory: string): string {
  const aliases = (root: string): string[] => {
    if (!root) return [];
    let canonical = root;
    try {
      canonical = realpathSync(root);
    } catch {
      // Removed worktrees still need their configured spelling rewritten.
    }
    return [...new Set([root, canonical].map((path) => path.replace(/\/+$/u, "")))].filter(Boolean);
  };
  const workRoots = aliases(worktree);
  const roots = [...workRoots, ...aliases(dataDirectory)];
  const rewrite = (value: string): string => {
    const path = value.replace(/^file:\/\//iu, "");
    const root = roots.find((root) => path === root || path.startsWith(`${root}/`));
    if (!root) return value;
    const suffix = path.slice(root.length);
    return workRoots.includes(root) ? suffix.slice(1) || "." : `<data>${suffix}`;
  };
  const prefixes = roots.map((root) => root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (!prefixes.length) return text;
  const paths = new RegExp(
    `https?://[^\\s\x60<>"']+|(?<![\\w/.:~%-])(?:file://)?(?:${prefixes.join("|")})(?=/|$|[\\s\x60<>"'()\\[\\]{},;!?])(?:/[^\\s\x60<>"'()\\[\\]{},;!?]*)?`,
    "giu",
  );
  // Only schemes are case-insensitive: filesystem roots retain their literal spelling.
  const barePaths = (value: string) => value.replace(paths, (match) => rewrite(match));
  // Bounded scans, excluding nested openers, also leave malformed Markdown to barePaths.
  const links =
    /!?\[([^[\]\n]{0,2048})\]\(\s{0,32}(?:<([^>\n]{1,4096})>|((?:[^\s()]|\([^()\n]{0,256}\)){1,4096}))((?:\s{1,32}(?:"[^"\n]{0,2048}"|'[^'\n]{0,2048}'))?\s{0,32})\)/gu;
  // Consume bare URLs before looking for Markdown inside their query strings.
  return text.replace(
    new RegExp(`${links.source}|${paths.source}`, "giu"),
    (
      match: string,
      label: string | undefined,
      angle: string | undefined,
      bare: string | undefined,
      title = "",
    ) => {
      if (label === undefined) return rewrite(match);
      const path = angle ?? bare ?? "";
      const result = rewrite(path);
      const cleanLabel = barePaths(label);
      if (result !== path)
        return result.startsWith("<data>")
          ? result
          : `[${cleanLabel === label ? result : cleanLabel}](${angle ? `<${result}>` : result}${barePaths(title)})`;
      return `${match.replace(label, () => cleanLabel).slice(0, -title.length - 1)}${barePaths(title)})`;
    },
  );
}

/** Check both the outgoing Markdown and the text exposed by HTML character references. */
export function checkPublicationText(text: string, location: string, entries: PrivateStrings): void {
  checkPrivateText(text, location, entries);
  checkPrivateText(decodeHTML(text).replace(/\s+/g, " "), location, entries);
}
