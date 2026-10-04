import { mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { DeployClient, DeployClock } from "../src/cli/deploy-wait.ts";
import { DrainUnsupportedError } from "../src/cli/deploy-wait.ts";
import type { sh } from "../src/util/proc.ts";

const home = process.env.SERVICE_TEST_HOME;
if (!home) throw new Error("missing isolated test home");
const nativeOs = { ...os };
mock.module("node:os", () => ({ ...nativeOs, homedir: () => home }));
const scenario = process.argv[2] ?? "migration";
const kind = process.argv[3] ?? "daemon";
const agents = join(home, "Library", "LaunchAgents");
const realApp = join(home, "app & release");
const alias = join(home, "alias");
mkdirSync(join(realApp, "src", "cli"), { recursive: true });
writeFileSync(join(realApp, "src", "cli", "main.ts"), "");
if (!existsSync(alias)) symlinkSync(realApp, alias);
const app = scenario.includes("symlink") && !scenario.includes("reverse") ? alias : realApp;
const otherApp = join(home, "other-install");
mkdirSync(join(otherApp, "src", "cli"), { recursive: true });
writeFileSync(join(otherApp, "src", "cli", "main.ts"), "");
const plistApp = scenario === "other-install" ? otherApp : scenario.includes("reverse") ? alias : realApp;
let signalTimer: ReturnType<typeof setTimeout> | undefined;
process.env.LIMITLESS_APP_DIR = app;
mkdirSync(agents, { recursive: true });
mkdirSync(join(app, ".git"), { recursive: true });
mkdirSync(join(home, ".cloudflared"), { recursive: true });
mkdirSync(join(home, ".mtplx", "bin"), { recursive: true });
writeFileSync(join(home, ".mtplx", "bin", "mtplx"), "");
writeFileSync(join(home, ".cloudflared", "limitless.yml"), "");
writeFileSync(join(home, ".cloudflared", "12345678-1234-1234-1234-123456789abc.json"), "{}");
const calls: string[] = [];
const loaded = new Set<string>();
const oldLabel = scenario.startsWith("marked") ? `dev.limitless.${kind}` : `arbitrary.installed.${kind}`;
const oldPath = join(agents, "original.plist");
const neutral = `dev.limitless.${kind}`;
const xmlEscape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const decode = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&amp;", "&");
function parse(content: string) {
  const value = (key: string) => {
    const matched = content.match(new RegExp(`<key>${key}</key>\\s*<string>(.*?)</string>`, "s"));
    return matched?.[1] === undefined ? undefined : decode(matched[1]);
  };
  return {
    Label: value("Label"),
    LimitlessService: value("LimitlessService"),
    WorkingDirectory: value("WorkingDirectory"),
    ProgramArguments: [
      ...(content.match(/<array>(.*?)<\/array>/s)?.[1] ?? "").matchAll(/<string>(.*?)<\/string>/gs),
    ].map((match) => decode(match[1] ?? "")),
  };
}
const args =
  kind === "daemon"
    ? [
        "/different/bin/bun",
        ...(scenario === "bun-run" ? ["run"] : []),
        join(plistApp, "src", "cli", "main.ts"),
        "serve",
      ]
    : kind === "mtplx"
      ? [join(home, ".mtplx", "bin", "mtplx"), "serve", "--model", "old-model"]
      : [
          "/opt/homebrew/bin/cloudflared",
          "tunnel",
          "--config",
          join(home, ".cloudflared", "limitless.yml"),
          "run",
        ];
if (scenario === "displaced") args.splice(1, 0, "/other/program.ts", "--");
if (scenario === "trailing") args.push("--extra");
if (scenario === "aux-path-alias") {
  const original = kind === "tunnel" ? args[3] : args[0];
  if (!original) throw new Error("missing auxiliary path");
  const link = join(home, "aux-alias");
  symlinkSync(original, link);
  args[kind === "tunnel" ? 3 : 0] = link;
}
const marker = ["marked", "contradictory"].includes(scenario)
  ? `<key>LimitlessService</key><string>${scenario === "contradictory" ? (kind === "daemon" ? "tunnel" : "daemon") : kind}</string>`
  : "";
const old = `<plist><dict>${marker}<key>Label</key><string>${oldLabel}</string><key>WorkingDirectory</key><string>${xmlEscape(plistApp)}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xmlEscape(a)}</string>`).join("")}</array></dict></plist>`;
if (scenario !== "fresh" && !scenario.startsWith("recover")) {
  writeFileSync(oldPath, old);
  if (scenario !== "unloaded") loaded.add(oldLabel);
}
const unrelated = `<plist><dict><key>Label</key><string>other.program</string><key>LimitlessService</key><string>daemon</string><key>ProgramArguments</key><array><string>/bin/echo</string><string>${xmlEscape(join(app, "src", "cli", "main.ts"))}</string><string>serve</string></array></dict></plist>`;
writeFileSync(join(agents, "unrelated.plist"), unrelated);
loaded.add("other.program");
writeFileSync(join(agents, "broken.plist"), "not a plist");
if (scenario === "persist-failure") {
  mkdirSync(join(home, ".limitless"), { recursive: true });
  writeFileSync(join(home, ".limitless", "service-backup"), "blocked");
}
if (scenario === "collision") loaded.add(neutral);
if (scenario === "path-collision") writeFileSync(join(agents, `${neutral}.plist`), unrelated);
if (scenario === "duplicate")
  writeFileSync(join(agents, "duplicate.plist"), old.replace(oldLabel, "another.daemon"));
let time = 0;
let draining = false;
let stopping = "";
let stoppedAt = 0;
const clock: DeployClock = {
  now: () => time,
  sleep: async (ms) => {
    time += ms;
  },
  timeout: () => () => {},
};
const backupDir = join(home, ".limitless", "service-backup");
const lock = join(home, ".limitless", "deploy.lock");
let backupBeforeStop = false;
let recoveryCleaned = false;
let contenderError = "";
let contenderCalls: string[] = [];
let lockHeld = false;
let competed = false;
async function compete() {
  if (competed) return;
  competed = true;
  const before = calls.length;
  const contender =
    scenario === "install-deploy"
      ? () => service.deploy(0, undefined, false, { command, client, clock })
      : () => service.install(0, { command, client, clock });
  contenderError = String(await contender().catch((error) => error));
  contenderCalls = calls.slice(before);
  lockHeld = existsSync(lock) && readFileSync(lock, "utf8").trim() === String(process.pid);
}
const command: typeof sh = async (argv) => {
  const ok = (stdout = "", exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr });
  if (argv[0] === "plutil") {
    const content = readFileSync(argv.at(-1) ?? "", "utf8");
    return content.startsWith("<") ? ok(JSON.stringify(parse(content))) : ok("", 1, "invalid plist");
  }
  if (argv[0] !== "launchctl") {
    if (argv[0] === "bun" && argv[1] === "install")
      recoveryCleaned = !existsSync(join(backupDir, "migration.json"));
    return ok(argv[1] === "rev-parse" ? "current" : "");
  }
  const label = argv.at(-1)?.split("/").at(-1) ?? "";
  if (argv[1] === "print") {
    if (stopping && time > stoppedAt && scenario !== "stuck") {
      loaded.delete(stopping);
      stopping = "";
    }
    return ok("", loaded.has(label) ? 0 : 1);
  }
  if (argv[1] === "bootout") {
    calls.push(`bootout ${label}`);
    if (label === oldLabel)
      backupBeforeStop =
        existsSync(join(backupDir, "migration.json")) &&
        readFileSync(join(backupDir, "original.plist"), "utf8") === old;
    if (
      scenario === "bootout" ||
      (["health-bootout", "marked-health-bootout"].includes(scenario) &&
        label === neutral &&
        !existsSync(oldPath))
    )
      return ok("", 1, "bootout denied");
    stopping = label;
    stoppedAt = time;
    return ok();
  }
  if (argv[1] === "bootstrap") {
    const path = argv.at(-1) ?? "";
    const data = parse(readFileSync(path, "utf8"));
    calls.push(`bootstrap ${data.Label}`);
    if (data.Label === neutral && scenario === "phase-update")
      mkdirSync(join(backupDir, "migration.json.tmp"));
    if (data.Label === neutral && scenario.startsWith("signal")) {
      if (existsSync(oldPath)) throw new Error("signal must follow old plist removal");
      signalTimer = setTimeout(() => {
        throw new Error("signal test timed out");
      }, 10000);
      console.log("READY");
      await new Promise(() => {});
    }
    if (data.Label === oldLabel && scenario === "signal-rollback") {
      console.log("ROLLBACK");
      await new Promise(() => {});
    }
    if (data.Label === neutral && ["install-install", "install-deploy"].includes(scenario)) await compete();
    if (data.Label === neutral && scenario === "crash-healthy") {
      loaded.add(neutral);
      writeFileSync(join(home, "loaded.json"), JSON.stringify([...loaded]));
      process.exit(0);
    }
    if (data.Label === neutral && ["bootstrap", "restore", "partial"].includes(scenario)) {
      if (scenario === "partial") loaded.add(neutral);
      return ok("", 1, "replacement bootstrap failed");
    }
    if (data.Label === oldLabel && scenario === "restore") return ok("", 1, "old bootstrap failed");
    if (
      loaded.has(data.Label ?? "") ||
      (data.Label === neutral &&
        loaded.has(oldLabel) &&
        !["bun-run", "displaced", "contradictory", "other-install"].includes(scenario))
    )
      throw new Error("overlapping services");
    if (
      data.Label === neutral &&
      existsSync(oldPath) &&
      !["bun-run", "displaced", "contradictory", "other-install"].includes(scenario)
    )
      throw new Error("old plist still present");
    if (!data.Label) throw new Error("missing label");
    loaded.add(data.Label);
    draining = false;
    return ok();
  }
  throw new Error(`unexpected launchctl: ${argv.join(" ")}`);
};
const client: DeployClient = {
  async admin(action) {
    calls.push(action);
    if (action === "resume" && scenario === "resume-failure") throw new Error("resume failed");
    draining = action === "drain";
    if (action === "drain" && ["drain", "resume-failure"].includes(scenario)) throw new Error("drain failed");
    if (action === "drain" && scenario === "unsupported")
      throw new DrainUnsupportedError("no drain endpoint");
    return { draining, active: [] };
  },
  async health() {
    calls.push(`health ${draining ? "draining" : "fresh"}`);
    if (scenario === "deploy-install") await compete();
    if (draining && scenario === "drain-health") throw new Error("drain health failed");
    if (
      ["health", "wrong-sha", "health-bootout", "marked-health-bootout", "phase-update"].includes(scenario) &&
      loaded.has(neutral) &&
      !draining
    ) {
      if (scenario !== "wrong-sha") throw new Error("replacement health failed");
      return { ok: true, uptimeMs: 1, sha: "wrong", draining: false, active: [] };
    }
    return {
      ok: true,
      uptimeMs: 1,
      sha: "current",
      draining,
      active: draining && (scenario === "timeout" || time < 5000) ? ["active-run"] : [],
    };
  },
  async run() {
    calls.push("active stage");
    return { stage: "review" };
  },
};
mock.module("../src/util/proc.ts", () => ({ sh: command }));
spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
if (scenario.startsWith("recover") && existsSync(join(home, "loaded.json"))) {
  for (const label of JSON.parse(readFileSync(join(home, "loaded.json"), "utf8"))) loaded.add(label);
}
const service = await import("../src/cli/service.ts");
let error = "";
try {
  if (["recover-deploy", "recover-healthy-deploy", "deploy-install"].includes(scenario))
    await service.deploy(0, undefined, false, { command, client, clock });
  else if (scenario === "status") await service.status(0);
  else if (scenario === "uninstall") await service.uninstall();
  else
    await service.install(0, {
      command,
      client,
      clock,
      mtplx: kind === "mtplx" && scenario !== "unselected",
      tunnel: kind === "tunnel" && scenario !== "unselected",
      publicUrl: "https://hooks.example.test",
    });
} catch (caught) {
  error = String(caught);
}
clearTimeout(signalTimer);
writeFileSync(join(home, "loaded.json"), JSON.stringify([...loaded]));
console.log(
  JSON.stringify({
    error,
    backupBeforeStop,
    contenderError,
    contenderCalls,
    lockHeld,
    recoveryCleaned,
    backup: existsSync(join(backupDir, "original.plist"))
      ? readFileSync(join(backupDir, "original.plist"), "utf8")
      : null,
    state: existsSync(join(backupDir, "migration.json")),
    lock: existsSync(lock),
    calls,
    loaded: [...loaded],
    draining,
    old,
    time,
    files: Object.fromEntries(
      readdirSync(agents).map((name) => [name, readFileSync(join(agents, name), "utf8")]),
    ),
    unrelated,
  }),
);
