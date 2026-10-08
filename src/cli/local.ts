import { homedir } from "node:os";
import { PROVIDERS, type ProviderDef } from "../router/catalog.ts";
import { sh } from "../util/proc.ts";

const unitName = "limitless-llama.service";
const unitPath = `~/.config/systemd/user/${unitName}`;
type Runner = typeof sh;

export interface LocalOptions {
  remoteModelPath?: string;
  remoteHost?: string;
  remoteLlamaBinary?: string;
  providers?: ProviderDef[];
  command?: Runner;
  /** Secrets for provider API keys, so the health probe authenticates like the router does. */
  secrets?: Record<string, string>;
  probe?: (url: string, token?: string) => Promise<boolean>;
  setEnabled?: (id: string, enabled: boolean) => Promise<void>;
}

function systemdQuote(value: string): string {
  if (!value.startsWith("/") || /[\n\r%]/.test(value))
    throw new Error("remote model path must be an absolute path without newlines or percent escapes");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A starting-point unit for a fresh host: full GPU offload, 128K context with a q8 KV cache, one slot,
 * Jinja chat templates, and a neutral model alias. The API key is read from a file
 * so it never appears in the process list.
 */
export function remoteUnit(
  modelPath: string,
  binary = "/usr/local/bin/llama-server",
  alias = "local",
): string {
  if (!/^[\w.-]+$/.test(alias)) throw new Error(`invalid llama-server alias: ${alias}`);
  return `[Unit]
Description=Limitless llama-server
After=network-online.target

[Service]
ExecStart=${systemdQuote(binary)} -m ${systemdQuote(modelPath)} --alias ${alias} -c 131072 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 -np 1 --jinja --host 0.0.0.0 --port 8080 --api-key-file %h/.config/limitless/llama-api-key --metrics
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export interface LocalReport {
  omlx: { service: string; endpoint: string };
  remote?: { service: string; endpoint: string };
}

export async function manageLocal(
  action: "up" | "down" | "status",
  opts: LocalOptions,
): Promise<LocalReport> {
  const command = opts.command ?? sh;
  const host = opts.remoteHost?.trim();
  const providers = opts.providers ?? PROVIDERS;
  const run = (args: string[], stdin?: string) =>
    command(args, { cwd: homedir(), timeoutMs: 10_000, allowFail: true, ...(stdin ? { stdin } : {}) });
  const ssh = (args: string[], stdin?: string) =>
    run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host ?? "", ...args], stdin);
  const probe =
    opts.probe ??
    (async (url: string, token?: string) => {
      try {
        const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
        return (await fetch(url, { headers, signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    });

  const token = (id: string) => {
    const provider = providers.find((p) => p.id === id);
    return provider?.apiKey ?? (provider?.apiKeySecret ? opts.secrets?.[provider.apiKeySecret] : undefined);
  };
  const omlxUrl = providers.find((p) => p.id === "omlx")?.healthUrl ?? "http://127.0.0.1:8989/v1/models";
  const healthy = async (url: string, id?: string) =>
    (await probe(url, id ? token(id) : undefined)) ? "healthy" : "unreachable";
  const report: LocalReport = {
    omlx: {
      service: "externally managed (oMLX.app / omlx start)",
      endpoint: token("omlx") ? await healthy(omlxUrl, "omlx") : "unavailable: missing OMLX_API_KEY",
    },
  };
  if (!host) return report;
  const origin = new URL(`http://${host}:8080`).origin;
  const remoteProvider = providers.find((p) => p.openaiBaseUrl && new URL(p.openaiBaseUrl).origin === origin);

  // Never overwrite an installed unit: it may carry host-specific tuning (chat template, flags).
  const startRemote = async (): Promise<string> => {
    const exists = await ssh(["test", "-f", unitPath]);
    if (exists.exitCode === 255) return "unreachable";
    if (exists.exitCode !== 0) {
      if (!opts.remoteModelPath) return "unit missing: set [local].remote_model_path";
      const write = await ssh(
        [`mkdir -p ~/.config/systemd/user && cat > ${unitPath}`],
        remoteUnit(opts.remoteModelPath, opts.remoteLlamaBinary),
      );
      if (write.exitCode !== 0) return write.exitCode === 255 ? "unreachable" : "unit write failed";
      if ((await ssh(["systemctl", "--user", "daemon-reload"])).exitCode !== 0) return "start failed";
    }
    const start = await ssh(["systemctl", "--user", "enable", "--now", unitName]);
    return start.exitCode === 0 ? "active" : "start failed";
  };

  let remoteService = "unreachable";
  const current = await ssh(["systemctl", "--user", "is-active", unitName]);
  if (current.exitCode === 255) {
    remoteService = "unreachable";
  } else if (action === "up") {
    remoteService = await startRemote();
  } else if (action === "down" && current.exitCode === 0) {
    const stop = await ssh(["systemctl", "--user", "stop", unitName]);
    remoteService = stop.exitCode === 0 ? "stopped" : "stop failed";
  } else remoteService = action === "down" ? "stopped" : current.exitCode === 0 ? "active" : "inactive";

  const remoteUrl = remoteProvider?.healthUrl ?? `http://${host}:8080/v1/models`;
  report.remote = {
    service: remoteService,
    endpoint:
      action === "down" || (action === "up" && remoteService !== "active")
        ? "unreachable"
        : await healthy(remoteUrl, remoteProvider?.id),
  };
  if (action === "down") {
    if (remoteService === "stopped" && remoteProvider) await opts.setEnabled?.(remoteProvider.id, false);
  } else if (action === "up") {
    if (
      remoteService === "active" &&
      report.remote.endpoint === "healthy" &&
      remoteProvider &&
      (!remoteProvider.apiKeySecret || token(remoteProvider.id))
    )
      await opts.setEnabled?.(remoteProvider.id, true);
  }
  return report;
}
