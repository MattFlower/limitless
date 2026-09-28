import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeMerge, mergeGit, prepareMerge } from "../src/git/merge.ts";

async function conflict(setup: (dir: string, side: "ours" | "theirs") => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "limitless-merge-"));
  await mergeGit(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, ".gitattributes"), "*.bin -diff\n");
  writeFileSync(join(dir, "f.bin"), "shared\n");
  writeFileSync(join(dir, "gone.txt"), "shared\n");
  await mergeGit(dir, ["add", "-A"]);
  await mergeGit(dir, ["commit", "-qm", "init"]);
  await mergeGit(dir, ["checkout", "-qb", "feature"]);
  await setup(dir, "ours");
  await mergeGit(dir, ["add", "-A"]);
  await mergeGit(dir, ["commit", "-qm", "ours"]);
  const head = (await mergeGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
  await mergeGit(dir, ["checkout", "-q", "main"]);
  await setup(dir, "theirs");
  await mergeGit(dir, ["add", "-A"]);
  await mergeGit(dir, ["commit", "-qm", "theirs"]);
  const base = (await mergeGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
  await mergeGit(dir, ["checkout", "-q", "feature"]);
  const paths = await prepareMerge(dir, head, base);
  return { dir, head, base, paths };
}

test("markers left in a file with -diff attributes block the merge", async () => {
  const { dir, head, base, paths } = await conflict(async (dir, side) => {
    writeFileSync(join(dir, "f.bin"), `${side}\n`);
  });
  try {
    expect(paths).toEqual(["f.bin"]);
    await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers: f.bin");
    writeFileSync(join(dir, "f.bin"), "ours\ntheirs\n");
    await completeMerge(dir, head, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markers written into a modify/delete conflict block the merge", async () => {
  const { dir, head, base, paths } = await conflict(async (dir, side) => {
    if (side === "ours") writeFileSync(join(dir, "gone.txt"), "changed\n");
    else unlinkSync(join(dir, "gone.txt"));
  });
  try {
    expect(paths).toEqual(["gone.txt"]);
    writeFileSync(join(dir, "gone.txt"), "<<<<<<< HEAD\nchanged\n=======\n");
    await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers: gone.txt");
    writeFileSync(join(dir, "gone.txt"), "changed\n");
    await completeMerge(dir, head, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
