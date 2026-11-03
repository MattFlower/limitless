import { expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, environment, operation, registry, validate } from "../scripts/benchmark-gate-output.ts";
import { launch, measureWorker } from "../scripts/benchmark-privacy-boundary.ts";
import { trackResumptions } from "../scripts/benchmark-resumptions.ts";
import { readCoveringJUnit, readJUnit, readJUnitSkips } from "../src/gates/junit.ts";
import { processBirthSync } from "../src/util/proc.ts";
import { describe, junitReport } from "./benchmark-gate-output-support.ts";

const pause = () => new Promise<void>((done) => setImmediate(done));
const raw = setImmediate;
const wait = () => new Promise<void>((done) => raw(done)); // Unhooked: invisible to resumption tracking.
async function temporary<T>(fn: (root: string) => Promise<T>) {
  const root = await fs.mkdtemp(join(tmpdir(), "producer-test-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function fakeRevision(root: string) {
  await fs.mkdir(join(root, "src/util"), { recursive: true });
  await fs.writeFile(
    join(root, "src/util/privacy-boundary.ts"),
    "export const createPrivacyRegistry=()=>({replacePolicy(){},addCredential(){}});",
  );
  await fs.writeFile(join(root, "src/util/privacy-chunks.ts"), "export {};\n");
  await fs.writeFile(
    join(root, "src/util/privacy-checker.ts"),
    "let disposed=0; export const count=()=>disposed; export const createPrivacyChecker=({registry})=>({registry,async dispose(){disposed++}});",
  );
}
type Group = {
  raw: { warmup: boolean; slice: number; idle: number[][]; turns: [number, number, number, string][] }[];
  worstSlice: number;
  median: number;
};

test("entries, continuations and hooked resumptions merge until a heartbeat; unowned gap time is idle", async () => {
  await temporary(async (root) => {
    await fakeRevision(root);
    let clock = 0;
    const runtime = {
      now: () => clock,
      pause: wait,
      gc: () => {},
      memory: () => ({ heap: 0, peakRSS: 0 }),
      platform: ["deterministic"],
    };
    const restore = trackResumptions();
    try {
      const result = await measureWorker(root, runtime, {
        merged: {
          dimensions: {},
          run: async (_checker, own) => {
            own("first", () => {
              clock += 2;
            });
            await Promise.resolve();
            own("second", () => {
              clock += 3;
            });
            await wait();
            clock += 100; // A worker's waiting time: no implementation entry or hooked resumption.
            await wait();
            await pause(); // A hooked resumption that then stalls without using CPU (no CPU clock exists here).
            clock += 40;
            await wait();
            clock += 30; // Unowned time before an entry in the same heartbeat gap stays idle.
            own("late", () => {
              clock += 40;
            });
            await wait();
            own("after-worker", () => {
              clock += 7;
            });
            return true;
          },
          check: (v) => ({ outcome: validate(v) }),
        },
      });
      const group = result.groups.merged as Group;
      expect(group.raw).toHaveLength(7);
      for (const trial of group.raw) {
        expect(trial.turns.map((t) => t[1])).toEqual([5, 40, 40, 7]);
        expect(trial.turns[0]?.[3]).toContain("first,second");
        expect(trial.turns[1]?.[3]).toBe("resumed");
        expect(trial.turns[2]?.[3]).toBe("late");
        expect(trial.turns[3]?.[3]).toContain("after-worker");
        expect(trial.idle.map((gap) => gap[1])).toEqual([100, 30]);
        expect(trial.slice).toBe(40);
      }
    } finally {
      restore();
    }
    expect(setImmediate).toBe(raw);
    const { count } = await import(join(root, "src/util/privacy-checker.ts"));
    expect(count()).toBe(7);
  });
});

test("64 microtask rounds restart at re-entry; warmup maxima and measured medians use separate trials", async () => {
  await temporary(async (root) => {
    await fakeRevision(root);
    let clock = 0;
    const spans = [90, 80, 10, 11, 12, 13, 14];
    const result = await measureWorker(
      root,
      {
        now: () => clock,
        pause,
        gc: () => {},
        memory: () => ({ heap: 0, peakRSS: 0 }),
        platform: [],
      },
      {
        spans: {
          dimensions: {},
          run: () => {
            clock += spans.shift() ?? 0;
          },
          check: () => ({}),
        },
        continuation: {
          dimensions: {},
          run: async (_checker, own) => {
            for (let i = 0; i < 96; i++) {
              await Promise.resolve();
              clock++;
              if (i === 31) own("re-entry", () => {});
            }
            await pause();
          },
          check: () => ({}),
        },
      },
    );
    expect(result.groups.spans).toMatchObject({ worstSlice: 90, median: 12 });
    expect((result.groups.spans as Group).raw.map((r) => r.warmup)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    for (const trial of (result.groups.continuation as Group).raw) {
      expect(trial.turns[0]?.[1]).toBe(95);
      expect(trial.turns[0]?.[3]).toContain("re-entry");
    }
  });
});

test("revision adapters use local exports, label the baseline process path and reject bad results", async () => {
  await temporary(async (root) => {
    const modules = [
      "export async function runProcess(o){o.onStdoutLine('.'.repeat(65536)+' [truncated]');return {exitCode:0}}",
      "export function lineSplitter(emit,limit){return {push(){emit('.'.repeat(limit)+' [truncated]')},flush(){}}} export function runProcess(){throw Error('wrong API')}",
      "export async function runProcess(){return {exitCode:1}}",
    ];
    for (const [i, source] of modules.entries()) {
      const file = join(root, `revision-${i}.ts`);
      await fs.writeFile(file, source);
      const a = await import(file);
      const cwd = join(root, `fixture-${i}`);
      await fs.mkdir(cwd);
      const jobs = await registry["long-line"]?.({
        a,
        cwd,
        env: environment(root),
        checker: () => {
          throw Error("not needed");
        },
        key: Buffer.alloc(32),
      });
      const [label, size, run, check] = jobs?.[0] ?? [];
      expect(label).toContain(i === 1 ? "lineSplitter:" : "baseline-equivalent:");
      expect(size).toBe(5 * 1048576);
      expect(run).toBeDefined();
      const value = await run?.();
      if (i < 2) expect(check?.(value)).toBe("processed");
      else expect(() => check?.(value)).toThrow("Invalid workload result");
      const unavailable = operation(a, "checkAndSign");
      expect(unavailable).toEqual({ path: "unavailable", run: undefined });
    }
  });
});

test("producer failure disposes its checker and lets the harness return a rejection", async () => {
  await temporary(async (root) => {
    await fakeRevision(root);
    await expect(
      measureWorker(root, undefined, {
        fail: {
          dimensions: {},
          run: () => {
            throw Error("injected operation failure");
          },
          check: () => ({}),
        },
      }),
    ).rejects.toThrow("injected operation failure");
    const { count } = await import(join(root, "src/util/privacy-checker.ts"));
    expect(count()).toBe(1);
  });
});

test("local worker policy and key stay in scratch; snapshots and owned workers close on success and failure", async () => {
  await temporary(async (root) => {
    const probe = join(root, "worker-probe.ts");
    await fs.writeFile(
      probe,
      `
      import fs from 'node:fs';
      import { join, relative } from 'node:path';
      const root=process.argv[3], seen=[];
      function guard(path) {
        if (!/(?:private-strings\\.txt|privacy-proof\\.key|secrets\\.env)$/.test(String(path))) return;
        if (relative(root,String(path)).startsWith('..')) throw Error('owner configuration access');
        seen.push(relative(root,String(path)));
      }
      const write=fs.promises.writeFile;
      fs.promises.writeFile=async(path,...args)=>{guard(path);return write(path,...args)};
      for (const name of ['openSync','readFileSync','lstatSync','statSync']) {
        const original=fs[name];fs[name]=(path,...args)=>{guard(path);return original(path,...args)};
      }
      let rejected=false;try{guard(join(root,'..','owner','secrets.env'))}catch{rejected=true}
      if(!rejected||process.env.HOME!==root||process.env.LIMITLESS_CONFIG_DIR!==join(root,'config')) throw Error('isolation');
      const {registry,worker}=await import(${JSON.stringify(join(process.cwd(), "scripts/benchmark-gate-output.ts"))});
      registry.probe=()=>[['probe',1,()=>true,v=>{if(v!==true)throw Error('wrong result');return 'processed'}]];
      const result=await worker(root,'probe');
      if(!seen.includes('config/private-strings.txt')||!seen.includes('config/privacy-proof.key')) throw Error('missing fixture');
      await write(${JSON.stringify(join(root, "observed.json"))},JSON.stringify({root,pid:process.pid}));
      if(process.argv[4]==='long-line')throw Error('injected worker failure');
      console.log(JSON.stringify({...result,seen,rejected}));
    `,
    );
    const roots: string[] = [];
    const invoke: typeof launch = async (job, _script, env) => {
      const handle = await launch(job, probe, (scratch) => {
        roots.push(scratch);
        return (env ?? environment)(scratch);
      });
      return {
        result: handle.result.finally(async () => {
          if (!existsSync(join(root, "observed.json"))) return;
          const observed = await Bun.file(join(root, "observed.json")).json();
          expect(roots).toContain(observed.root);
          expect(processBirthSync(observed.pid)).toBeNull();
          expect(existsSync(join(observed.root, "src/util/privacy-proof.ts"))).toBe(true);
          expect(existsSync(join(observed.root, "config/privacy-proof.key"))).toBe(true);
        }),
        cleanup: handle.cleanup,
      };
    };
    const result = await compare(["HEAD", "HEAD"], ["gate-5mib"], invoke);
    const reports = result.results.map((r) => r.report as { pid: number; rejected: boolean });
    expect(reports[0]?.pid).not.toBe(reports[1]?.pid);
    expect(reports.every((r) => r.rejected)).toBe(true);
    expect(reports.map((r) => processBirthSync(r.pid))).toEqual([null, null]);
    expect(roots.every((path) => !existsSync(path))).toBe(true);
    await expect(compare(["HEAD", "HEAD"], ["long-line"], invoke)).rejects.toThrow("injected worker failure");
    expect(roots).toHaveLength(4); // Sequential orchestration awaits/cleans every handle, even on failure.
    expect(roots.every((path) => !existsSync(path))).toBe(true);
  });
});

test("bad CLI arguments fail before launching a worker", async () => {
  const invoke: typeof launch = () => {
    throw Error("no worker may launch");
  };
  await expect(compare(["HEAD"], ["gate-5mib"], invoke)).rejects.toThrow("expected two refs, got 1; usage:");
  await expect(compare(["HEAD", "HEAD"], ["gate-5mib", "bogus"], invoke)).rejects.toThrow(
    "unknown workload(s) bogus; known: gate-5mib",
  );
  await expect(
    compare(["HEAD", "not-a-real-revision-for-producer-benchmark"], ["gate-5mib"], invoke),
  ).rejects.toThrow('ref "not-a-real-revision-for-producer-benchmark" does not name a commit');
  const cli = (...args: string[]) =>
    Bun.spawnSync([process.execPath, "scripts/benchmark-gate-output.ts", ...args], { stderr: "pipe" });
  const failed = cli("HEAD", "HEAD", "bogus");
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout.toString()).toBe("");
  expect(failed.stderr.toString().trim()).toStartWith("benchmark-gate-output: unknown workload(s) bogus;");
});

test("low-CPU stalls after file I/O, imported, captured or global timer resumptions are owned in a CLI worker", async () => {
  await temporary(async (root) => {
    await fakeRevision(root);
    await fs.mkdir(join(root, "src/gates"));
    await fs.appendFile(
      join(root, "src/util/privacy-boundary.ts"),
      "export const privacyRegistry={replacePolicy(){}}; export function registerCredential(){}",
    );
    // Scheduling and I/O APIs are imported or captured at module initialization; each resumption then blocks
    // synchronously without CPU before (or without) touching an instrumented API.
    await fs.writeFile(
      join(root, "src/gates/junit.ts"),
      `import { readFile } from 'node:fs/promises';
      import { setImmediate as later } from 'node:timers/promises';
      import { setImmediate as soon } from 'node:timers';
      const captured=setImmediate, stall=()=>Bun.sleepSync(20);
      export async function readJUnit(){
        await later(); stall();
        await new Promise((r)=>soon(r)); stall();
        await new Promise((r)=>captured(r)); stall();
        await new Promise((r)=>setTimeout(r,1)); stall();
        await Bun.sleep(1); stall();
        await readFile(import.meta.path); stall();
        await Bun.file(import.meta.path).text(); stall();
        const root=Bun.XML.parse('<a/>',{compact:false}); // The wrapper must forward the readers' options.
        return root.name==='a'?{failedFiles:['sample.test.ts']}:root;
      }`,
    );
    const script = join(process.cwd(), "scripts/benchmark-gate-output.ts");
    const preload = join(process.cwd(), "scripts/benchmark-resumptions.ts");
    const run = Bun.spawnSync([process.execPath, "--preload", preload, script, "--worker", root, "junit"], {
      env: environment(root),
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    const report = JSON.parse(run.stdout.toString());
    const groups = Object.entries(report.groups as Record<string, Group>);
    expect(groups.map(([label]) => label)).toEqual(
      [1, 4, 16].map((n) => `readJUnit:readJUnit/${n * 1048576}`),
    );
    for (const [, group] of groups) {
      expect(group.raw).toHaveLength(7);
      for (const trial of group.raw as (Group["raw"][number] & { parses: number })[]) {
        const owned = trial.turns.filter((t) => t[1] >= 19);
        expect(owned).toHaveLength(7);
        for (const turn of owned) expect(turn[3]).toContain("resumed");
        expect(owned[6]?.[3]).toContain("XML.parse");
        expect(trial.idle.filter((gap) => (gap[1] ?? 0) >= 19)).toEqual([]);
        expect(trial.parses).toBe(1);
      }
    }
  });
}, 60_000);

test("missing proof APIs remain unavailable at every identity boundary", async () => {
  await temporary(async (root) => {
    const jobs = await registry.identities?.({
      a: { IDENTITY_CAP: 8 },
      cwd: root,
      env: environment(root),
      key: Buffer.alloc(32),
      checker: () => {
        throw Error("unavailable proof must not construct a checker");
      },
    });
    expect(jobs).toHaveLength(12);
    expect(describe("identities", "sha256", 8, { IDENTITY_CAP: 8 }).identityCoverage).toBe(false);
    expect(
      describe("identities", "sha256", 9, { IDENTITY_CAP: 8, gateIdentities: () => "identity-cap" })
        .identityCoverage,
    ).toBe(false);
    for (let i = 0; i < 3; i++) {
      const rows = jobs?.slice(i * 4, i * 4 + 4) ?? [];
      expect(rows.map((r) => r[1])).toEqual(Array(4).fill([8, 9, 80][i]));
      expect(rows[0]?.[2]).toBeUndefined();
      expect(rows[2]?.[2]).toBeUndefined();
      expect(rows[3]?.[2]).toBeUndefined();
      expect(rows[1]?.[3](rows[1]?.[2]?.())).toBe("hashed");
    }
  });
});

test("a malformed worker report cannot become a successful comparison", async () => {
  const invoke: typeof launch = async (job) => ({
    result: Promise.resolve({ ...job, report: {} }),
    cleanup: async () => {},
  });
  await expect(compare(["HEAD", "HEAD"], ["gate-5mib"], invoke)).rejects.toThrow("worker report");
});

test("sized JUnit fixtures contain real cases, coherent counters and canonical local files", async () => {
  await temporary(async (root) => {
    await fs.writeFile(join(root, "sample.test.ts"), "");
    const file = join(root, "report.xml");
    for (const [failures, skipped] of [
      [1, 0],
      [0, 1],
      [0, 0],
    ] as const) {
      const xml = junitReport(2048, failures, skipped);
      expect(Buffer.byteLength(xml)).toBe(2048);
      await fs.writeFile(file, xml);
      if (failures) expect(readJUnit(file, root)).toMatchObject({ failedFiles: ["sample.test.ts"] });
      else if (skipped)
        expect(readJUnitSkips(file, root)).toMatchObject({
          counts: { tests: 7, skipped: 1 },
          skippedTests: [{ file: "sample.test.ts", name: "case", line: 1 }],
        });
      else
        expect(
          readCoveringJUnit(file, root, { file: "sample.test.ts", name: "case" }, 0, false).reason,
        ).toBeUndefined();
    }
  });
});

test("cap validation rejects corrupt bytes even when metadata claims complete coverage", async () => {
  await temporary(async (root) => {
    const jobs = await registry["gate-cap"]?.({
      a: { createPrivacyChecker: () => {} },
      cwd: root,
      env: environment(root),
      key: Buffer.alloc(32),
      checker: () => {
        throw Error("validation must not submit");
      },
    });
    const check = jobs?.[0]?.[3];
    expect(check).toBeDefined();
    expect(() =>
      check?.({
        checkedComplete: true,
        withheld: false,
        byteLength: 8 * 1048576,
        bytes: Buffer.alloc(8 * 1048576, "-"),
      }),
    ).toThrow("Invalid workload result");
  });
});
