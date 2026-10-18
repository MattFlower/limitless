import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { buildClaudeArgs, runClaude } from "../src/harness/claude.ts";
import { editorProfile } from "../src/harness/codex.ts";
import { seatbeltForPort } from "../src/harness/sandbox.ts";
import {
  commandDir,
  createCommandRoot,
  createScratch,
  removeScratch,
  writeRoots,
} from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { agentEnv, redactCredentials, runProcess } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";
import { test } from "./read-policy-support.ts";

// No model calls: launch commands directly through each harness's production sandbox policy.
for (const sandbox of ["codex-editor", "claude-reader", "claude-editor"] as const) {
  test.skipIf(seatbeltSkip !== null)(
    `${sandbox} lease transport probe (${seatbeltSkip ?? "available"})`,
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "lease-probe-")));
      const cwd = join(root, "checkout");
      mkdirSync(cwd);
      const scratch = createScratch(cwd);
      const http = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => Response.json({ id: "probe", acquired: true }),
      });
      const socket = join(scratch, "lease.sock");
      const unix = Bun.serve({ unix: socket, fetch: () => Response.json({ id: "probe", acquired: true }) });
      const spec: AgentSpec = {
        cwd,
        scratchDir: scratch,
        mode: sandbox === "claude-reader" ? "readonly" : "edit",
        prompt: "",
        timeoutMs: 10000,
        idleTimeoutMs: 10000,
        maxToolCalls: 1,
        signal: new AbortController().signal,
        onEvent: () => {},
        logPath: join(scratch, "log"),
        target: {
          modelId: "probe",
          provider: "fake",
          harness: "fake",
          model: "probe",
          vendor: "fake",
          tier: 1,
          billing: "subscription",
        },
      };
      // A capability of this invocation and of another one, in the shared factory-owned root.
      const own = commandDir(scratch, cwd),
        other = join(createCommandRoot(cwd, scratch), `probe-other-${crypto.randomUUID()}`);
      for (const dir of [own, other]) {
        mkdirSync(dir, { mode: 0o700 });
        writeFileSync(join(dir, "config.json"), "{}", { mode: 0o400 });
      }
      const capabilities = JSON.stringify([join(own, "config.json"), join(other, "config.json")]);
      const code = `const results=[];for(const unix of [undefined,${JSON.stringify(socket)}]){try{const r=await fetch(unix?'http://localhost/api/admin/gate-slot':'http://127.0.0.1:${http.port}/api/admin/gate-slot',{unix,method:'POST',headers:{'content-type':'application/json'},body:'{"name":"probe"}',signal:AbortSignal.timeout(2000)});results.push(r.ok&&(await r.json()).acquired===true)}catch{results.push(false)}}for(const f of ${capabilities}){try{require('fs').readFileSync(f);results.push(true)}catch{results.push(false)}}console.log(JSON.stringify(results))`;
      const command = [process.execPath, "--eval", code];
      try {
        let cmd: string[],
          extra: Record<string, string> = {};
        if (sandbox === "codex-editor") {
          const codex = Bun.which("codex");
          if (!codex) throw new Error("Codex CLI required for the editor transport probe");
          const home = join(root, "codex-home");
          mkdirSync(home);
          extra = { CODEX_HOME: home };
          cmd = [codex, "sandbox", ...editorProfile(spec), "--", ...command];
          // As in production: Claude editors' outer profile denies the daemon's own port (#484).
        } else if (sandbox === "claude-editor")
          cmd = seatbeltForPort(Number(http.port)).wrap(command, writeRoots(cwd, scratch));
        else {
          const args = buildClaudeArgs(spec, "probe");
          const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");
          const config: SandboxRuntimeConfig = {
            filesystem: settings.sandbox.filesystem,
            network: { allowedDomains: [], deniedDomains: [] },
          };
          await SandboxManager.initialize(config, undefined, false);
          const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
          const wrapped = await SandboxManager.wrapWithSandboxArgv(
            command.map(quote).join(" "),
            "/bin/bash",
            undefined,
            spec.signal,
            cwd,
          );
          cmd = wrapped.argv;
          extra = Object.fromEntries(
            Object.entries(wrapped.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          );
        }
        const result = await runProcess({
          cmd,
          cwd,
          env: agentEnv({ ...extra, TMPDIR: scratch }),
          timeoutMs: 10000,
        });
        expect(result.exitCode).toBe(0);
        const observed: unknown = JSON.parse(result.stdout.trim());
        console.info(
          `${sandbox}: HTTP, Unix, own capability, other capability = ${JSON.stringify(observed)}`,
        );
        // Claude editors reach the lease service only through their invocation socket; Codex editors keep
        // loopback HTTP, where the capability is their credential.
        const transports =
          sandbox === "claude-reader"
            ? [false, false]
            : sandbox === "claude-editor"
              ? [false, true]
              : [true, true];
        expect(observed).toEqual([...transports, true, false]);
      } finally {
        if (sandbox === "claude-reader") await SandboxManager.reset();
        http.stop(true);
        unix.stop(true);
        rmSync(own, { recursive: true, force: true });
        rmSync(other, { recursive: true, force: true });
        removeScratch(scratch);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(seatbeltSkip !== null)(
  `Claude verifier Bun test with production settings and environment (${seatbeltSkip ?? "available"})`,
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "verifier-bun-")));
    const cwd = join(root, "checkout");
    mkdirSync(cwd);
    const scratch = createScratch(cwd);
    const file = join(scratch, "probe.test.ts");
    writeFileSync(file, 'import {test, expect} from "bun:test"; test("probe", () => expect(1).toBe(1));');
    const spec: AgentSpec = {
      cwd,
      scratchDir: scratch,
      mode: "readonly",
      confineReads: true,
      prompt: "",
      timeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      maxToolCalls: 1,
      signal: new AbortController().signal,
      onEvent: () => {},
      logPath: join(root, "stream.log"),
      target: {
        modelId: "probe",
        provider: "fake",
        harness: "fake",
        model: "probe",
        vendor: "fake",
        tier: 1,
        billing: "subscription",
      },
    };
    const previous = process.env.CLAUDE_CODE_TMPDIR;
    try {
      // Change only Bun's allowance between runs; keep wrappers, checkout denyWrite and CLI temp settings.
      for (const corrected of [false, true]) {
        await runClaude(spec, async (opts) => {
          const settings = JSON.parse(opts.cmd[opts.cmd.indexOf("--settings") + 1] ?? "{}");
          const filesystem: SandboxRuntimeConfig["filesystem"] = settings.sandbox.filesystem;
          if (!corrected)
            filesystem.allowRead = filesystem.allowRead?.filter((p) => p === cwd || p === scratch);
          process.env.CLAUDE_CODE_TMPDIR = opts.env.CLAUDE_CODE_TMPDIR;
          try {
            await SandboxManager.initialize(
              { filesystem, network: { allowedDomains: [], deniedDomains: [] } },
              undefined,
              false,
            );
            const quote = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
            const wrapped = await SandboxManager.wrapWithSandboxArgv(
              [process.execPath, "test", file].map(quote).join(" "),
              "/bin/bash",
              undefined,
              spec.signal,
              cwd,
            );
            const result = await runProcess({
              cmd: wrapped.argv,
              cwd,
              env: {
                ...opts.env,
                ...Object.fromEntries(
                  Object.entries(wrapped.env).filter(
                    (entry): entry is [string, string] => entry[1] !== undefined,
                  ),
                ),
              },
              signal: spec.signal,
              timeoutMs: 10_000,
            });
            console.info(
              redactCredentials(
                `Claude verifier Bun: ${JSON.stringify({
                  corrected,
                  timedOut: result.timedOut,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                })}`,
              ),
            );
            expect(result.cancelled).toBe(false);
            if (corrected) {
              expect(result.timedOut).toBe(false);
              expect(result.exitCode).toBe(0);
              expect(result.stdout + result.stderr).toContain("1 pass");
            } else {
              // An immediate denial is not the reported hang and cannot establish this diagnosis.
              expect(result.timedOut).toBe(true);
            }
            return result;
          } finally {
            await SandboxManager.reset();
          }
        });
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = previous;
      removeScratch(scratch);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
