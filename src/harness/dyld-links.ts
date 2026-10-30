import { closeSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

// LC_LOAD_DYLIB, LC_LAZY_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LOAD_UPWARD_DYLIB.
const DYLIBS = new Set([0xc, 0x20, 0x80000018, 0x8000001f, 0x80000023]);
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
export function loadCommands(path: string): { dylibs: string[]; rpaths: string[] } {
  const header = read(path, 0, 32);
  if (header.length < 32 || header.readUInt32LE(0) !== 0xfeedfacf)
    throw new Error(`Not a thin 64-bit Mach-O image: ${path}`);
  if (header.readUInt32LE(20) > 1 << 20) throw new Error(`Implausible load commands in ${path}`);
  const commands = read(path, 32, header.readUInt32LE(20));
  const found = { dylibs: [] as string[], rpaths: [] as string[] };
  for (let i = 0, at = 0; i < header.readUInt32LE(16); i++) {
    const size = at + 12 <= commands.length ? commands.readUInt32LE(at + 4) : 0;
    if (size < 12 || at + size > commands.length) throw new Error(`Truncated load commands in ${path}`);
    const command = commands.readUInt32LE(at);
    if (DYLIBS.has(command) || command === RPATH) {
      const start = at + commands.readUInt32LE(at + 8);
      const end = commands.indexOf(0, start);
      if (start >= at + size || end < 0 || end > at + size)
        throw new Error(`Invalid load command in ${path}`);
      (command === RPATH ? found.rpaths : found.dylibs).push(commands.toString("utf8", start, end));
    }
    at += size;
  }
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
 * @loader_path and @rpath), and Seatbelt checks each symlink on the way. These are the symlinks of the
 * lookups that end at a recorded library; the executable is among the recorded images.
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
    for (const name of loadCommands(image).dylibs)
      for (const candidate of name.startsWith("@rpath/")
        ? searched.map((path) => `${path}/${name.slice("@rpath/".length)}`)
        : [expand(name, image)]) {
        const found = lookup(candidate);
        if (found && libraries.includes(found.target)) for (const link of found.links) links.add(link);
      }
  }
  return [...links];
}
