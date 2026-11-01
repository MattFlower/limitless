import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { PrivateError, type PrivateStrings, privateMatches, privateReason } from "./private.ts";

/** Configured and canonical spellings of roots; removed roots keep their known spellings. */
export function publicationRoots(roots: readonly (string | undefined)[]): string[] {
  const aliases = roots.flatMap((root) => {
    if (!root) return [];
    try {
      return [root, realpathSync(root)];
    } catch {
      return [root];
    }
  });
  const spellings = aliases.flatMap((path) => {
    if (process.platform !== "darwin") return [path];
    if (/^\/private\/(?:var|tmp|etc)(?:\/|$)/u.test(path)) return [path, path.slice(8)];
    return /^\/(?:var|tmp|etc)(?:\/|$)/u.test(path) ? [path, `/private${path}`] : [path];
  });
  return [...new Set(spellings.map((path) => path.replace(/\/+$/u, "")))].filter(Boolean);
}

/** A run's worktree spellings: its configured path, current realpath and retained aliases. */
export function publicationWorktree(state: { worktreePath?: string; worktreeAliases?: unknown }): string[] {
  const retained = Array.isArray(state.worktreeAliases) ? state.worktreeAliases : [];
  return publicationRoots([state.worktreePath, ...retained.filter((path) => typeof path === "string")]);
}

/** Rewrite local paths only on publication copies, after stripping report metadata. */
export function sanitizePublication(
  text: string,
  worktree: string | readonly string[],
  dataDirectory: string,
): string {
  const workRoots = publicationRoots([worktree].flat());
  const dataRoots = publicationRoots([dataDirectory]);
  const roots = [...workRoots, ...dataRoots, ...publicationRoots([homedir()])];
  const rewrite = (value: string): string => {
    const path = value.replace(/^file:\/\//iu, "");
    const root = roots.find((root) => path === root || path.startsWith(`${root}/`));
    if (!root) return value;
    const suffix = path.slice(root.length);
    if (workRoots.includes(root)) return suffix.slice(1) || ".";
    return `${dataRoots.includes(root) ? "<data>" : "~"}${suffix}`;
  };
  const prefixes = roots.map((root) => root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (!prefixes.length) return text;
  const paths = new RegExp(
    `https?://[^\\s\x60<>"']+|(?<![\\w/.~%-])(?:file://)?(?:${prefixes.join("|")})(?=/|$|[\\s\x60<>"'()\\[\\]{},;!?])(?:/[^\\s\x60<>"'()\\[\\]{},;!?]*)?`,
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

/** Match outgoing text and its supported decoded layers. */
export const publicationMatches = privateMatches;

export function checkPublicationText(text: string, location: string, entries: PrivateStrings): void {
  const hit = publicationMatches(text, entries)[0];
  if (hit) throw new PrivateError(privateReason(location, hit.entry));
}
