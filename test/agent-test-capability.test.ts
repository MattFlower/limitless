import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { WrapperConfig } from "../src/cli/agent-test.ts";
import { agentTestLease } from "../src/gates/agent-tests.ts";
import { buildClaudeArgs } from "../src/harness/claude.ts";
import { buildCodexArgs } from "../src/harness/codex.ts";
import { SANDBOX_EXEC, seatbeltProfile } from "../src/harness/sandbox.ts";
import { commandRoots, createScratch, removeScratch, writeRoots } from "../src/harness/scratch.ts";
import { withSlottedCommands } from "../src/harness/slotted.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { agentEnv, runProcess } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function invocation(root: string, name: string) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  const scratch = createScratch(cwd);
  cleanup.push(() => removeScratch(scratch));
  const spec: AgentSpec = {
    cwd,
    scratchDir: scratch,
    mode: "edit",
    prompt: "",
    timeoutMs: 10000,
    idleTimeoutMs: 10000,
    maxToolCalls: 1,
    signal: new AbortController().signal,
    onEvent: () => {},
    logPath: join(root, `${name}.log`),
    target: {
      modelId: "probe",
      provider: "claude",
      harness: "fake",
      model: "probe",
      vendor: "fake",
      tier: 1,
      billing: "subscription",
    },
  };
  return { cwd, scratch, spec };
}

/** Two concurrent invocations, each holding its own wrapper directory and capability. */
async function withTwoInvocations(
  check: (
    a: ReturnType<typeof invocation> & { dir: string },
    b: { dir: string; config: string },
  ) => Promise<void>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-capability-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const a = invocation(root, "a"),
    b = invocation(root, "b");
  const dir = (path?: string) => path?.split(delimiter)[0] ?? "";
  await withSlottedCommands(
    [["bun", "test"]],
    a.scratch,
    1,
    () => {},
    (pathA) =>
      withSlottedCommands(
        [["bun", "test"]],
        b.scratch,
        1,
        () => {},
        (pathB) =>
          check({ ...a, dir: dir(pathA) }, { dir: dir(pathB), config: join(dir(pathB), "config.json") }),
      ),
  );
}

test("every profile denies the shared capability root and grants only the invocation's own directory", async () => {
  await withTwoInvocations(async (a, b) => {
    expect(dirname(a.dir)).toBe(dirname(b.dir));
    expect(commandRoots()).toContain(dirname(a.dir));
    const [root = ""] = commandRoots().filter((r) => r === dirname(a.dir));

    // Claude editors' outer Seatbelt profile (and gates, which share writeRoots).
    const profile = seatbeltProfile(writeRoots(a.cwd, a.scratch));
    expect(profile).toContain(`(deny file-read-data (subpath "${root}")`);
    expect(profile).toMatch(new RegExp(`\\(allow file-read-data[^\\n]*\\(subpath "${a.dir}"\\)`));
    expect(profile).not.toContain(b.dir);

    // Codex editor and unconfined reader profiles: the most specific entry wins.
    for (const mode of ["edit", "readonly"] as const) {
      const args = buildCodexArgs({ ...a.spec, mode }).join(" ");
      expect(args).toContain(`"${root}"="none"`);
      expect(args).toContain(`"${a.dir}"="read"`);
      expect(args).not.toContain(b.dir);
    }

    // Claude: native Read tools never see the root; the reader sandbox allows only its own directory.
    const settings = (mode: AgentSpec["mode"]) => {
      const args = buildClaudeArgs({ ...a.spec, mode }, "s");
      return { args, sandbox: JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}").sandbox };
    };
    const editor = settings("edit");
    expect(editor.args).toContain(`Read(/${root}/**)`);
    const reader = settings("readonly");
    expect(reader.args).toContain(`Read(/${root}/**)`);
    expect(reader.sandbox.filesystem.denyRead).toContain(root);
    expect(reader.sandbox.filesystem.allowRead).toEqual(commandRoots().map((r) => join(r, basename(a.dir))));
    const confined = buildClaudeArgs({ ...a.spec, mode: "readonly", confineReads: true }, "s");
    expect(
      JSON.parse(confined[confined.indexOf("--settings") + 1] ?? "{}").sandbox.filesystem.allowRead,
    ).not.toContain(a.dir);
  });
});

test("a capability presented to another invocation's socket is refused, and dies with its invocation", async () => {
  let stolen: WrapperConfig | undefined;
  await withTwoInvocations(async (a, b) => {
    stolen = JSON.parse(readFileSync(b.config, "utf8"));
    const own: WrapperConfig = JSON.parse(readFileSync(join(a.dir, "config.json"), "utf8"));
    const request = (unix: string, token: string) =>
      fetch("http://localhost/api/admin/gate-slot", {
        unix,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name: "bun test", lane: "small" }),
      });
    // The token never travels through the environment that `ps -E` exposes.
    expect(own.nested).not.toBe(own.token);
    expect((await request(own.unix, stolen?.token ?? "")).status).toBe(403);
    const lease = await (await request(own.unix, own.token)).json();
    expect(lease.acquired).toBe(true);
    await agentTestLease({ token: own.token, id: lease.id, release: true });
  });
  await expect(agentTestLease({ token: stolen?.token, name: "bun test", lane: "small" })).rejects.toThrow(
    "capability",
  );
});

test.skipIf(seatbeltSkip !== null)(
  `a confined invocation reads its own capability but cannot discover or read another's (${seatbeltSkip ?? "available"})`,
  async () => {
    await withTwoInvocations(async (a, b) => {
      const read = (script: string, ...args: string[]) =>
        runProcess({
          cmd: [
            SANDBOX_EXEC,
            "-p",
            seatbeltProfile(writeRoots(a.cwd, a.scratch)),
            "/bin/sh",
            "-c",
            script,
            "sh",
            ...args,
          ],
          cwd: a.cwd,
          env: agentEnv(),
          timeoutMs: 10000,
        });
      expect((await read('cat "$1"', join(a.dir, "config.json"))).exitCode).toBe(0);
      const other = await read('cat "$1"', b.config);
      expect(other.exitCode).not.toBe(0);
      expect(other.stdout).toBe("");
      const listing = await read('ls "$1"', dirname(b.dir));
      expect(listing.exitCode).not.toBe(0);
      expect(readdirSync(dirname(b.dir))).toContain(basename(b.dir));
    });
  },
);
