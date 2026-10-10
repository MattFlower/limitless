import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { buildClaudeArgs } from "../src/harness/claude.ts";
import { editorProfile } from "../src/harness/codex.ts";
import { seatbeltBackend } from "../src/harness/sandbox.ts";
import { createScratch, removeScratch, writeRoots } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { agentEnv, runProcess } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";

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
      const code = `const results=[];for(const unix of [undefined,${JSON.stringify(socket)}]){try{const r=await fetch(unix?'http://localhost/api/admin/gate-slot':'http://127.0.0.1:${http.port}/api/admin/gate-slot',{unix,method:'POST',headers:{'content-type':'application/json'},body:'{"name":"probe"}',signal:AbortSignal.timeout(2000)});results.push(r.ok&&(await r.json()).acquired===true)}catch{results.push(false)}}console.log(JSON.stringify(results))`;
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
        } else if (sandbox === "claude-editor") cmd = seatbeltBackend.wrap(command, writeRoots(cwd, scratch));
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
        console.info(`${sandbox}: HTTP, Unix = ${JSON.stringify(observed)}`);
        expect(observed).toEqual(sandbox === "claude-reader" ? [false, false] : [true, true]);
      } finally {
        if (sandbox === "claude-reader") await SandboxManager.reset();
        http.stop(true);
        unix.stop(true);
        removeScratch(scratch);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
