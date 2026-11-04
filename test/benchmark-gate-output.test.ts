import { expect, spyOn, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, environment, operation, registry, validate } from "../scripts/benchmark-gate-output.ts";
import { launch, measureWorker } from "../scripts/benchmark-privacy-boundary.ts";
import { resumptions, trackResumptions } from "../scripts/benchmark-resumptions.ts";
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

test("FileHandle open, reads, metadata and rejections own continuations and restore methods", async () => {
  await temporary(async (root) => {
    const file = join(root, "input");
    await fs.writeFile(file, "synthetic bytes");
    const originalOpen = fs.open;
    const before = await fs.open(file, "r+");
    const prototype = Object.getPrototypeOf(before);
    const descriptors = Object.getOwnPropertyDescriptors(prototype);
    const restore = trackResumptions();
    let owned = false;
    resumptions.own = (_phase, fn) => {
      owned = true;
      return fn();
    };
    const check = async <T>(name: string, run: () => Promise<T>) => {
      await wait();
      owned = false;
      const value = await run();
      expect(owned, `FileHandle.${name} must own before its awaiting continuation`).toBe(true);
      return value;
    };
    let handle: typeof before | undefined;
    try {
      handle = await check("open", () => fs.open(file, "r+"));
      const h = handle;
      const read = h.read;
      const second = await fs.open(file);
      expect(h.read).toBe(read); // Re-encountering the prototype must not wrap it twice.
      await second.close();
      const buffer = Buffer.alloc(9);
      expect(await check("read", () => h.read(buffer, 0, 9, 0))).toEqual({ bytesRead: 9, buffer });
      expect(buffer.toString()).toBe("synthetic");
      const buffers = [Buffer.alloc(4), Buffer.alloc(5)];
      expect(await check("readv", () => h.readv(buffers, 0))).toEqual({ bytesRead: 9, buffers });
      expect(Buffer.concat(buffers).toString()).toBe("synthetic");
      expect(await check("readFile", () => h.readFile("utf8"))).toBe("synthetic bytes");
      expect((await check("stat", () => h.stat())).size).toBe(15);
      expect(await check("fs.readFile(handle)", () => fs.readFile(before, "utf8"))).toBe("synthetic bytes");
      const failure = Object.assign(Error("synthetic I/O rejection"), { code: "EIO" });
      // The original operation returns this exact error; wrapping must neither replace nor swallow it.
      const failed = await check("rejected open", () => fs.open(join(root, "missing")).catch((e) => e));
      expect(failed.code).toBe("ENOENT");
      expect(await check("close", () => h.close())).toBeUndefined();
      const closed = await check("rejected read", () => h.readFile("utf8").catch((e) => e));
      expect(closed).toBeInstanceOf(Error);
      expect(closed.code).toBe("EBADF");
      // A method installed before tracking is also passed through with its receiver and error intact.
      restore();
      const originalRead = prototype.readFile;
      prototype.readFile = function () {
        expect(this).toBe(before);
        return Promise.reject(failure);
      };
      const remove = trackResumptions();
      try {
        const trigger = await fs.open(file);
        await trigger.close();
        expect(await check("exact rejection", () => before.readFile().catch((e) => e))).toBe(failure);
      } finally {
        remove();
        prototype.readFile = originalRead;
      }
    } finally {
      restore();
      resumptions.own = undefined;
      await handle?.close();
      await before.close();
    }
    expect(fs.open).toBe(originalOpen);
    expect(Object.getOwnPropertyDescriptors(prototype)).toEqual(descriptors);
  });
});

