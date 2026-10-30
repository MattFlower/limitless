import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { RunnerFailureEvidence } from "../gates/attribution.ts";

const limit = 16 * 1024 * 1024;
const id = z.number().int().positive();
const runSchema = z.object({
  id,
  workflow_id: id,
  head_sha: z.string(),
  head_branch: z.string(),
  run_attempt: id,
  status: z.literal("completed"),
  repository: z.object({ full_name: z.string() }),
});
const executionSchema = z.object({
  id,
  run_id: id,
  run_attempt: id,
  head_sha: z.string(),
  name: z.string(),
  status: z.literal("completed"),
  conclusion: z.string(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
});
type Read = (path: string) => Promise<unknown>;
export class CiEvidenceHeadMoved extends Error {
  constructor(readonly head: string) {
    super("PR head changed during JUnit inspection");
  }
}
export type CiTestEvidence = {
  tests: { file: string; identity: string }[];
  main: { sha: string; run: number; attempt: number; job: number };
  artifacts: number[];
  mainArtifacts: number[];
};

/** XML entities are decoded by the parser; GitHub filenames are already decoded JSON strings. */
export function ciTestPath(raw: string): string | undefined {
  if (
    !raw ||
    raw.includes("\\") ||
    /^(?:\/|[a-z]:)/i.test(raw) ||
    [...raw].some(
      (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
    )
  )
    return;
  const parts = raw.split("/").filter((part) => part !== "." && part !== "");
  if (!parts.length || parts.includes("..")) return;
  return parts.join("/");
}

const children = (node: Bun.XML.Node) =>
  node.children.filter((child): child is Bun.XML.Node => typeof child === "object" && "name" in child);

/** A complete report: counters, unique structured identities and no suite-level errors. */
export function ciTestReport(xml: string) {
  if (Buffer.byteLength(xml) > limit || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsafe JUnit");
  const root = Bun.XML.parse(xml, { compact: false });
  if (!["testsuite", "testsuites"].includes(root.name)) throw new Error("Invalid JUnit root");
  const tests = new Map<string, { file: string; outcome: string }>();
  const visit = (node: Bun.XML.Node, suites: string[] = [], inheritedFile?: string): number[] => {
    const file = node.attributes.file ?? inheritedFile;
    const counts = [0, 0, 0, 0];
    if (node.name === "testcase") {
      const path = file && ciTestPath(file);
      if (!path || !node.attributes.name) throw new Error("Missing testcase identity");
      if (
        (node.attributes.status !== undefined && node.attributes.status !== "run") ||
        (node.attributes.result !== undefined && node.attributes.result !== "completed") ||
        (node.attributes.disabled !== undefined && node.attributes.disabled !== "false")
      )
        throw new Error("Unknown testcase status");
      const outcomes = children(node).filter((child) => ["failure", "error", "skipped"].includes(child.name));
      if (outcomes.length > 1 || outcomes.some((outcome) => children(outcome).length))
        throw new Error("Ambiguous testcase outcome");
      const outcome = outcomes[0]?.name ?? "pass";
      const identity = JSON.stringify([
        path,
        suites,
        node.attributes.classname ?? null,
        node.attributes.name,
      ]);
      if (tests.has(identity)) throw new Error("Duplicate testcase identity");
      tests.set(identity, { file: path, outcome });
      counts[0] = 1;
      counts[1] = Number(outcome === "failure");
      counts[2] = Number(outcome === "error");
      counts[3] = Number(outcome === "skipped");
    }
    for (const child of children(node)) {
      if (["testsuite", "testcase"].includes(child.name) && node.name !== "testcase") {
        const nested = visit(
          child,
          node.name === "testsuite" ? [...suites, node.attributes.name ?? ""] : suites,
          file,
        );
        nested.forEach((count, index) => {
          counts[index] = (counts[index] ?? 0) + count;
        });
      } else if (
        !["failure", "error", "skipped", "system-out", "system-err", "properties"].includes(child.name) ||
        (node.name !== "testcase" && ["failure", "error", "skipped"].includes(child.name))
      )
        throw new Error("Unknown JUnit evidence");
    }
    ["tests", "failures", "errors", "skipped"].forEach((key, index) => {
      const value = node.attributes[key];
      if (
        (node === root && index < 3 && value === undefined) ||
        (value !== undefined && (!/^\d+$/.test(value) || Number(value) !== counts[index]))
      )
        throw new Error("Incomplete JUnit counts");
    });
    return counts;
  };
  visit(root);
  if (!tests.size) throw new Error("Empty JUnit report");
  return tests;
}

/** Read ZIP members in memory, bounded before decompression; never extract artifact paths. */
export function ciArtifactXml(value: unknown): string[] {
  if (!(value instanceof Uint8Array) || value.length > limit) throw new Error("Missing artifact archive");
  const zip = Buffer.from(value);
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (
    end < 0 ||
    zip.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + zip.readUInt16LE(end + 20) !== zip.length ||
    zip.readUInt32LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 8) !== zip.readUInt16LE(end + 10)
  )
    throw new Error("Invalid ZIP directory");
  const directoryEnd = zip.readUInt32LE(end + 16) + zip.readUInt32LE(end + 12);
  let at = zip.readUInt32LE(end + 16);
  let size = 0;
  const names = new Set<string>();
  const xml: string[] = [];
  for (let n = 0; n < zip.readUInt16LE(end + 10); n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const bytes = zip.readUInt32LE(at + 24);
    const length = zip.readUInt16LE(at + 28);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(zip.subarray(at + 46, at + 46 + length));
    const offset = zip.readUInt32LE(at + 42);
    size += bytes;
    if (
      size > limit ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      names.has(name) ||
      zip.readUInt32LE(offset) !== 0x04034b50
    )
      throw new Error("Unsafe ZIP entry");
    names.add(name);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    if (start + packed > zip.readUInt32LE(end + 16)) throw new Error("Truncated ZIP entry");
    const data = zip.subarray(start, start + packed);
    const content = method === 8 ? inflateRawSync(data, { maxOutputLength: limit }) : data;
    if (content.length !== bytes || Bun.hash.crc32(content) !== zip.readUInt32LE(at + 16))
      throw new Error("Corrupt ZIP entry");
    if (/\.xml$/i.test(name)) xml.push(new TextDecoder("utf-8", { fatal: true }).decode(content));
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  if (at !== directoryEnd || directoryEnd !== end || !xml.length) throw new Error("Incomplete artifact");
  return xml;
}

/** Summary agreement covers tests, not a shell script's other commands or failures. */
function testExecution(log: string): string[] {
  const lines = Bun.stripANSI(log)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, "").trim())
    .filter(Boolean);
  const exits = lines.flatMap((line, index) => (line.startsWith("##[error]") ? [index] : []));
  const exit = exits[0];
  if (
    exits.length !== 1 ||
    exit === undefined ||
    lines[exit] !== "##[error]Process completed with exit code 1."
  )
    throw new Error("Unattributed execution failure");
  const start = lines.findLastIndex((line, index) => index < exit && line.startsWith("##[group]Run "));
  const command = lines[start]?.slice("##[group]Run ".length);
  if (
    !command ||
    !/^bun test(?: [\w./=:-]+)*$/.test(command) ||
    lines[start + 1] !== command ||
    !/^shell: \/(?:usr\/bin|bin)\/bash (?:--noprofile --norc -e -o pipefail|-e) \{0\}$/.test(
      lines[start + 2] ?? "",
    ) ||
    lines[start + 3] !== "##[endgroup]"
  )
    throw new Error("Missing direct test execution");
  const output = lines.slice(start + 4, exit);
  if (
    !/^bun test v\d+\./.test(output[0] ?? "") ||
    !/^Ran \d+ tests? across \d+ files?\.(?: \[[\d.]+(?:ms|s)\])?$/.test(output.at(-1) ?? "") ||
    output.some((line) => line.startsWith("##[")) ||
    lines.some((line) => /\berror TS\d+:|^error: script .* exited with code \d+/i.test(line))
  )
    throw new Error("Non-test or incomplete execution evidence");
  return lines;
}

/** Unavailable evidence is handled by the caller as ordinary needs-fix, never as green CI. */
export async function unrelatedCiTests(
  read: Read,
  repo: string,
  pr: string,
  sha: string,
  branch: string,
  mainSha: string,
  origin: {
    id: number;
    run_id: number;
    run_attempt: number;
    name: string;
    steps: { conclusion: string | null }[];
  },
  log: string,
): Promise<CiTestEvidence> {
  if (
    origin.steps.filter((step) => step.conclusion === "failure").length !== 1 ||
    origin.steps.some((step) => !["success", "failure", "skipped"].includes(step.conclusion ?? ""))
  )
    throw new Error("Unattributed job failure");
  const run = runSchema.parse(await read(`actions/runs/${origin.run_id}`));
  const validRun = (r: z.infer<typeof runSchema>, head: string) =>
    r.repository.full_name.toLowerCase() === repo.toLowerCase() && r.head_sha === head;
  if (!validRun(run, sha) || run.id !== origin.run_id || run.run_attempt !== origin.run_attempt)
    throw new Error("Outdated JUnit execution");
  const remote = z
    .object({ head: z.object({ sha: z.string() }), changed_files: z.number().int().nonnegative() })
    .parse(await read(`pulls/${pr}`));
  if (remote.head.sha !== sha) throw new CiEvidenceHeadMoved(remote.head.sha);
  const changed = new Set<string>();
  const seen = new Set<string>();
  let count = 0;
  for (let page = 1; ; page++) {
    const files = z
      .array(z.object({ filename: z.string(), status: z.string(), previous_filename: z.string().optional() }))
      .parse(await read(`pulls/${pr}/files?per_page=100&page=${page}`));
    for (const file of files) {
      if (seen.has(file.filename)) throw new Error("Duplicate PR file");
      seen.add(file.filename);
      if (file.status === "renamed" && !file.previous_filename) throw new Error("Incomplete rename");
      for (const raw of [file.filename, file.previous_filename].filter((s): s is string => s !== undefined)) {
        const path = ciTestPath(raw);
        if (!path) throw new Error("Invalid changed path");
        changed.add(path);
      }
    }
    count += files.length;
    if (count === remote.changed_files) break;
    if (!files.length || count > remote.changed_files || count >= 3000)
      throw new Error("Incomplete PR files");
  }
  const latestPath = `actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(branch)}&head_sha=${mainSha}&status=completed&per_page=100&page=1`;
  const latestRun = async () =>
    z.object({ workflow_runs: z.array(runSchema) }).parse(await read(latestPath)).workflow_runs[0];
  const latest = await latestRun();
  if (
    !latest ||
    !validRun(latest, mainSha) ||
    latest.workflow_id !== run.workflow_id ||
    latest.head_branch !== branch
  )
    throw new Error("Missing latest default branch execution");
  const reports = async (r: z.infer<typeof runSchema>, jobId?: number) => {
    const all = z
      .object({ total_count: z.number(), jobs: z.array(executionSchema) })
      .parse(await read(`actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100&page=1`));
    const matches = all.jobs.filter((j) => j.name === origin.name);
    const job = matches[0];
    if (
      all.total_count !== all.jobs.length ||
      matches.length !== 1 ||
      !job ||
      (jobId !== undefined && job.id !== jobId) ||
      all.jobs.some(
        (j) => j.head_sha !== r.head_sha || j.run_id !== r.id || j.run_attempt !== r.run_attempt,
      ) ||
      job.conclusion !== (jobId === undefined ? "success" : "failure")
    )
      throw new Error("Ambiguous JUnit job");
    const artifacts = z
      .object({
        total_count: z.number(),
        artifacts: z.array(
          z.object({
            id,
            expired: z.boolean(),
            created_at: z.string().datetime(),
            size_in_bytes: z.number(),
            workflow_run: z.object({ id, head_sha: z.string() }),
          }),
        ),
      })
      .parse(await read(`actions/runs/${r.id}/artifacts?per_page=100&page=1`));
    if (artifacts.total_count !== artifacts.artifacts.length) throw new Error("Incomplete artifacts");
    const tests = new Map<string, { file: string; outcome: string }>();
    const ids: number[] = [];
    for (const artifact of artifacts.artifacts) {
      const created = Date.parse(artifact.created_at);
      if (created < Date.parse(job.started_at) || created > Date.parse(job.completed_at)) continue;
      // Actions artifacts have run provenance, but no job/attempt id. Require an exclusive job window.
      if (
        all.jobs.some(
          (other) =>
            other.id !== job.id &&
            created >= Date.parse(other.started_at) &&
            created <= Date.parse(other.completed_at),
        ) ||
        artifact.expired ||
        artifact.size_in_bytes > limit ||
        artifact.workflow_run.id !== r.id ||
        artifact.workflow_run.head_sha !== r.head_sha
      )
        throw new Error("Unavailable or ambiguous JUnit artifact");
      for (const xml of ciArtifactXml(await read(`actions/artifacts/${artifact.id}/zip`)))
        for (const [identity, test] of ciTestReport(xml)) {
          if (tests.has(identity)) throw new Error("Conflicting JUnit reports");
          tests.set(identity, test);
        }
      ids.push(artifact.id);
    }
    if (!tests.size) throw new Error("Missing JUnit reports");
    return { tests, ids, job };
  };
  const failed = await reports(run, origin.id);
  // JUnit counters alone can omit runner/load failures. Corroborate the entire failing execution.
  const runner = new RunnerFailureEvidence();
  for (const line of testExecution(log)) runner.observe(line);
  const outcomes = [...failed.tests.values()];
  if (
    !runner.agrees({
      tests: outcomes.length,
      failures: outcomes.filter((t) => t.outcome === "failure").length,
      errors: outcomes.filter((t) => t.outcome === "error").length,
      skipped: outcomes.filter((t) => t.outcome === "skipped").length,
    })
  )
    throw new Error("Incomplete runner evidence");
  const main = await reports(latest);
  const tests = [...failed.tests].filter(([, test]) => ["failure", "error"].includes(test.outcome));
  if (
    !tests.length ||
    tests.some(([identity, test]) => changed.has(test.file) || main.tests.get(identity)?.outcome !== "pass")
  )
    throw new Error("Testcase is changed or lacks a default branch pass");
  const currentRun = runSchema.parse(await read(`actions/runs/${run.id}`));
  const currentMain = await latestRun();
  const tip = z.object({ sha: z.string() }).parse(await read(`commits/${encodeURIComponent(branch)}`));
  if (
    !validRun(currentRun, sha) ||
    currentRun.id !== run.id ||
    currentRun.run_attempt !== run.run_attempt ||
    !currentMain ||
    currentMain.id !== latest.id ||
    currentMain.run_attempt !== latest.run_attempt ||
    !validRun(currentMain, mainSha) ||
    tip.sha !== mainSha
  )
    throw new Error("JUnit evidence was superseded during inspection");
  return {
    tests: tests.map(([identity, test]) => ({ file: test.file, identity })),
    main: { sha: mainSha, run: latest.id, attempt: latest.run_attempt, job: main.job.id },
    artifacts: failed.ids,
    mainArtifacts: main.ids,
  };
}
