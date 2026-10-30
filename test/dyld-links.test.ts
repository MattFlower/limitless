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

test("dyld links are the symlinks of each load-command lookup that ends at a recorded library", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dyld-links-")));
  roots.push(root);
  // A Homebrew-shaped runtime: opt links to kegs, versioned dylib links, @rpath and @loader_path.
  const node = join(root, "Cellar/node/1/bin/node");
  const libnode = join(root, "Cellar/node/1/lib/libnode.dylib");
  const data = join(root, "Cellar/node/1/lib/libdata.1.0.dylib");
  const pkg = join(root, "Cellar/pkg/2/lib/libpkg.1.2.dylib");
  write(
    node,
    machO(
      ["@rpath/libnode.dylib", `${root}/opt/pkg/lib/libpkg.1.dylib`, `${root}/opt/other/lib/libother.dylib`],
      ["@loader_path", "@loader_path/../lib"],
    ),
  );
  write(libnode, machO(["@loader_path/libdata.1.dylib", "/usr/lib/libSystem.B.dylib"]));
  write(data, machO());
  write(pkg, machO());
  link(join(root, "Cellar/node/1/lib/libdata.1.dylib"), "libdata.1.0.dylib");
  link(join(root, "opt/pkg"), "../Cellar/pkg/2");
  link(join(root, "Cellar/pkg/2/lib/libpkg.1.dylib"), "libpkg.1.2.dylib");
  // Not recorded: its link must not become readable.
  write(join(root, "Cellar/other/lib/libother.dylib"), machO());
  link(join(root, "opt/other"), "../Cellar/other");
  expect(dyldLinks(node, [node, libnode, data, pkg]).sort()).toEqual(
    [
      join(root, "Cellar/node/1/lib/libdata.1.dylib"),
      join(root, "Cellar/pkg/2/lib/libpkg.1.dylib"),
      join(root, "opt/pkg"),
    ].sort(),
  );
  // Without the executable among the recorded images, its run paths do not apply to the others.
  expect(dyldLinks(node, [libnode, data])).toEqual([join(root, "Cellar/node/1/lib/libdata.1.dylib")]);
});

test("load commands come only from well-formed 64-bit Mach-O images", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dyld-macho-")));
  roots.push(root);
  const image = join(root, "image");
  write(image, machO(["/a/libx.dylib"], ["@loader_path/../lib"]));
  expect(loadCommands(image)).toEqual({ dylibs: ["/a/libx.dylib"], rpaths: ["@loader_path/../lib"] });
  write(image, "#!/bin/sh\n");
  expect(() => loadCommands(image)).toThrow("Not a thin 64-bit Mach-O image");
  write(image, machO(["/a/libx.dylib"]).subarray(0, 40));
  expect(() => loadCommands(image)).toThrow("Truncated load commands");
});
