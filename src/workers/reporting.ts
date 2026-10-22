import { redactGateData } from "../gates/output.ts";
import { spellings as pathSpellings } from "../harness/scratch.ts";

/** Capture canonical paths while scratch exists; aliases are report spellings, not read grants. */
export function agentPathMask(paths: string[]) {
  const spellings = paths.flatMap((path) => {
    try {
      return [path, ...pathSpellings([path])];
    } catch {
      return [path];
    }
  });
  const variants = spellings.flatMap((path) => {
    const alias = /^\/(private\/)?(tmp|var)(?=\/|$)/.exec(path);
    return alias ? [path, path.replace(alias[0], `${alias[1] ? "" : "/private"}/${alias[2]}`)] : [path];
  });
  const patterns = [...new Set(variants)]
    .map((path) => JSON.stringify(path).slice(1, -1))
    .sort((a, b) => b.length - a.length)
    // Serialized JSON inside strings adds another layer of backslashes before escaped slashes.
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("/", String.raw`\\*/`));
  const pattern = patterns.length ? new RegExp(patterns.join("|"), "g") : undefined;
  return <T>(data: T): T =>
    pattern
      ? JSON.parse(JSON.stringify(redactGateData(data)).replace(pattern, "<worktree>"))
      : redactGateData(data);
}
