import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

async function assertPending(dir: string, head: string, base: string) {
  expect((await mergeGit(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
  expect((await mergeGit(dir, ["rev-parse", "MERGE_HEAD"])).stdout.trim()).toBe(base);
}

async function assertCompleted(dir: string, head: string, base: string) {
  const sha = await completeMerge(dir, head, base);
  expect((await mergeGit(dir, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim()).toBe(
    `${sha} ${head} ${base}`,
  );
  expect((await mergeGit(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], true)).exitCode).not.toBe(0);
}

test("markers left in a file with -diff attributes block the merge", async () => {
  const { dir, head, base, paths } = await conflict(async (dir, side) => {
    writeFileSync(join(dir, "f.bin"), `${side}\n`);
  });
  try {
    expect(paths).toEqual(["f.bin"]);
    await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers: f.bin");
    writeFileSync(join(dir, "f.bin"), "ours\ntheirs\n");
    await assertCompleted(dir, head, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const rename of ["rename/edit", "rename/rename"] as const) {
  test(`path-suffixed markers in a real ${rename} conflict block the merge`, async () => {
    const { dir, head, base, paths } = await conflict(async (dir, side) => {
      if (side === "theirs" || rename === "rename/rename") {
        const dest = side === "ours" ? "ours.txt" : "theirs.txt";
        renameSync(join(dir, "gone.txt"), join(dir, dest));
        writeFileSync(join(dir, dest), `shared\n${side}\n`);
      } else writeFileSync(join(dir, "gone.txt"), `shared\n${side}\n`);
    });
    try {
      const marked = paths.filter(
        (path) => !path.endsWith("gone.txt") && readFileSync(join(dir, path), "utf8").includes("<<<<<<<"),
      );
      expect(marked.length).toBeGreaterThan(0);
      for (const path of marked) {
        expect(readFileSync(join(dir, path), "utf8")).toMatch(/^<{7,} HEAD:.+$/m);
        expect(readFileSync(join(dir, path), "utf8")).toMatch(new RegExp(`^>{7,} ${base}:.+$`, "m"));
      }
      await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers:");
      await assertPending(dir, head, base);
      for (const path of marked) writeFileSync(join(dir, path), "shared\nours\ntheirs\n");
      await assertCompleted(dir, head, base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("custom conflict-marker-size=10 blocks the merge", async () => {
  const { dir, head, base } = await conflict(async (dir, side) => {
    writeFileSync(join(dir, ".gitattributes"), "*.bin -diff conflict-marker-size=10\n");
    writeFileSync(join(dir, "f.bin"), `${side}\n`);
  });
  try {
    expect(readFileSync(join(dir, "f.bin"), "utf8")).toContain("<<<<<<<<<< HEAD\n");
    expect(readFileSync(join(dir, "f.bin"), "utf8")).toContain(`>>>>>>>>>> ${base}\n`);
    await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers: f.bin");
    await assertPending(dir, head, base);
    writeFileSync(join(dir, "f.bin"), "ours\ntheirs\n");
    await assertCompleted(dir, head, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staging unresolved markers cannot hide the original conflict on resume", async () => {
  const { dir, head, base } = await conflict(async (dir, side) => {
    writeFileSync(join(dir, "f.bin"), `${side}\n`);
  });
  try {
    await mergeGit(dir, ["add", "f.bin"]);
    expect((await mergeGit(dir, ["ls-files", "-u"])).stdout).toBe("");
    expect((await mergeGit(dir, ["diff", "--name-only", "--diff-filter=MT"])).stdout).toBe("");
    expect(await prepareMerge(dir, head, base)).toEqual([]);
    await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers: f.bin");
    await assertPending(dir, head, base);
    writeFileSync(join(dir, "f.bin"), "ours\ntheirs\n");
    await assertCompleted(dir, head, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("original rename conflicts remain checked when the index and untracked lists lose the path", async () => {
  const { dir, head, base, paths } = await conflict(async (dir, side) => {
    if (side === "theirs") renameSync(join(dir, "gone.txt"), join(dir, "renamed.txt"));
    writeFileSync(join(dir, side === "ours" ? "gone.txt" : "renamed.txt"), `shared\n${side}\n`);
  });
  try {
    expect(paths).toEqual(["renamed.txt"]);
    await mergeGit(dir, ["add", "renamed.txt"]);
    await mergeGit(dir, ["update-index", "--force-remove", "renamed.txt"]);
    writeFileSync(join(dir, ".git", "info", "exclude"), "renamed.txt\n");
    expect(await prepareMerge(dir, head, base)).toEqual([]);
    expect((await mergeGit(dir, ["diff", "--name-only", `${base}...HEAD`])).stdout).not.toContain(
      "renamed.txt",
    );
    expect((await mergeGit(dir, ["ls-files", "--others", "--exclude-standard"])).stdout).toBe("");
    await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers: renamed.txt");
    await assertPending(dir, head, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const marker of ["<<<<<<<", ">>>>>>>>>>> other:path", "======= labelled", "<<<<<<<<<< HEAD\r"])
  test(`a partial structural marker blocks the merge: ${JSON.stringify(marker)}`, async () => {
    const { dir, head, base } = await conflict(async (dir, side) => {
      writeFileSync(join(dir, "f.bin"), `${side}\n`);
    });
    try {
      writeFileSync(join(dir, "f.bin"), `ours\ntheirs\n${marker}\n`);
      await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers: f.bin");
      await assertPending(dir, head, base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("a staged new file containing markers blocks a clean resolution", async () => {
  const { dir, head, base } = await conflict(async (dir, side) => {
    writeFileSync(join(dir, "f.bin"), `${side}\n`);
  });
  try {
    writeFileSync(join(dir, "f.bin"), "ours\ntheirs\n");
    writeFileSync(join(dir, "new.txt"), "<<<<<<< HEAD:new.txt\nours\n=======\ntheirs\n>>>>>>> other\n");
    await mergeGit(dir, ["add", "-A"]);
    await expect(completeMerge(dir, head, base)).rejects.toThrow("Unresolved conflict markers: new.txt");
    await assertPending(dir, head, base);
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
