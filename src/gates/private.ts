import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { decodeHTML } from "entities";

const darwin = process.platform === "darwin" ? await import("../util/processes-darwin.ts") : undefined;

/** Exported for tests: a path that changes between lstat and realpath throws. */
export const canonical = (p: string): string =>
  lstatSync(p, { throwIfNoEntry: false }) ? realpathSync(p) : join(canonical(dirname(p)), basename(p));
const absent = (path: string) => !lstatSync(path, { throwIfNoEntry: false });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
/** `path` is `root` or below it; the filesystem root contains every path. */
const within = (path: string, root: string) => `${path}/`.startsWith(root.endsWith("/") ? root : `${root}/`);
export class PrivateError extends Error {}
const read = (path: string) => readFileSync(path, "utf8").trim();

/** The real path of the file behind an open descriptor; it throws when that can't be confirmed. */
function descriptorPath(fd: number): string {
  if (process.platform === "linux") return readlinkSync(`/proc/self/fd/${fd}`);
  const path = darwin?.darwinDescriptorPath(fd);
  if (!path) throw new Error("Cannot confirm the private config's real path");
  return path;
}

/**
 * Checkouts of the linked worktrees listed in `worktrees`. Another run's worktree that git is adding or
 * removing is skipped only in git's own transient states, judged by lstat: an entry or gitdir file that
 * no longer (or doesn't yet) exist, or an empty gitdir file while git's add holds its lock (a regular
 * `locked` file reading "initializing"). A symlink, an unreadable file, an empty gitdir under any other
 * lock (a reason, a symlink, a localized git) or none (`worktree move` rewrites gitdir) is read strictly
 * and blocks.
 *
 * Accepted residuals, since only the owner's own git writes this metadata: a `worktree move` racing the
 * scan, and a stale "initializing" lock left by a git that crashed while adding.
 */
function linkedCheckouts(worktrees: string): string[] {
  let names: string[];
  try {
    names = readdirSync(worktrees);
  } catch (error) {
    // git drops the directory with its last entry.
    if (missing(error) && absent(worktrees)) return [];
    throw error;
  }
  return names.flatMap((name) => {
    const entry = join(worktrees, name);
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat) return [];
    const gitdir = join(entry, "gitdir");
    const file = lstatSync(gitdir, { throwIfNoEntry: false });
    // git creates the entry before it writes gitdir, and removes gitdir before the entry.
    if (stat.isDirectory() && !file) return [];
    const plain = stat.isDirectory() && file?.isFile() === true;
    let target: string;
    try {
      target = read(gitdir);
    } catch (error) {
      if (plain && missing(error) && absent(gitdir)) return [];
      throw error;
    }
    if (!target) {
      const lock = join(entry, "locked");
      if (plain && lstatSync(lock, { throwIfNoEntry: false })?.isFile() && read(lock) === "initializing")
        return [];
      throw new Error(`Empty gitdir in ${entry}`);
    }
    // git can write the checkout's path relative to the entry.
    return [dirname(resolve(entry, target))];
  });
}

function readPrivateStrings(configDir: string, roots: (string | null | undefined)[]) {
  const file = canonical(join(configDir, "private-strings.txt"));
  const locations = [resolve(configDir), canonical(configDir), file];
  const repositoryRoots = roots.flatMap((root) => {
    if (!root) return [];
    let git = canonical(join(root, ".git"));
    const stat = lstatSync(git, { throwIfNoEntry: false });
    if (stat?.isFile()) git = resolve(root, read(git).replace(/^gitdir: /, ""));
    else if (!stat) git = root;
    if (lstatSync(join(git, "commondir"), { throwIfNoEntry: false }))
      git = canonical(resolve(git, read(join(git, "commondir"))));
    const worktrees = join(git, "worktrees");
    const linked = absent(worktrees) ? [] : linkedCheckouts(worktrees);
    return [root, git, ...(basename(git) === ".git" ? [dirname(git)] : []), ...linked];
  });
  const boundaries = repositoryRoots.flatMap((root) => [resolve(root), canonical(resolve(root))]);
  const refuseInside = (paths: string[]) => {
    if (boundaries.some((root) => paths.some((path) => within(path, root))))
      throw new PrivateError("Private config is inside repository; publication blocked");
  };
  refuseInside(locations);
  if (!lstatSync(file, { throwIfNoEntry: false })) return [];
  // Check the file actually opened and read through that descriptor, so a component swapped after the
  // checks above can't redirect the read into a repository. A file with a second hard link can report
  // either name, so only a regular file with one link is read.
  const fd = openSync(file, "r");
  let text: string;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("Private config is not a regular file");
    if (opened.nlink !== 1)
      throw new PrivateError("private-strings.txt has more than one hard link; publication blocked");
    refuseInside([descriptorPath(fd)]);
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
  return text.split(/\r?\n/).flatMap((line, i) => {
    const value = line.trim();
    return value && !value.startsWith("#") ? [{ value, entry: i + 1 }] : [];
  });
}

