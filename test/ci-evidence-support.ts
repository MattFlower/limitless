import { deflateRawSync } from "node:zlib";
import { type fakeGitHub, respond } from "./github-poller-support.ts";

/** Inline reports, compressed exactly as an Actions artifact, without filesystem/network clients. */
export function reportZip(xml: string): Uint8Array {
  const name = Buffer.from("junit.xml");
  const text = Buffer.from(xml);
  const compressed = deflateRawSync(text);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(Bun.hash.crc32(text), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(text.length, 22);
  local.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt32LE(Bun.hash.crc32(text), 16);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(text.length, 24);
  directory.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, directory, name, end]);
}

export const junit = (outcome = "failure", file = "test/example.test.ts", name = "asserts") =>
  `<testsuite name="suite" tests="1" failures="${Number(outcome === "failure")}" errors="0" skipped="${Number(outcome === "skipped")}">
    <testcase file="${file}" classname="outer" name="${name}">${outcome === "pass" ? "" : `<${outcome}/>`}</testcase>
  </testsuite>`;
export const assertionLog = "(fail) asserts\n0 pass\n1 fail\nRan 1 test across 1 file.";

export function ciEvidence(
  github: ReturnType<typeof fakeGitHub>,
  repo: string,
  number: number,
  sha: string,
  origin: { id: number; run_id: number; run_attempt: number; name: string },
) {
  const mainSha = "b".repeat(40);
  const start = "2026-10-29T00:00:00Z";
  const completed = "2026-10-29T00:01:00Z";
  const run = {
    id: origin.run_id,
    workflow_id: 70,
    head_sha: sha,
    head_branch: "pr",
    run_attempt: origin.run_attempt,
    status: "completed",
    repository: { full_name: repo },
  };
  const mainRun = { ...run, id: 90, head_sha: mainSha, head_branch: "main" };
  const execution = {
    ...origin,
    head_sha: sha,
    status: "completed",
    conclusion: "failure",
    started_at: start,
    completed_at: completed,
  };
  const mainJob = { ...execution, id: 91, run_id: 90, head_sha: mainSha, conclusion: "success" };
  const artifact = (r: typeof run, id: number) => ({
    id,
    expired: false,
    created_at: "2026-10-29T00:00:30Z",
    size_in_bytes: 500,
    workflow_run: { id: r.id, head_sha: r.head_sha },
  });
  const state = {
    prXml: junit(),
    mainXml: junit("pass"),
    files: [{ filename: "src/changed.ts", status: "modified" }] as {
      filename: string;
      status: string;
      previous_filename?: string;
    }[],
    run,
    mainRun,
    execution,
    mainJob,
    prArtifacts: [artifact(run, 81)],
    mainArtifacts: [artifact(mainRun, 82)],
    mainRuns: [mainRun],
  };
  const set = (path: string, body: () => unknown) =>
    github.responses.set(`repos/${repo}/${path}`, () => respond(200, body()));
  set(`pulls/${number}`, () => ({
    node_id: `PR_${repo}_${number}`,
    head: { sha },
    state: "open",
    changed_files: state.files.length,
  }));
  set(`pulls/${number}/files?per_page=100&page=1`, () => state.files);
  set(`actions/runs/${run.id}`, () => state.run);
  set(
    `actions/workflows/70/runs?branch=main&head_sha=${mainSha}&status=completed&per_page=100&page=1`,
    () => ({ workflow_runs: state.mainRuns }),
  );
  set(`actions/runs/${run.id}/attempts/1/jobs?per_page=100&page=1`, () => ({
    total_count: 1,
    jobs: [state.execution],
  }));
  set(`actions/runs/90/attempts/1/jobs?per_page=100&page=1`, () => ({
    total_count: 1,
    jobs: [state.mainJob],
  }));
  set(`actions/runs/${run.id}/artifacts?per_page=100&page=1`, () => ({
    total_count: state.prArtifacts.length,
    artifacts: state.prArtifacts,
  }));
  set("actions/runs/90/artifacts?per_page=100&page=1", () => ({
    total_count: state.mainArtifacts.length,
    artifacts: state.mainArtifacts,
  }));
  set("actions/artifacts/81/zip", () => reportZip(state.prXml));
  set("actions/artifacts/82/zip", () => reportZip(state.mainXml));
  return state;
}