test("FileHandle open pending during removal cannot reinstall hooks", async () => {
  await temporary(async (root) => {
    const file = join(root, "pending");
    await fs.writeFile(file, "");
    const originalOpen = fs.open;
    const before = await originalOpen(file);
    const prototype = Object.getPrototypeOf(before);
    const descriptors = Object.getOwnPropertyDescriptors(prototype);
    await before.close();
    const restore = trackResumptions();
    const pending = fs.open(file);
    restore();
    const handle = await pending;
    try {
      expect(Object.getOwnPropertyDescriptors(prototype)).toEqual(descriptors);
      expect(fs.open).toBe(originalOpen);
    } finally {
      await handle.close();
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

// Four fresh workers import the revision and archive src; allow startup contention on a two-core CI runner.
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
}, 30_000);

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

test("implicit workload selection keeps the original producer defaults", async () => {
  const names: string[] = [];
  const invoke: typeof launch = async ({ ref, name }) => {
    names.push(name);
    return {
      result: Promise.resolve({ ref, name, report: { pid: 1, groups: {}, unavailable: [{}] } }),
      cleanup: async () => {},
    };
  };
  await compare(["HEAD", "HEAD"], undefined, invoke);
  const producers = [
    "gate-5mib",
    "gate-cap",
    "long-line",
    "scanner-overflow",
    "scanner-files",
    "junit",
    "identities",
  ];
  expect(names).toEqual([...producers, ...producers]);
  expect(registry["event-drain"]).toBeFunction();
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
      `import { readFile, open } from 'node:fs/promises';
      import { setImmediate as later } from 'node:timers/promises';
      import { setImmediate as soon } from 'node:timers';
      import { resumptions } from ${JSON.stringify(join(process.cwd(), "scripts/benchmark-resumptions.ts"))};
      const captured=setImmediate, stall=()=>Bun.sleepSync(20);
      // Label only actual ownership entries: a missing hook cannot gain ownership from this observer.
      let owner, kind;
      Object.defineProperty(resumptions,'own',{configurable:true,get:()=>owner,set:f=>{
        owner=f&&((phase,run)=>f(phase==='resumed'&&kind?'resumed:'+kind:phase,run));
      }});
      async function step(name,run){
        await new Promise(r=>resumptions.setImmediate(r));
        kind=name;
        const value=await run(); stall();
        kind=undefined;
        return value;
      }
      export async function readJUnit(){
        await step('imported promise timer',()=>later());
        await step('imported callback timer',()=>new Promise(r=>soon(r)));
        await step('captured global timer',()=>new Promise(r=>captured(r)));
        await step('global timeout',()=>new Promise(r=>setTimeout(r,1)));
        await step('Bun.sleep',()=>Bun.sleep(1));
        await step('fs.promises.readFile',()=>readFile(import.meta.path));
        await step('Bun.file().text',()=>Bun.file(import.meta.path).text());
        const handle=await step('FileHandle.open',()=>open(import.meta.path));
        try {
          await step('FileHandle.readFile',()=>handle.readFile());
        } finally { await step('FileHandle.close',()=>handle.close()); }
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
    const kinds = [
      "imported promise timer",
      "imported callback timer",
      "captured global timer",
      "global timeout",
      "Bun.sleep",
      "fs.promises.readFile",
      "Bun.file().text",
      "FileHandle.open",
      "FileHandle.readFile",
      "FileHandle.close",
    ];
    for (const [label, group] of groups) {
      expect(group.raw).toHaveLength(7);
      expect(group.raw.map((trial) => trial.warmup)).toEqual([true, true, false, false, false, false, false]);
      for (const [index, trial] of (group.raw as (Group["raw"][number] & { parses: number })[]).entries()) {
        const owned = trial.turns.filter((t) => t[1] >= 19);
        for (const kind of kinds) {
          expect(
            owned.filter((turn) => turn[3].split(",").includes(`resumed:${kind}`)),
            `${label}, trial ${index}: ${kind} stall must be owned`,
          ).toHaveLength(1);
        }
        expect(owned).toHaveLength(kinds.length);
        expect(owned.at(-1)?.[3]).toContain("XML.parse");
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

async function consumerContext(
  root: string,
  run: (c: import("./benchmark-gate-output-support.ts").Context) => Promise<void>,
) {
  const boundary = await import("../src/util/privacy-boundary.ts");
  const proof = await import("../src/util/privacy-proof.ts");
  const policy = await import("../src/util/privacy-policy.ts");
  const identities = await import("../src/gates/text-privacy.ts");
  const output = await import("../src/gates/output.ts");
  const { createPrivacyChecker } = await import("../src/util/privacy-checker.ts");
  const env = environment(root);
  await fs.mkdir(env.LIMITLESS_CONFIG_DIR);
  await fs.writeFile(join(env.LIMITLESS_CONFIG_DIR, "private-strings.txt"), "synthetic-policy-value\n");
  const checker = createPrivacyChecker({ registry: boundary.createPrivacyRegistry() });
  try {
    await run({
      a: { ...proof, ...policy, ...identities, ...output },
      cwd: root,
      env,
      checker: () => checker,
      key: Buffer.alloc(32, 17),
    });
  } finally {
    await checker.dispose();
  }
}

test("consumer fixtures distinguish genuine, absent, refused and freshly invalidated proofs on every trial", async () => {
  await temporary((root) =>
    consumerContext(root, async (c) => {
      const verify = c.a.verifier as typeof import("../src/util/privacy-proof.ts").verifier;
      const observations: boolean[] = [];
      c.a.verifier = (...args: Parameters<typeof verify>) => {
        const v = verify(...args);
        return {
          verify: (...input: Parameters<typeof v.verify>) => {
            const valid = v.verify(...input);
            observations.push(valid);
            return valid;
          },
        };
      };
      for (const name of ["project-proven", "project-unproven", "project-refused", "project-after-edit"]) {
        const jobs = await registry[name]?.(c);
        expect(jobs).toHaveLength(2);
        for (const job of jobs ?? []) {
          expect(job[0]).toContain("baseline-equivalent");
          for (let trial = 0; trial < (name === "project-after-edit" ? 7 : 1); trial++) {
            observations.length = 0;
            await job[4]?.();
            expect(observations).toHaveLength(100);
            expect(
              observations.every((v) => v === (name === "project-proven" || name === "project-after-edit")),
            ).toBe(true);
            observations.length = 0;
            const value = await job[2]?.();
            expect(job[3](value)).toContain("50 released");
            expect(observations).toHaveLength(name === "project-after-edit" ? 50 : 0);
            expect(observations.every((v) => v === false)).toBe(true);
            if (name === "project-refused") expect(String(value)).toContain('"withheld":true');
            if (name === "project-unproven") expect(String(value)).not.toContain('"textPrivacy"');
            expect(() => job[3](JSON.stringify({ lastGates: [] }))).toThrow("50 projected gates");
            const corrupt = JSON.parse(String(value));
            corrupt.lastGates[0].result.output = "wrong bytes";
            expect(() => job[3](JSON.stringify(corrupt))).toThrow("projection release class");
          }
        }
      }
      c.a.checkAndSign = async () => ({ kind: "rendering", mac: "0".repeat(64) });
      const broken = await registry["project-proven"]?.(c);
      await expect(broken?.[0]?.[4]?.()).rejects.toThrow("fixture proof class");
    }),
  );
});

test("consumer adapters select revision exports, reject leaking or malformed projections and mark missing APIs unavailable", async () => {
  await temporary((root) =>
    consumerContext(root, async (c) => {
      const modes: unknown[] = [];
      c.a.projectGateDiagnostics = (r: unknown, options: { mode: string }) => {
        modes.push(options.mode);
        return r;
      };
      const proven = await registry["project-proven"]?.(c);
      for (const job of proven ?? []) {
        await job[4]?.();
        expect(job[3](await job[2]?.())).toContain("50 released");
        expect(job[0]).toContain("projectGateDiagnostics");
      }
      expect(modes.filter((m) => m === "outward")).toHaveLength(50);
      expect(modes.filter((m) => m === "durable")).toHaveLength(50);
      for (const name of ["project-unproven", "project-refused", "project-after-edit"]) {
        const job = (await registry[name]?.(c))?.[0];
        await job?.[4]?.();
        expect(() => job?.[3](job[2]?.())).toThrow("projection release class");
      }
      c.a.projectGateDiagnostics = () => undefined;
      const malformed = (await registry["project-proven"]?.(c))?.[0];
      await malformed?.[4]?.();
      expect(() => malformed?.[3](malformed[2]?.())).toThrow("projection shape");
      for (const name of [
        "project-proven",
        "project-unproven",
        "project-refused",
        "project-after-edit",
        "events",
        "event-drain",
        "feedback-sign",
        "render-prompts",
        "land-log",
      ]) {
        const jobs = await registry[name]?.({ ...c, a: {} });
        expect(jobs?.length).toBeGreaterThan(0);
        expect(jobs?.every((job) => job[2] === undefined)).toBe(true);
      }
    }),
  );
});

test("SSE consumption retains split and bundled frames and validates only after measurement", async () => {
  await temporary(async (root) => {
    const c: import("./benchmark-gate-output-support.ts").Context = {
      cwd: root,
      env: environment(root),
      key: Buffer.alloc(32),
      checker: () => {
        throw Error("not needed");
      },
      a: {
        createHttpRoutes: (factory: {
          store: {
            listEvents: (id: string, options: { after: number; limit: number }) => unknown[];
            subscribe: () => () => void;
          };
        }) => ({
          "/api/runs/:id/stream": (req: Request) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  const events = factory.store.listEvents("synthetic", { after: 0, limit: 50000 });
                  const bytes = Buffer.from(
                    ": connected\n\n" +
                      events.map((event) => `data: ${JSON.stringify({ kind: "event", event })}\n\n`).join(""),
                  );
                  // Split the connected frame's delimiter and bundle all event frames in the last chunk.
                  for (const chunk of [bytes.subarray(0, 12), bytes.subarray(12, 13), bytes.subarray(13)])
                    controller.enqueue(chunk);
                  const unsubscribe = factory.store.subscribe();
                  req.signal.addEventListener(
                    "abort",
                    () => {
                      unsubscribe();
                      controller.close();
                    },
                    { once: true },
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        }),
      },
    };
    const job = (await registry["event-drain"]?.(c))?.[0];
    expect(job?.[2]).toBeFunction();
    const parse = spyOn(JSON, "parse");
    try {
      const value = await job?.[2]?.();
      expect(parse).not.toHaveBeenCalled();
      expect(job?.[3](value)).toBe("50000 ordered events; 5000 gate events; stream closed");
      expect(parse).toHaveBeenCalledTimes(50000);
      expect(() => job?.[3]({ ...Object(value), unsubscribed: 0 })).toThrow("stream closed");
      const bad = Buffer.from('data: {"kind":"event","event":{"id":2}}\n\n');
      expect(() => job?.[3]({ ...Object(value), chunks: [bad] })).toThrow("SSE order");
      expect(() => job?.[3]({ ...Object(value), chunks: [bad.subarray(0, -1)] })).toThrow(
        "complete SSE frames",
      );
    } finally {
      parse.mockRestore();
    }
  });
});

test("preparation owns no measured turns, runs seven times and disposes on preparation failure", async () => {
  await temporary(async (root) => {
    await fakeRevision(root);
    await fs.writeFile(
      join(root, "src/util/privacy-checker.ts"),
      "let disposed=0; export const count=()=>disposed; export const createPrivacyChecker=({registry,schedule})=>({registry,touch:()=>new Promise(done=>schedule(done)),async dispose(){disposed++}});",
    );
    let prepared = 0,
      measured = 0,
      clock = 0;
    const runtime = {
      now: () => clock,
      pause: wait,
      gc: () => {},
      memory: () => ({ heap: 0, peakRSS: 0 }),
      platform: [],
    };
    const result = await measureWorker(root, runtime, {
      prepared: {
        dimensions: {},
        prepare: async (checker) => {
          await (checker as unknown as { touch: () => Promise<void> }).touch();
          clock += 100;
          prepared++;
          expect(measured).toBe(prepared - 1);
        },
        run: () => {
          clock += 3;
          return ++measured;
        },
        check: (v) => ({ outcome: validate(v === measured) }),
      },
    });
    expect(prepared).toBe(7);
    expect(measured).toBe(7);
    expect((result.groups.prepared as Group).raw.map((t) => t.slice)).toEqual([3, 3, 3, 3, 3, 3, 3]);
    await expect(
      measureWorker(root, undefined, {
        failure: {
          dimensions: {},
          prepare: () => {
            throw Error("fixture failure");
          },
          run: () => {
            throw Error("must not run");
          },
          check: () => ({}),
        },
      }),
    ).rejects.toThrow("fixture failure");
    const { count } = await import(join(root, "src/util/privacy-checker.ts"));
    expect(count()).toBe(8);
  });
});
