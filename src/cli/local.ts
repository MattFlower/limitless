import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { PROVIDERS } from "../router/catalog.ts";
import { sh } from "../util/proc.ts";
import { mtplxPlist } from "./service.ts";

const label = "cc.mattflower.limitless-mtplx";
const unitName = "limitless-llama.service";
type Runner = typeof sh;

export interface LocalOptions {
  modelPath: string;
  twilightHost?: string;
  llamaBinary?: string;
  mtplxPlistPath?: string;
  command?: Runner;
  probe?: (url: string) => Promise<boolean>;
}

function systemdQuote(value: string): string {
  if (!value.startsWith("/") || /[\n\r%]/.test(value))
    throw new Error("twilight model path must be an absolute path without newlines or percent escapes");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function twilightUnit(
  modelPath: string,
  binary = "/home/mflower/.local/share/limitless/llama-bin/llama-server",
): string {
  return `[Unit]
Description=Limitless llama-server
After=network-online.target

[Service]
EnvironmentFile=%h/.config/limitless/secrets.env
ExecStart=${systemdQuote(binary)} -m ${systemdQuote(modelPath)} --host 0.0.0.0 --port 8080 --api-key \${TWILIGHT_API_KEY}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

export interface LocalReport {
  mtplx: { service: string; endpoint: string };
  twilight: { service: string; endpoint: string };
}

export async function manageLocal(
  action: "up" | "down" | "status",
  opts: LocalOptions,
): Promise<LocalReport> {
  if (action === "up" && !opts.modelPath)
    throw new Error("set [local].twilight_model_path in config.toml before running limitless local up");
  const command = opts.command ?? sh;
  const host = opts.twilightHost ?? "twilight";
  const path = opts.mtplxPlistPath ?? join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${userInfo().uid}`;
  const run = (args: string[], stdin?: string) =>
    command(args, { cwd: homedir(), timeoutMs: 10_000, allowFail: true, ...(stdin ? { stdin } : {}) });
  const ssh = (args: string[], stdin?: string) =>
    run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, ...args], stdin);
  const probe =
    opts.probe ??
    (async (url: string) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    });

  let local = await run(["launchctl", "print", `${domain}/${label}`]);
  const wasLoaded = local.exitCode === 0;
  if (action === "up" && local.exitCode !== 0) {
    if (!existsSync(path)) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, mtplxPlist());
    }
    local = await run(["launchctl", "bootstrap", domain, path]);
  } else if (action === "down" && local.exitCode === 0) {
    local = await run(["launchctl", "bootout", `${domain}/${label}`]);
  }
  const localService =
    action === "up" && local.exitCode !== 0
      ? "start failed"
      : action === "down"
        ? !wasLoaded || local.exitCode === 0
          ? "stopped"
          : "stop failed"
        : local.exitCode === 0
          ? "loaded"
          : "not loaded";

  let remoteService = "unreachable";
  const current = await ssh(["systemctl", "--user", "is-active", unitName]);
  if (current.exitCode === 255) {
    remoteService = "unreachable";
  } else if (action === "up") {
    const unit = twilightUnit(opts.modelPath, opts.llamaBinary);
    const write = await ssh(
      ["mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/limitless-llama.service"],
      unit,
    );
    if (write.exitCode === 0) {
      const reload = await ssh(["systemctl", "--user", "daemon-reload"]);
      const start =
        reload.exitCode === 0 ? await ssh(["systemctl", "--user", "enable", "--now", unitName]) : reload;
      remoteService = start.exitCode === 0 ? "active" : "start failed";
    } else remoteService = write.exitCode === 255 ? "unreachable" : "unit write failed";
  } else if (action === "down" && current.exitCode === 0) {
    const stop = await ssh(["systemctl", "--user", "stop", unitName]);
    remoteService = stop.exitCode === 0 ? "stopped" : "stop failed";
  } else remoteService = action === "down" ? "stopped" : current.exitCode === 0 ? "active" : "inactive";

  const mtplxUrl = PROVIDERS.find((p) => p.id === "mtplx")?.healthUrl ?? "http://127.0.0.1:8000/v1/models";
  const twilightUrl = `http://${host}:8080/v1/models`;
  return {
    mtplx: { service: localService, endpoint: (await probe(mtplxUrl)) ? "healthy" : "unreachable" },
    twilight: { service: remoteService, endpoint: (await probe(twilightUrl)) ? "healthy" : "unreachable" },
  };
}
