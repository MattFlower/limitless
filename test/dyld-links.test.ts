import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dyldLinks, loadCommands } from "../src/harness/dyld-links.ts";
import { machO } from "./browser-mcp-support.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const write = (path: string, content: Buffer | string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const link = (path: string, target: string) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};

// A Homebrew-shaped runtime: opt links to kegs, versioned dylib links, @rpath and @loader_path.
function runtime() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dyld-links-")));
  roots.push(root);
  const node = join(root, "Cellar/node/1/bin/node");
  const libnode = join(root, "Cellar/node/1/lib/libnode.dylib");
  const data = join(root, "Cellar/node/1/lib/libdata.1.0.dylib");
  const pkg = join(root, "Cellar/pkg/2/lib/libpkg.1.2.dylib");
  write(
    node,
    machO(
      ["@rpath/libnode.dylib", `${root}/opt/pkg/lib/libpkg.1.dylib`],
      ["@loader_path", "@loader_path/../lib"],
      [`${root}/opt/absent/lib/libabsent.dylib`],
    ),
  );
  write(libnode, machO(["@loader_path/libdata.1.dylib", "/usr/lib/libSystem.B.dylib"]));
  write(data, machO());
  write(pkg, machO());
  link(join(root, "Cellar/node/1/lib/libdata.1.dylib"), "libdata.1.0.dylib");
  link(join(root, "opt/pkg"), "../Cellar/pkg/2");
  link(join(root, "Cellar/pkg/2/lib/libpkg.1.dylib"), "libpkg.1.2.dylib");
  return { root, node, libraries: [node, libnode, data, pkg] };
}

test("dyld links are the symlinks of each load-command lookup, which must end at a recorded library", () => {
  const { root, node, libraries } = runtime();
  // The absent weak dependency is optional; the system library comes from the shared cache.
  expect(dyldLinks(node, libraries).sort()).toEqual(
    [
      join(root, "Cellar/node/1/lib/libdata.1.dylib"),
      join(root, "Cellar/pkg/2/lib/libpkg.1.dylib"),
      join(root, "opt/pkg"),
    ].sort(),
  );
  // Without the executable among the recorded images, its run paths do not apply to the others.
  expect(dyldLinks(node, libraries.slice(1, 3))).toEqual([join(root, "Cellar/node/1/lib/libdata.1.dylib")]);
});

test("a Homebrew keg move or a missing dependency refuses the runtime", () => {
  const { root, node, libraries } = runtime();
  // Upgrade: a new keg, with the old one kept and the opt link moved to the new one.
  write(join(root, "Cellar/pkg/3/lib/libpkg.1.3.dylib"), machO());
  link(join(root, "Cellar/pkg/3/lib/libpkg.1.dylib"), "libpkg.1.3.dylib");
  rmSync(join(root, "opt/pkg"));
  link(join(root, "opt/pkg"), "../Cellar/pkg/3");
  const dependency = `${root}/opt/pkg/lib/libpkg.1.dylib`;
  expect(() => dyldLinks(node, libraries)).toThrow(
    `browser runtime changed: ${dependency} resolves to an unrecorded path; reprovision the browser cache`,
  );
  rmSync(join(root, "opt/pkg"));
  expect(() => dyldLinks(node, libraries)).toThrow(`browser runtime changed: ${dependency} does not resolve`);
});

test("load commands come only from well-formed 64-bit Mach-O images", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dyld-macho-")));
  roots.push(root);
  const image = join(root, "image");
  const parse = (content: Buffer | string) => {
    write(image, content);
    return () => loadCommands(image);
  };
  expect(parse(machO(["/a/libx.dylib"], ["@loader_path/../lib"], ["/a/liby.dylib"]))()).toEqual({
    dylibs: [
      { name: "/a/libx.dylib", optional: false },
      { name: "/a/liby.dylib", optional: true },
    ],
    rpaths: ["@loader_path/../lib"],
  });
  expect(parse("#!/bin/sh\n")).toThrow("Not a thin 64-bit Mach-O image");
  const patched = (patch: (image: Buffer) => void, image = machO(["/a/libx.dylib"])) => {
    patch(image);
    return image;
  };
  // Declared command bytes that are missing, or that the declared commands do not consume.
  expect(parse(patched((image) => image.writeUInt32LE(4096, 20), machO()))).toThrow("Truncated");
  expect(parse(machO(["/a/libx.dylib"]).subarray(0, 40))).toThrow("Truncated");
  expect(parse(patched((image) => image.writeUInt32LE(0, 16)))).toThrow("Unconsumed");
  // A name that starts inside the dylib_command's fixed fields.
  expect(parse(patched((image) => image.writeUInt32LE(12, 40)))).toThrow("Invalid");
  // A run path that starts inside the rpath_command's fixed fields.
  expect(parse(patched((image) => image.writeUInt32LE(8, 40), machO([], ["/a/lib"])))).toThrow("Invalid");
  // A lazy dependency (LC_LAZY_LOAD_DYLIB) is optional, like a weak one.
  expect(parse(patched((image) => image.writeUInt32LE(0x20, 32), machO(["/a/liblazy.dylib"])))()).toEqual({
    dylibs: [{ name: "/a/liblazy.dylib", optional: true }],
    rpaths: [],
  });
  // A name whose terminator is the first byte after its command (the next command's type).
  const unterminated = Buffer.alloc(32 + 32 + 16);
  unterminated.writeUInt32LE(0xfeedfacf, 0);
  unterminated.writeUInt32LE(2, 16);
  unterminated.writeUInt32LE(48, 20);
  unterminated.writeUInt32LE(0xc, 32);
  unterminated.writeUInt32LE(32, 36);
  unterminated.writeUInt32LE(24, 40);
  unterminated.write("/a/libxy", 56);
  unterminated.writeUInt32LE(0x100, 64); // an unrelated command whose type begins with a zero byte
  unterminated.writeUInt32LE(16, 68);
  expect(parse(unterminated)).toThrow("Invalid");
});

test("an @rpath dependency resolves through the first run path where it exists", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dyld-order-")));
  roots.push(root);
  const node = join(root, "bin/node");
  write(node, machO(["@rpath/libq.dylib"], [join(root, "first"), join(root, "second")]));
  write(join(root, "first/libq.1.dylib"), machO());
  link(join(root, "first/libq.dylib"), "libq.1.dylib");
  write(join(root, "second/libq.dylib"), machO());
  // dyld loads the first existing candidate; the second is not what the runtime recorded.
  expect(dyldLinks(node, [node, join(root, "first/libq.1.dylib")])).toEqual([join(root, "first/libq.dylib")]);
  expect(() => dyldLinks(node, [node, join(root, "second/libq.dylib")])).toThrow(
    "browser runtime changed: @rpath/libq.dylib resolves to an unrecorded path",
  );
});

test("an absent lazy dependency does not refuse the runtime", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dyld-lazy-")));
  roots.push(root);
  const node = join(root, "bin/node");
  const image = machO([join(root, "absent/liblazy.dylib")]);
  image.writeUInt32LE(0x20, 32); // LC_LAZY_LOAD_DYLIB
  write(node, image);
  expect(dyldLinks(node, [node])).toEqual([]);
});
