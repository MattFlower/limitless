import { closeSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

// LC_LOAD_DYLIB, LC_LAZY_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LOAD_UPWARD_DYLIB.
const DYLIBS = new Set([0xc, 0x20, 0x80000018, 0x8000001f, 0x80000023]);
const OPTIONAL = new Set([0x20, 0x80000018]); // lazy and weak dependencies may be absent
const RPATH = 0x8000001c;

function read(path: string, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, length, offset));
  } finally {
    closeSync(fd);
  }
}

/** Dylib and run-path names from a thin 64-bit Mach-O image's load commands (Homebrew's Node is thin). */
export function loadCommands(path: string): {
  dylibs: { name: string; optional: boolean }[];
  rpaths: string[];
} {
  const header = read(path, 0, 32);
  if (header.length < 32 || header.readUInt32LE(0) !== 0xfeedfacf)
    throw new Error(`Not a thin 64-bit Mach-O image: ${path}`);
  if (header.readUInt32LE(20) > 1 << 20) throw new Error(`Implausible load commands in ${path}`);
  const commands = read(path, 32, header.readUInt32LE(20));
  const invalid = (what: string) => new Error(`${what} load commands in ${path}`);
  if (commands.length !== header.readUInt32LE(20)) throw invalid("Truncated");
  const found = { dylibs: [] as { name: string; optional: boolean }[], rpaths: [] as string[] };
  let at = 0;
  for (let i = 0; i < header.readUInt32LE(16); i++) {
    const size = at + 8 <= commands.length ? commands.readUInt32LE(at + 4) : 0;
    if (size < 8 || at + size > commands.length) throw invalid("Truncated");
    const command = commands.readUInt32LE(at);
    if (DYLIBS.has(command) || command === RPATH) {
      // The string follows the fixed fields (24 bytes for dylib_command, 12 for rpath_command) and
      // its terminator lies inside the command.
      const offset = size > 12 ? commands.readUInt32LE(at + 8) : 0;
      const end = commands.indexOf(0, at + offset);
      if (offset < (command === RPATH ? 12 : 24) || end < 0 || end >= at + size) throw invalid("Invalid");
      const name = commands.toString("utf8", at + offset, end);
      if (command === RPATH) found.rpaths.push(name);
      else found.dylibs.push({ name, optional: OPTIONAL.has(command) });
    }
    at += size;
  }
  if (at !== commands.length) throw invalid("Unconsumed");
  return found;
}

/** Resolve physically, as the kernel does: every symlink on the way, and where the lookup ends. */
function lookup(path: string, links: string[] = []): { links: string[]; target: string } | undefined {
  const parts = path.split(sep);
  let current: string = sep;
  for (const [index, part] of parts.entries()) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    const entry = lstatSync(next, { throwIfNoEntry: false });
    if (!entry) return;
    if (entry.isSymbolicLink()) {
      if (links.length >= 32) return;
      const target = readlinkSync(next);
      const rest = parts.slice(index + 1).join(sep);
      return lookup(`${isAbsolute(target) ? "" : `${current}${sep}`}${target}${sep}${rest}`, [
        ...links,
        next,
      ]);
    }
    current = next;
  }
  return { links, target: current };
}

/**
 * dyld opens each library through its loader's spelling (Homebrew `opt` links, versioned dylib links,
 * @loader_path and @rpath), and Seatbelt checks each symlink on the way. These are the symlinks of
 * those lookups; the executable is among the recorded images. A dependency that no longer reaches a
 * recorded library (a Homebrew upgrade moved an `opt` link) refuses the runtime.
 */
export function dyldLinks(executable: string, libraries: readonly string[]): string[] {
  const expand = (path: string, loader: string) =>
    path
      .replace(/^@loader_path(?=\/|$)/, dirname(loader))
      .replace(/^@executable_path(?=\/|$)/, dirname(executable));
  const rpaths = (image: string) => loadCommands(image).rpaths.map((path) => expand(path, image));
  const inherited = libraries.includes(executable) ? rpaths(executable) : [];
  const links = new Set<string>();
  for (const image of libraries) {
    const searched = [...rpaths(image), ...inherited];
    for (const { name, optional } of loadCommands(image).dylibs) {
      // System libraries come from the dyld shared cache, which the profile's system reads cover.
      if (/^\/(usr\/lib|System)\//.test(name)) continue;
      // dyld loads the first candidate that exists.
      const found = (
        name.startsWith("@rpath/")
          ? searched.map((path) => `${path}/${name.slice("@rpath/".length)}`)
          : [expand(name, image)]
      )
        .map((candidate) => lookup(candidate))
        .find((lookup) => lookup !== undefined);
      if (!found && optional) continue;
      if (!found || !libraries.includes(found.target))
        throw new Error(
          `browser runtime changed: ${name} ${found ? "resolves to an unrecorded path" : "does not resolve"}; reprovision the browser cache`,
        );
      for (const link of found.links) links.add(link);
    }
  }
  return [...links];
}
