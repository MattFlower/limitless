import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeReadPolicy, readPolicyScope } from "../src/harness/read-policy.ts";
import { SANDBOX_EXEC, seatbeltProfile } from "../src/harness/sandbox.ts";
import { writeRoots } from "../src/harness/scratch.ts";
import { protectPrivateFile } from "../src/util/private-reads.ts";
import { agentEnv, runProcess } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";

// The intermediary exits; the platform binary has a SIP-hidden environment and is reparented to 1.
function orphanLauncher(cwd: string, pidFile: string): string {
  return `require("node:child_process").spawn("/bin/sh",
    ["-c", 'echo $$ > "$1"; exec /bin/sleep 30', "sh", ${JSON.stringify(pidFile)}],
    {cwd:${JSON.stringify(cwd)}, detached:true, stdio:"ignore", env:{}}).unref();`;
}

async function startOrphan(cwd: string, pidFile: string): Promise<number> {
  const child = spawn(process.execPath, ["-e", orphanLauncher(cwd, pidFile)], { stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Launcher: ${code}`))));
    });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (pid > 1) return pid;
      } catch {}
      await Bun.sleep(10);
    }
    throw new Error("Orphan did not publish its pid");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

const nativeModule = JSON.stringify(join(import.meta.dir, "../src/util/processes-darwin.ts"));

test.skipIf(seatbeltSkip !== null)(
  `cleanup refuses an orphan inside a read-denied checkout subtree (${seatbeltSkip ?? "available"})`,
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "limitless-cwd-private-")));
    const work = join(dir, "checkout");
    const scratch = join(dir, "scratch");
    for (const path of [work, scratch]) mkdirSync(path);
    const privateFile = join(work, "private.db");
    const pidFile = join(work, "descendant.pid");
    writeFileSync(privateFile, "registered private database");
    const release = protectPrivateFile(privateFile);
    try {
      // Native syscalls can replace a writable, read-denied file and enter the resulting directory.
      // The pipe closes on exec; the launcher waits until the SIP platform binary is orphaned.
      const source = join(work, "orphan.c");
      const binary = join(work, "orphan");
      writeFileSync(
        source,
        `#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  if (unlink(argv[1]) || mkdir(argv[1], 0700) || chdir(argv[1])) return 3;
  int ready[2];
  if (pipe(ready) || fcntl(ready[1], F_SETFD, FD_CLOEXEC) == -1) return 4;
  pid_t child = fork();
  if (child < 0) return 5;
  if (child == 0) {
    close(ready[0]);
    if (setsid() == -1) _exit(6);
    pid_t orphan = fork();
    if (orphan < 0) _exit(7);
    if (orphan > 0) _exit(0);
    int attempts = 0;
    while (getppid() != 1 && ++attempts < 3000) usleep(1000);
    if (getppid() != 1) _exit(8);
    FILE *file = fopen(argv[2], "w");
    if (!file) _exit(9);
    fprintf(file, "%d", getpid());
    fclose(file);
    int nullfd = open("/dev/null", O_RDWR);
    if (nullfd == -1) _exit(10);
    for (int fd = 0; fd < 3; fd++) if (dup2(nullfd, fd) == -1) _exit(10);
    close(nullfd);
    execl("/bin/sleep", "sleep", "30", NULL);
    write(ready[1], "x", 1);
    _exit(10);
  }
  close(ready[1]);
  int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) return 11;
  char failed;
  return read(ready[0], &failed, 1) == 0 ? 0 : 12;
}
`,
      );
      const build = await runProcess({
        cmd: ["/usr/bin/cc", source, "-o", binary],
        cwd: work,
        env: agentEnv(),
        timeoutMs: 10_000,
      });
      expect(build.exitCode, build.stderr).toBe(0);
      const profile = readPolicyScope.run({ home: dir, environment: {} }, () =>
        seatbeltProfile(writeRoots(work, scratch, true)),
      );
      const script = `
        import {runProcess} from ${JSON.stringify(join(import.meta.dir, "../src/util/proc.ts"))};
        try {
          const result = await runProcess({cmd:${JSON.stringify([binary, privateFile, pidFile])},
            cwd:process.cwd(),env:{...process.env},timeoutMs:5000});
          console.log(JSON.stringify({result:result.exitCode}));
        } catch (error) { console.log(JSON.stringify({error:error.message})); }
      `;
      const result = await runProcess({
        cmd: [SANDBOX_EXEC, "-p", profile, process.execPath, "-e", script],
        cwd: work,
        env: agentEnv(),
        timeoutMs: 10_000,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      expect(JSON.parse(result.stdout)).toEqual({
        error: `Invocation termination could not be confirmed: Process cwd inspection failed for ${pid} (errno 1)`,
      });
    } finally {
      // The PID file is written by our own double-forked fixture, never obtained by a host scan.
      try {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (pid > 1) process.kill(pid, "SIGKILL");
      } catch {}
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(seatbeltSkip !== null)(
  `injected cwd permission errors stay closed outside the gate read allowlist (${seatbeltSkip ?? "available"})`,
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "limitless-cwd-errors-")));
    try {
      const home = join(dir, "home");
      mkdirSync(home);
      const work = join(home, "checkout");
      mkdirSync(work);
      const profile = readPolicyScope.run({ home, environment: {} }, () =>
        seatbeltProfile({ write: [work], protect: [], ...homeReadPolicy([work], true) }),
      );
      const script = `
        import {hiddenDarwinProcessMember} from ${nativeModule};
        console.log(JSON.stringify([1,13,3,5,22].map(errno => {
          try { return hiddenDarwinProcessMember(42,new Map([[42,1]]),new Set(),100,
            [process.cwd()],()=>101,()=>({errno})); }
          catch { return "throws"; }
        })));
      `;
      for (const [policy, expected] of [
        [null, ["throws", "throws", false, "throws", "throws"]],
        ["(version 1)(allow default)", ["throws", "throws", false, "throws", "throws"]],
        ["(version 1)(allow default)(deny mach-lookup)", ["throws", "throws", false, "throws", "throws"]],
        [seatbeltProfile({ write: [dir], protect: [] }), ["throws", "throws", false, "throws", "throws"]],
        [profile, [false, false, false, "throws", "throws"]],
      ] as const) {
        const cmd = [process.execPath, "-e", script];
        const result = await runProcess({
          cmd: policy ? [SANDBOX_EXEC, "-p", policy, ...cmd] : cmd,
          cwd: work,
          // A caller-set marker must not relax the unconfined path.
          env: { ...agentEnv(), LIMITLESS_CONFINED: policy ? "0" : "1" },
        });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(expected);
      }
      const deniedRoot = await runProcess({
        cmd: [
          SANDBOX_EXEC,
          "-p",
          profile,
          process.execPath,
          "-e",
          script.replace("[process.cwd()]", JSON.stringify([home])),
        ],
        cwd: work,
        env: agentEnv(),
      });
      expect(deniedRoot.exitCode, deniedRoot.stderr).toBe(0);
      expect(JSON.parse(deniedRoot.stdout)).toEqual(["throws", "throws", false, "throws", "throws"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(seatbeltSkip !== null)(
  `gate cwd inspection ignores a denied-home orphan and detects its detached descendant (${seatbeltSkip ?? "available"})`,
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "limitless-cwd-profile-")));
    const home = join(dir, "home");
    const work = join(home, "checkout");
    const scratch = join(home, "scratch");
    const denied = join(home, "Library/Containers/example/Data");
    for (const path of [work, scratch, denied]) mkdirSync(path, { recursive: true });
    const owned: number[] = [];
    const descendantFile = join(work, "descendant.pid");
    try {
      const started = Date.now();
      owned.push(await startOrphan(denied, join(work, "denied.pid")));
      owned.push(await startOrphan(scratch, join(work, "allowed.pid")));
      const profile = readPolicyScope.run({ home, environment: {} }, () =>
        seatbeltProfile({ write: [work, scratch], protect: [], ...homeReadPolicy([work, scratch], true) }),
      );
      const script = `
        import {strict as assert} from "node:assert";
        import {spawn} from "node:child_process";
        import {readFileSync} from "node:fs";
        import {dlopen,FFIType,ptr,toArrayBuffer} from "bun:ffi";
        import {hiddenDarwinProcessMember,markedDarwinProcesses} from ${nativeModule};
        const {symbols:s}=dlopen("/usr/lib/libSystem.B.dylib",{
          __error:{args:[],returns:FFIType.ptr},
          proc_pidinfo:{args:[FFIType.i32,FFIType.i32,FFIType.u64,FFIType.ptr,FFIType.i32],returns:FFIType.i32},
        });
        const error=()=>{const p=s.__error();return p===null?0:new Int32Array(toArrayBuffer(p,0,4))[0];};
        const child=spawn(${JSON.stringify(process.execPath)},["-e",${JSON.stringify(orphanLauncher(work, descendantFile))}],{stdio:"ignore"});
        await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(new Error("launcher")));});
        let descendant=0;
        const deadline=Date.now()+3000;
        while(!descendant && Date.now()<deadline){
          try{descendant=Number(readFileSync(${JSON.stringify(descendantFile)},"utf8").trim());}catch{}
          if(!descendant)await Bun.sleep(10);
        }
        assert.ok(descendant>1);
        const pids=[${owned.join(",")},descendant];
        const observations=pids.map(pid=>{
          const info=new Uint32Array(16),bsd=new Uint8Array(136),vnode=new Uint8Array(2352);
          assert.equal(s.proc_pidinfo(pid,13,0,ptr(info),info.byteLength),info.byteLength);
          assert.equal(info[1],1,"fixture must be orphaned");
          assert.equal(s.proc_pidinfo(pid,3,0,ptr(bsd),bsd.byteLength),bsd.byteLength);
          const view=new DataView(bsd.buffer);
          const born=Number(view.getBigUint64(120,true))*1000+Number(view.getBigUint64(128,true))/1000;
          const n=s.proc_pidinfo(pid,9,0,ptr(vnode),vnode.byteLength);
          const path=Buffer.from(vnode.buffer,152,1024);
          const cwd=n===vnode.byteLength?{path:path.toString("utf8",0,path.indexOf(0))}:{errno:error()};
          return {pid,born,cwd};
        });
        console.log(JSON.stringify(observations.map(({cwd})=>cwd)));
        // Stop before interpreting errors if our own detached descendant is unreadable.
        assert.ok("path" in observations[2].cwd,"gate descendant cwd must be readable");
        assert.ok([1,13].includes(observations[0].cwd.errno));
        assert.equal(observations[1].cwd.path,${JSON.stringify(scratch)});
        assert.equal(observations[2].cwd.path,${JSON.stringify(work)});
        const members=observations.map(({pid,born,cwd})=>hiddenDarwinProcessMember(
          pid,new Map([[pid,1]]),new Set(),${started},[${JSON.stringify(work)}],()=>born,()=>cwd));
        assert.deepEqual(members,[false,false,true]);
        const detected=markedDarwinProcesses(process.getuid(),"cwd-probe",process.pid,${started},[${JSON.stringify(work)}]);
        assert.ok(!detected.includes(pids[0]));
        assert.ok(!detected.includes(pids[1]));
        assert.ok(detected.includes(descendant));
      `;
      const result = await runProcess({
        cmd: [SANDBOX_EXEC, "-p", profile, process.execPath, "-e", script],
        cwd: work,
        env: agentEnv(),
        timeoutMs: 10_000,
      });
      console.log(`Gate cwd reads (denied home, allowed scratch, own descendant): ${result.stdout.trim()}`);
      expect(result.exitCode, result.stderr).toBe(0);
    } finally {
      // Only PIDs published by these launchers are eligible for cleanup; never scan for targets.
      try {
        const pid = Number(readFileSync(descendantFile, "utf8").trim());
        if (pid > 1) owned.push(pid);
      } catch {}
      for (const pid of owned) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