export function loadPrivateStrings(
  configDir = process.env.LIMITLESS_CONFIG_DIR ?? join(homedir(), ".config", "limitless"),
  roots: (string | null | undefined)[] = [],
): { value: string; entry: number }[] {
  // Another run's worktree can vanish between canonicalization's lstat and realpath. Each attempt is a
  // whole check that fails closed, so only a missing path is retried, and three failures block.
  for (let attempt = 1; ; attempt++) {
    try {
      return readPrivateStrings(configDir, roots);
    } catch (error) {
      if (error instanceof PrivateError) throw error;
      if (missing(error) && attempt < 3) continue;
      throw new PrivateError("Cannot read private-strings.txt; publication blocked");
    }
  }
}
export type PrivateStrings = ReturnType<typeof loadPrivateStrings>;
export function privateStringsDigest(entries: PrivateStrings): string {
  const values = [...new Set(entries.map(({ value }) => value))].sort();
  return createHash("sha256")
    .update(JSON.stringify(["limitless-private-strings/1", ...values]))
    .digest("hex");
}
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
/** Exported for decoder equivalence tests. Each backslash run is consumed once. */
export function decodeBackslashes(text: string, slashes = true): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (let start = text.indexOf("\\"); start !== -1; ) {
    let end = start + 1;
    while (text[end] === "\\") end++;
    const unicode = /^[uU]([0-9a-f]{4})/i.exec(text.slice(end, end + 5));
    if ((slashes && text[end] === "/") || unicode) {
      pieces.push(
        text.slice(cursor, start),
        unicode ? String.fromCharCode(Number.parseInt(unicode[1] ?? "", 16)) : "/",
      );
      cursor = end + (unicode ? 5 : 1);
      end = cursor;
    }
    start = text.indexOf("\\", end);
  }
  return pieces.length ? pieces.join("") + text.slice(cursor) : text;
}
const decodePercent = (text: string) =>
  text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString());
