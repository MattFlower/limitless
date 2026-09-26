import { type ChildProcess, spawn } from "node:child_process";

export interface SshForward {
  host: string; // ssh destination, e.g. "twilight"
  localPort: number;
  remotePort: number;
}

/**
 * Keeps `ssh -N -L` port forwards to remote model servers alive, restarting with backoff.
 * Lets the daemon reach a GPU box's localhost-only server without opening firewall ports.
 */
export class SshTunnels {
  private procs = new Map<string, ChildProcess>();
  private stopped = false;

  constructor(private readonly log: (msg: string) => void = () => {}) {}

  start(forwards: SshForward[]): void {
    for (const f of forwards) this.spawn(f, 0);
  }

  private spawn(f: SshForward, attempt: number): void {
    if (this.stopped) return;
    const key = `${f.host}:${f.localPort}`;
    const child = spawn(
      "ssh",
      [
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `127.0.0.1:${f.localPort}:127.0.0.1:${f.remotePort}`,
        f.host,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const started = Date.now();
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr = (stderr + d).slice(-500);
    });
    child.on("exit", (code) => {
      this.procs.delete(key);
      if (this.stopped) return;
      // Reset backoff after a forward that stayed up for a while.
      const next = Date.now() - started > 60_000 ? 0 : attempt + 1;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(next, 6));
      this.log(
        `ssh forward ${key} exited (${code}); retrying in ${Math.round(delay / 1000)}s ${stderr.trim()}`,
      );
      setTimeout(() => this.spawn(f, next), delay).unref?.();
    });
    this.procs.set(key, child);
  }

  stop(): void {
    this.stopped = true;
    for (const p of this.procs.values()) p.kill("SIGTERM");
    this.procs.clear();
  }
}
