// Reproduce with: bun scripts/benchmark-run-object-privacy.ts
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunObjectPrivacyValidator } from "../src/pipeline/run-object-privacy.ts";
import { sh } from "../src/util/proc.ts";

const root = await mkdtemp(join(tmpdir(), "object-privacy-benchmark-"));
try {
  const source = join(root, "source");
  await mkdir(source);
  const git = async (args: string[]) => (await sh(["git", ...args], { cwd: source })).stdout.trim();
  await git(["init", "--template=", "--object-format=sha1"]);
  for (let i = 0; i < 1000; i++) await writeFile(join(source, `file-${i}`), `synthetic object ${i}\n`);
  await git(["add", "."]);
  const tree = await git(["write-tree"]);
  const oid = await git([
    "-c",
    "user.name=Benchmark",
    "-c",
    "user.email=benchmark@example.com",
    "commit-tree",
    tree,
    "-m",
    "synthetic benchmark",
  ]);
  const name = `refs/limitless-run-objects/benchmark/${oid}`;
  await git(["update-ref", name, oid]);
  const bundle = join(root, "objects.bundle");
  await git(["bundle", "create", "--version=3", bundle, name]);
  const input = {
    bytes: await readFile(bundle),
    refs: [{ name, oid }],
    requiredCommits: [oid],
    objectFormat: "sha1" as const,
  };
  const secret = randomUUID();
  let objects = 0;
  const start = performance.now();
  await createRunObjectPrivacyValidator({ scratchRoot: root, credentials: () => [secret] })(
    input,
    async (reader) => {
      for await (const _object of reader.objects()) objects++;
    },
    new AbortController().signal,
  );
  console.log(`objects=${objects} elapsedMs=${(performance.now() - start).toFixed(1)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
