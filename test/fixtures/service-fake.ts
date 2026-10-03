import { mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const scenario = JSON.parse(process.argv[2] ?? "{}") as {
  action?: "install" | "status" | "uninstall" | "handoff";
  labels?: string[];
  plists?: string[];
  mtplx?: boolean;
  tunnel?: boolean;
  failure?:
    | "bootstrap"
    | "health"
    | "old-health"
    | "handoff"
    | "not-running"
    | "port-owner"
    | "bootout"
    | "final-bootstrap";
  failLabel?: string;
  delayed?: boolean;
  missingPlist?: boolean;
  port?: number;
  envPort?: string;
};
const daemon = "dev.limitless.daemon";
const legacy = "cc.mattflower.limitless";
const home = "/fake/home";
const agents = `${home}/Library/LaunchAgents`;
const port = scenario.port ?? 7400;
delete process.env.LIMITLESS_PORT;
if (scenario.envPort) process.env.LIMITLESS_PORT = scenario.envPort;
const calls: string[] = [];
const files = new Map<string, string>([[`${home}/.limitless/app/.git`, ""]]);
const loaded = new Map((scenario.labels ?? []).map((label, i) => [label, i + 10]));
for (const label of [...loaded.keys(), ...(scenario.plists ?? [])])
  files.set(`${agents}/${label}.plist`, `legacy ${label}`);
if (scenario.missingPlist) for (const label of loaded.keys()) files.delete(`${agents}/${label}.plist`);
let pid = 100;
let probeHealth: Promise<unknown> | undefined;
let time = 0;
let healthCalls = 0;
let pending = 0;
const logs: string[] = [];
console.log = (...args: unknown[]) => logs.push(args.join(" "));
Date.now = () => time;
Bun.sleep = (async (ms: number) => {
  time += ms;
}) as typeof Bun.sleep;
spyOn(os, "homedir").mockReturnValue(home);
spyOn(os, "userInfo").mockReturnValue({ uid: 501, gid: 501, username: "fake", homedir: home, shell: null });
const fakeFs = {
  existsSync: (path: string) => (scenario.tunnel && path.endsWith(".cloudflared")) || files.has(path),
  mkdirSync: () => {},
  writeFileSync: (path: string, content: string) => {
    calls.push(`write ${path}`);
    files.set(path, content);
  },
  unlinkSync: (path: string) => {
    calls.push(`unlink ${path}`);
    files.delete(path);
  },
  readFileSync: (path: string) => files.get(path),
  readdirSync: () => ["12345678-1234-1234-1234-123456789012.json"],
};
for (const [name, fn] of Object.entries(fakeFs))
  spyOn(fs, name as keyof typeof fs).mockImplementation(fn as never);
mock.module("../../src/util/proc.ts", () => ({
  sh: async (args: string[], options: { allowFail?: boolean }) => {
    calls.push(args.join(" "));
    let exitCode = 0;
    let stdout = "";
    if (args[0] === "/usr/sbin/lsof" && scenario.failure === "port-owner") exitCode = 1;
    const target = args.at(-1) ?? "";
    const label = target.slice(target.lastIndexOf("/") + 1).replace(/\.plist$/, "");
    if (args[0] === "launchctl") {
      if (args[1] === "print") {
        if (
          scenario.action === "handoff" &&
          label === legacy &&
          calls.filter((c) => c.endsWith(legacy)).length > 3
        )
          loaded.delete(legacy);
        exitCode = loaded.has(label) ? 0 : 1;
        stdout =
          loaded.has(label) && pending-- <= 0
            ? `state = running\n pid = ${loaded.get(label)}\n`
            : "state = waiting";
      } else if (args[1] === "bootstrap") {
        if (
          (scenario.failure === "bootstrap" ||
            (scenario.failure === "final-bootstrap" && !loaded.has("cc.mattflower.limitless-mtplx"))) &&
          label === (scenario.failLabel ?? daemon)
        )
          exitCode = 5;
        else {
          loaded.set(label, ++pid);
          pending = scenario.delayed ? 2 : 0;
        }
      } else if (args[1] === "bootout") {
        if (scenario.failure === "bootout" && label === (scenario.failLabel ?? legacy)) exitCode = 5;
        else loaded.delete(label);
      }
    }
    if (exitCode && !options.allowFail) throw new Error(`fake failure ${args.join(" ")}`);
    return { exitCode, stdout, stderr: "" };
  },
}));
globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
  const parsed = new URL(String(url));
  calls.push(`health ${parsed.port}${parsed.pathname}`);
  healthCalls++;
  if (parsed.pathname === "/v1/models") {
    const authorization = new Headers(options?.headers).get("authorization");
    calls.push(`authorization ${authorization}`);
    if (authorization !== "Bearer mtplx-local") return new Response(null, { status: 401 });
  }
  const label =
    parsed.pathname === "/v1/models"
      ? "dev.limitless.mtplx"
      : parsed.pathname === "/ready"
        ? "dev.limitless.tunnel"
        : daemon;
  const failed =
    label === (scenario.failLabel ?? daemon) &&
    (scenario.failure === "health" ||
      scenario.failure === "not-running" ||
      (scenario.failure === "handoff" && parsed.port === String(port) && !loaded.has(legacy)));
  const responsePid = scenario.failure === "old-health" ? loaded.get(legacy) : loaded.get(label);
  return Response.json({ ok: true, pid: responsePid }, { status: failed || !loaded.has(label) ? 503 : 200 });
}) as typeof fetch;
const { install, status, uninstall, awaitServiceHandoff } = await import("../../src/cli/service.ts");
let error: string | undefined;
try {
  if (scenario.action === "status") await status(port);
  else if (scenario.action === "uninstall") await uninstall();
  else if (scenario.action === "handoff") {
    process.env.LIMITLESS_MIGRATE_FROM = legacy;
    process.env.LIMITLESS_STAGING_PORT = String(port + 1);
    Bun.serve = ((opts: { port: number; fetch: () => Response }) => {
      calls.push(`probe ${opts.port}`);
      probeHealth = opts.fetch().json();
      return { stop: async () => calls.push("probe stop") };
    }) as unknown as typeof Bun.serve;
    await awaitServiceHandoff();
  } else await install(port, { mtplx: scenario.mtplx, tunnel: scenario.tunnel });
} catch (caught) {
  error = String(caught);
}
process.stdout.write(
  JSON.stringify({
    calls,
    files: Object.fromEntries(files),
    loaded: [...loaded.keys()],
    logs,
    error,
    healthCalls,
    probeHealth: await probeHealth,
  }),
);