/** The decoded text of a base64 run that holds a protected value; undefined for unrelated runs. */
export function base64Match(run: string, entries: PrivateStrings): string | undefined {
  const minimum = Math.ceil((Math.min(...entries.map(({ value }) => Buffer.byteLength(value))) * 4) / 3);
  if (run.replace(/=+$/, "").length < minimum) return undefined;
  // Encodings nested inside decoded base64 (such as percent or HTML) are outside scope.
  // One of four alignments decodes any encoding inside the run (a directory prefix or "/" included),
  // and later characters never change bytes already decoded, so this stays linear in the run.
  for (let offset = 0; offset < 4; offset++) {
    const plain = Buffer.from(run.slice(offset), "base64").toString();
    const found = normalize(plain);
    if (entries.some(({ value }) => found.includes(normalize(value)))) return plain;
  }
  return undefined;
}
/** Raw and successively decoded forms, NFKC-normalized and lowercased; null when decoding never settles. */
export function normalizedLayers(text: string, entries: PrivateStrings = []): string[] | null {
  // Repeated log fields and convergence rounds share the same base64 checks.
  const base64Cache = new Map<string, string>();
  // base64Match leaves runs too short to hold a protected value unchanged, so the regex skips them.
  const minimum = Math.ceil((Math.min(...entries.map(({ value }) => Buffer.byteLength(value))) * 4) / 3);
  const candidates = entries.length
    ? new RegExp(`(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{${Math.max(1, minimum)},}=*`, "g")
    : undefined;
  const decodeBase64 = (layer: string) =>
    candidates
      ? layer.replace(candidates, (run) => {
          let decoded = base64Cache.get(run);
          if (decoded === undefined) {
            decoded = base64Match(run, entries) ?? run;
            base64Cache.set(run, decoded);
          }
          return decoded;
        })
      : layer;
  const all = decodedLayers(text, decodeBase64);
  if (!all) return null;
  const normalized = new Map([...new Set(all)].map((layer) => [layer, normalize(layer)]));
  return all.map((layer) => normalized.get(layer) ?? "");
}
export function decodedLayers(
  text: string,
  decodeBase64: (text: string) => string,
  retain?: (form: string) => void,
): string[] | null {
  const rounds = (current: string, slashes: boolean): string[] | null => {
    const layers: string[] = [];
    const keep = (...forms: string[]) => {
      for (const form of forms) retain?.(form);
      layers.push(...forms);
    };
    keep(current);
    for (let round = 0; round < 5; round++) {
      // Unrelated runs must not change decoding convergence or cause a refusal.
      // Keep the text before backslash and HTML decoding too, since a protected value can contain either.
      const percentDecoded = decodePercent(current);
      const unescaped = decodeBackslashes(percentDecoded, slashes);
      const expanded = decodeHTML(unescaped);
      // Prepared checks inspect HTML before selective base64 replacement.
      if (retain) keep(expanded);
      // Keep line breaks too: report quotations and multiline credentials depend on them.
      keep(percentDecoded, unescaped, decodeBase64(expanded.replace(/\s+/g, " ")));
      const next = decodeBase64(expanded);
      keep(next);
      if (next === current) return layers;
      current = next;
    }
    return null;
  };
  // A protected value can contain a literal backslash-slash, so the rounds that keep "\/" still run. The
  // rounds that decode it differ only once a layer holds "\/".
  const kept = rounds(text, false);
  const slashed = kept?.some((layer) => layer.includes("\\/")) ? rounds(text, true) : kept;
  if (!kept || !slashed) return null;
  const all = kept === slashed ? kept : [...kept, ...slashed];
  return all;
}
export function stripPartialEscapes(text: string): string {
  let end = text.length;
  while (end > 0) {
    const last = text[end - 1];
    if (last === "%" || last === "\\" || last === "\ufffd") {
      end--;
      continue;
    }
    // Look behind at most three hex digits; consume backslashes individually to avoid ambiguity.
    let start = end;
    while (start > 0 && end - start < 3 && "0123456789abcdefABCDEF".includes(text.charAt(start - 1))) start--;
    if (end - start <= 1 && text[start - 1] === "%") end = start - 1;
    else if ((text[start - 1] === "u" || text[start - 1] === "U") && text[start - 2] === "\\")
      end = start - 2;
    else break;
  }
  return text.slice(0, end);
}
/** A clipped value also protects any trailing fragment of a private string. */
export function privateMatches(text: string, entries: PrivateStrings, truncated = false): PrivateStrings {
  const normalized = normalizedLayers(text, entries);
  if (normalized)
    return entries.filter(({ value }) => {
      const protectedText = normalize(value);
      return normalized.some((layer) => {
        if (layer.includes(protectedText)) return true;
        if (!truncated) return false;
        // A cutoff can split an escape or a UTF-8 percent sequence, hiding the decoded tail.
        const tails = [layer, stripPartialEscapes(layer)];
        return tails.some((tail) => {
          for (let length = 1; length < protectedText.length && length <= tail.length; length++)
            if (tail.endsWith(protectedText.slice(0, length))) return true;
          return false;
        });
      });
    });
  // Entry zero marks unsafe decoding, including when the denylist is empty.
  return [{ value: "", entry: 0 }];
}
export const privateReason = (location: string, entry: number) =>
  entry === 0
    ? `${location} exceeds the private text decoding limit; publication blocked`
    : `${location} contains a private string (entry ${entry} in private-strings.txt)`;
export const redactLiteral = (text: string, entries: PrivateStrings) =>
  entries.reduce(
    (out, { value }) =>
      out.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]"),
    text,
  );
export function redactPrivate(text: string, entries: PrivateStrings): string {
  text = redactLiteral(text, entries);
  return privateMatches(text, entries).length ? "[redacted diagnostic]" : text;
}
export function checkPrivateText(text: string, location: string, entries: PrivateStrings): void {
  const hit = privateMatches(text, entries)[0];
  if (hit) throw new PrivateError(privateReason(location, hit.entry));
}
