import { mock, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { DeployClient, DeployClock } from "../src/cli/deploy-wait.ts";
import { DrainUnsupportedError } from "../src/cli/deploy-wait.ts";
import type { sh } from "../src/util/proc.ts";
import * as proc from "../src/util/proc.ts";
import { inspectionResult } from "./service-inspection-support.ts";

const home = process.env.SERVICE_TEST_HOME;
if (!home) throw new Error("missing isolated test home");
const nativeOs = { ...os };
mock.module("node:os", () => ({ ...nativeOs, homedir: () => home }));
const requestedScenario = process.argv[2] ?? "migration";
const sequential = requestedScenario.startsWith("sequence");
const executorRecovery = requestedScenario.startsWith("executor-recovery");
let scenario = sequential || executorRecovery ? "bootstrap" : requestedScenario;
const kind = process.argv[3] ?? "daemon";
const packaged = requestedScenario.startsWith("packaged-");
const programCase = requestedScenario.split("-program-")[1];
const agents = packaged ? join(home, "isolated-agents") : join(home, "Library", "LaunchAgents");
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
const disabled = new Set<string>();
const recoveries: { error: string; phase: string; retained: boolean }[] = [];
const oldLabel = scenario.startsWith("marked") ? `dev.limitless.${kind}` : `arbitrary.installed.${kind}`;
const oldPath = join(agents, `${kind}-original.plist`);
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
    Program: value("Program") ?? (content.includes("<key>Program</key><false/>") ? false : undefined),
    LimitlessService: value("LimitlessService"),
    WorkingDirectory: value("WorkingDirectory"),
    EnvironmentVariables: Object.fromEntries(
      [
        ...(content.match(/<key>EnvironmentVariables<\/key>\s*<dict>(.*?)<\/dict>/s)?.[1] ?? "").matchAll(
          /<key>(.*?)<\/key><string>(.*?)<\/string>/gs,
        ),
      ].map((match) => [match[1], decode(match[2] ?? "")]),
    ),
    ProgramArguments: [
      ...(content.match(/<array>(.*?)<\/array>/s)?.[1] ?? "").matchAll(/<string>(.*?)<\/string>/gs),
    ].map((match) => decode(match[1] ?? "")),
  };
}
const args =
  kind === "daemon" || kind === "executor"
    ? [
        "/different/bin/bun",
        ...(scenario === "bun-run" ? ["run"] : []),
        join(plistApp, "src", "cli", "main.ts"),
        kind === "executor" ? "executor" : "serve",
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
if (!packaged && !programCase && scenario !== "fresh" && !scenario.startsWith("recover")) {
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
const journal = join(backupDir, `${neutral}.json`);
const journals = () =>
  existsSync(backupDir) && statSync(backupDir).isDirectory()
    ? readdirSync(backupDir).filter((name) => name.endsWith(".json"))
    : [];
const record = () => (existsSync(journal) ? JSON.parse(readFileSync(journal, "utf8")) : null);
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
      ? () =>
          service.deploy(0, undefined, false, {
            command,
            client,
            clock,
            leaseClient: async () => ({ id: "lease", acquired: true }),
          })
      : () => service.install(0, { command, client, clock });
  contenderError = String(await contender().catch((error) => error));
  contenderCalls = calls.slice(before);
  lockHeld = existsSync(lock) && readFileSync(lock, "utf8").trim() === String(process.pid);
}
const commands: string[][] = [];
let inspectionInjected = false;
let replacementFailed = false;
const command: typeof sh = async (argv) => {
  commands.push([...argv]);
  const ok = (stdout = "", exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr });
  if (argv[0] === "plutil") {
    const content = readFileSync(argv.at(-1) ?? "", "utf8");
    return content.startsWith("<") ? ok(JSON.stringify(parse(content))) : ok("", 1, "invalid plist");
  }
  if (argv[0] !== "launchctl") {
    if (scenario === "stop-after-recovery" && argv[1] === "fetch") throw new Error("stopped after recovery");
    if (argv[0] === "bun" && argv[1] === "install") recoveryCleaned = !journals()?.length;
    return ok(argv[1] === "rev-parse" ? "current" : "");
  }
  const label = argv.at(-1)?.split("/").at(-1) ?? "";
  if (argv[1] === "print") {
    const inspectionCase = process.env.SERVICE_TEST_INSPECTION;
    if (
      inspectionCase &&
      ((scenario === "inspection-collision" && label === neutral && !calls.includes(`bootout ${oldLabel}`)) ||
        (["inspection-status", "inspection-uninstall"].includes(scenario) && label === oldLabel) ||
        (scenario === "inspection-old" && label === oldLabel && !inspectionInjected) ||
        (scenario === "inspection-reconcile" && label === neutral && !existsSync(oldPath)) ||
        (scenario === "inspection-restore" && label === neutral && replacementFailed && !inspectionInjected))
    ) {
      inspectionInjected = true;
      if (inspectionCase === "absent") loaded.delete(label);
      return inspectionResult(inspectionCase, label);
    }
    if (stopping && time > stoppedAt && scenario !== "stuck") {
      loaded.delete(stopping);
      stopping = "";
    }
    return loaded.has(label)
      ? ok()
      : ok("", 113, `Could not find service "${label}" in domain for user gui: ${os.userInfo().uid}`);
  }
  if (argv[1] === "enable" || argv[1] === "disable") {
    calls.push(`${argv[1]} ${label}`);
    if (argv[1] === "disable") disabled.add(label);
    else disabled.delete(label);
    return ok();
  }
  if (argv[1] === "bootout") {
    calls.push(`bootout ${label}`);
    if (label === oldLabel) backupBeforeStop = record()?.backup === Buffer.from(old).toString("base64");
    if (label === oldLabel && scenario === "signal-stopping") {
      console.log("READY");
      await new Promise(() => {});
    }
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
    const unitKind = data.Label?.split(".").at(-1) ?? "";
    const unitNeutral = `dev.limitless.${unitKind}`;
    const unitOld = unitKind === kind ? oldLabel : `arbitrary.installed.${unitKind}`;
    const unitOldPath = join(agents, `${unitKind}-original.plist`);
    calls.push(`bootstrap ${data.Label}`);
    if (disabled.has(data.Label ?? "")) return ok("", 1, "label disabled");
    if (packaged && data.Label === neutral) {
      packagedHealthReads = 0;
      if (failBootstrap) {
        failBootstrap = false;
        return ok("", 1, "replacement bootstrap failed");
      }
    }
    if (data.Label === neutral && scenario === "phase-update") mkdirSync(`${journal}.tmp`);
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
    if (
      data.Label === neutral &&
      ["bootstrap", "restore", "partial", "inspection-restore"].includes(scenario)
    ) {
      replacementFailed = true;
      if (scenario === "partial") loaded.add(neutral);
      return ok("", 1, "replacement bootstrap failed");
    }
    if (
      (data.Label === oldLabel && scenario === "restore") ||
      (data.Label === "arbitrary.installed.daemon" && scenario === "recover-restore-failure-deploy")
    )
      return ok("", 1, "old bootstrap failed");
    if (
      loaded.has(data.Label ?? "") ||
      (data.Label === unitNeutral &&
        loaded.has(unitOld) &&
        !["bun-run", "displaced", "contradictory", "other-install"].includes(scenario))
    )
      throw new Error("overlapping services");
    if (
      data.Label === unitNeutral &&
      existsSync(unitOldPath) &&
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
let packagedHealthReads = 0;
let failBootstrap = false;
let failHealth = false;
const client: DeployClient = {
  async admin(action) {
    calls.push(action);
    if (action === "resume" && scenario === "resume-failure") throw new Error("resume failed");
    if (action === "drain" && (scenario.endsWith("signal-drain") || scenario === "signal-journal")) {
      writeFileSync(join(home, "loaded.json"), JSON.stringify([...loaded]));
      const interrupted = new Promise<void>((resolve) => {
        const finish = () => {
          process.off("SIGINT", finish);
          process.off("SIGTERM", finish);
          resolve();
        };
        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
      });
      console.log("READY");
      await interrupted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      calls.push("drain applied");
    }
    draining = action === "drain";
    if (action === "drain" && ["drain", "resume-failure"].includes(scenario)) throw new Error("drain failed");
    if (action === "drain" && scenario === "unsupported")
      throw new DrainUnsupportedError("no drain endpoint");
    return { draining, active: [] };
  },
  async health() {
    if (packaged) {
      const sha = !draining && (failHealth || packagedHealthReads++ === 0) ? "b".repeat(40) : "a".repeat(40);
      calls.push(`health ${draining ? "draining" : sha}`);
      return { ok: true, uptimeMs: 1, sha, draining, active: [] };
    }
    calls.push(`health ${draining ? "draining" : "fresh"}`);
    if (scenario === "deploy-install") await compete();
    if (draining && scenario === "drain-health") throw new Error("drain health failed");
    if (scenario === "recover-unhealthy-deploy") throw new Error("daemon health failed");
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
const nativeProc = { ...proc };
mock.module("../src/util/proc.ts", () => ({ ...nativeProc, sh: command }));
spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
if (scenario.startsWith("recover") && existsSync(join(home, "loaded.json"))) {
  for (const label of JSON.parse(readFileSync(join(home, "loaded.json"), "utf8"))) loaded.add(label);
}
const service = await import("../src/cli/service.ts");
let error = "";
let firstError = "";
let tunnelJournal = "";
let daemonOld = "";
let firstCalls: string[] = [];
let discovered: string[] = [];
let discoveredUnits: { label: string; path: string; kind: string }[] = [];
let original = "";
let stable = "";
let executable = "";
try {
  if (programCase) {
    executable = join(home, "bin", kind === "tunnel" ? "cloudflared" : packaged ? "limitless" : "bun");
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "executable");
    const unitArgs =
      packaged && ["daemon", "executor"].includes(kind)
        ? [executable, kind === "executor" ? "executor" : "serve"]
        : [...args];
    if (kind !== "mtplx") unitArgs[0] = executable;
    const first = unitArgs[0];
    if (!first) throw new Error("missing executable argument");
    const alias = join(home, "program-alias");
    symlinkSync(first, alias);
    const other = join(home, "other-executable");
    writeFileSync(other, "unrelated executable");
    const program = ["absent", "marker", "duplicate"].includes(programCase)
      ? ""
      : programCase === "invalid"
        ? "<key>Program</key><false/>"
        : `<key>Program</key><string>${xmlEscape(
            programCase === "equal"
              ? first
              : programCase === "symlink"
                ? alias
                : programCase === "unresolvable"
                  ? join(home, "missing-executable")
                  : other,
          )}</string>`;
    const directory = packaged ? join(home, ".limitless") : app;
    mkdirSync(directory, { recursive: true });
    original = `<plist><dict>${programCase === "marker" ? "<key>LimitlessService</key><string>daemon</string>" : ""}<key>Label</key><string>${oldLabel}</string>${program}<key>WorkingDirectory</key><string>${xmlEscape(directory)}</string><key>ProgramArguments</key><array>${unitArgs.map((arg) => `<string>${xmlEscape(arg)}</string>`).join("")}</array></dict></plist>`;
    const path = join(agents, programCase === "collision" ? `${neutral}.plist` : `${kind}-original.plist`);
    writeFileSync(path, original);
    if (programCase === "duplicate")
      writeFileSync(join(agents, "duplicate.plist"), original.replace(oldLabel, "other.executor"));
    loaded.add(oldLabel);
    const options = {
      command,
      client,
      clock,
      agentsDir: agents,
      execPath: executable,
      release: packaged
        ? { kind: "packaged" as const, sha: "a".repeat(40), version: "1.0", bun: Bun.version }
        : { kind: "source" as const, root: app, version: "1.0", bun: Bun.version },
    };
    discoveredUnits = await service.installedUnits(options);
    discovered = discoveredUnits.map((unit) => unit.kind);
    if (programCase === "collision") await service.install(0, options);
  } else if (packaged) {
    const prefix = join(home, "brew");
    const version = join(prefix, "Cellar", "limitless", "1.0");
    executable = join(version, "bin", "limitless");
    stable = join(prefix, "opt", "limitless", "bin", "limitless");
    mkdirSync(join(version, "bin"), { recursive: true });
    writeFileSync(executable, "binary");
    mkdirSync(join(prefix, "opt"), { recursive: true });
    symlinkSync(version, join(prefix, "opt", "limitless"));
    const options = {
      command,
      client,
      clock,
      agentsDir: agents,
      release: { kind: "packaged" as const, sha: "a".repeat(40), version: "1.0", bun: Bun.version },
      execPath: executable,
      executor: kind === "executor",
      mtplx: true,
      tunnel: true,
      publicUrl: "https://hooks.example.test",
    };
    process.env.BUN_BE_BUN = "1";
    process.env.BUN_OPTIONS = "--preload=caller-option";
    process.env.SERVICE_CALLER_VARIABLE = "caller-value";
    const path = join(agents, "dev.limitless.daemon.plist");
    if (scenario === "packaged-source") {
      original =
        service.installationUnits({
          release: { kind: "source", root: app, version: "1.0", bun: Bun.version },
        })[0]?.[1] ?? "";
      writeFileSync(path, original);
      loaded.add(neutral);
    } else {
      await service.install(0, options);
      firstCalls = calls.splice(0);
      original = readFileSync(path, "utf8").replace("<integer>10</integer>", "<integer>11</integer>");
      if (scenario !== "packaged-fresh") writeFileSync(path, original);
    }
    if (scenario !== "packaged-fresh") {
      if (scenario === "packaged-invalid") unlinkSync(join(prefix, "opt", "limitless"));
      if (scenario === "packaged-extra") {
        original = original.replace("</array>", "<string>--extra</string></array>");
        writeFileSync(path, original);
      }
      failBootstrap = scenario === "packaged-bootstrap";
      failHealth = scenario === "packaged-health";
      await service.install(0, options);
      discovered = (await service.installedUnits(options)).map((unit) => unit.kind);
    }
  } else if (scenario === "deploy-install" || (scenario.startsWith("recover") && scenario.endsWith("deploy")))
    await service.deploy(0, undefined, false, {
      command,
      client,
      clock,
      leaseClient: async () => ({ id: "lease", acquired: true }),
    });
  else if (requestedScenario === "intent-install") {
    const intentPath = join(home, ".limitless", "executor-intent.json");
    mkdirSync(join(intentPath, ".."), { recursive: true });
    writeFileSync(
      intentPath,
      JSON.stringify({
        phase: "deploying",
        label: oldLabel,
        path: oldPath,
        previous: "previous",
        target: "current",
      }),
    );
    await service.install(0, { command, client, clock, executor: true });
  } else if (executorRecovery) {
    disabled.add(oldLabel);
    await service.install(0, { command, client, clock, executor: true }).catch((e) => {
      firstError = String(e);
    });
    firstCalls = calls.splice(0);
    for (let i = 0; i < 2; i++) {
      scenario = requestedScenario.endsWith("stuck") ? "stuck" : "stop-after-recovery";
      if (scenario === "stuck") loaded.add(oldLabel);
      const error = String(
        await service.deploy(0, undefined, false, { command, client, clock, executor: true }).catch((e) => e),
      );
      recoveries.push({ error, phase: record()?.phase, retained: existsSync(journal) });
    }
    if (!requestedScenario.endsWith("stuck")) {
      scenario = "migration";
      await service.deploy(0, undefined, false, { command, client, clock, executor: true });
    }
  } else if (["status", "inspection-status"].includes(scenario)) await service.status(0, { command });
  else if (["uninstall", "inspection-uninstall"].includes(scenario)) await service.uninstall({ command });
  else {
    await service
      .install(0, {
        command,
        client,
        clock,
        executor: kind === "executor" && scenario !== "unselected",
        mtplx: kind === "mtplx" && scenario !== "unselected",
        tunnel: kind === "tunnel" && scenario !== "unselected",
        publicUrl: "https://hooks.example.test",
      })
      .catch((caught) => {
        if (!sequential) throw caught;
        firstError = String(caught);
      });
    if (sequential) {
      tunnelJournal = existsSync(journal) ? readFileSync(journal, "utf8") : "";
      const daemonPath = join(agents, "dev.limitless.daemon.plist");
      daemonOld = readFileSync(daemonPath, "utf8").replaceAll(
        "dev.limitless.daemon",
        "arbitrary.installed.daemon",
      );
      // Give the second install a distinct, running legacy daemon to migrate.
      unlinkSync(daemonPath);
      writeFileSync(join(agents, "daemon-original.plist"), daemonOld);
      loaded.delete("dev.limitless.daemon");
      loaded.add("arbitrary.installed.daemon");
      scenario = requestedScenario === "sequence-signal" ? "signal-journal" : "migration";
      await service.install(0, { command, client, clock });
    }
  }
} catch (caught) {
  error = String(caught);
}
clearTimeout(signalTimer);
writeFileSync(join(home, "loaded.json"), JSON.stringify([...loaded]));
console.log(
  JSON.stringify({
    error,
    firstCalls,
    recoveries,
    discovered,
    discoveredUnits,
    original,
    stable,
    executable,
    commands,
    parsedUnits: Object.fromEntries(
      readdirSync(agents)
        .filter((name) => name.startsWith("dev.limitless."))
        .map((name) => [name, parse(readFileSync(join(agents, name), "utf8"))]),
    ),
    backupBeforeStop,
    contenderError,
    contenderCalls,
    lockHeld,
    recoveryCleaned,
    firstError,
    tunnelJournal,
    daemonOld,
    backup: record() ? Buffer.from(record().backup, "base64").toString() : null,
    phase: record()?.phase,
    state: existsSync(journal),
    journals: journals() || [],
    lock: existsSync(lock),
    calls,
    loaded: [...loaded],
    disabled: [...disabled],
    intent: existsSync(join(home, ".limitless", "executor-intent.json")),
    draining,
    old,
    time,
    files: Object.fromEntries(
      readdirSync(agents).map((name) => [name, readFileSync(join(agents, name), "utf8")]),
    ),
    unrelated,
  }),
);
