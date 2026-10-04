// Offline CLI substitute and owned markers. No pre-existing process is ever targeted.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";

if (process.argv[2] === "marker") {
  console.log("ready");
  setTimeout(() => process.exit(0), 20_000);
} else if (process.env.SIGNAL_HANDSHAKE_ONLY === "1") {
  const started = process.env.SIGNAL_STARTED;
  if (!started) throw new Error("missing handshake path");
  writeFileSync(started, "started");
  console.log('{"type":"result","subtype":"success","result":"handshake"}');
  console.log('{"type":"turn.completed","usage":{}}');
} else {
  const marker = process.env.SIGNAL_MARKER;
  const started = process.env.SIGNAL_STARTED;
  if (!marker || !started) throw new Error("missing owned fixture configuration");
  writeFileSync(started, "started");
  const start = async () => {
    const child = spawn(process.execPath, [import.meta.path, "marker", marker], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const closed = once(child, "exit");
    await once(child.stdout, "data");
    if (!child.pid) throw new Error("missing owned pid");
    return { child, closed, pid: child.pid };
  };
  const owned = await start();
  if (process.env.SIGNAL_WAIT === "1") {
    console.log(`owned:${owned.pid}`);
    await owned.closed;
  } else {
    try {
      for (const key of ["SIGNAL_OUTSIDE", "SIGNAL_SIBLING"]) {
        const pid = Number(process.env[key]);
        if (!Number.isInteger(pid) || pid < 2) throw new Error("missing test-owned pid");
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* expected kernel denial */
        }
      }
      const attempt = spawn("/usr/bin/pkill", ["-f", `${marker}$`], { stdio: "ignore" });
      await once(attempt, "exit");
      const [code, signal] = await owned.closed;
      if (code !== null || signal !== "SIGTERM") throw new Error("owned marker did not receive signal");
      const direct = await start();
      direct.child.kill("SIGTERM");
      const [, directSignal] = await direct.closed;
      if (directSignal !== "SIGTERM") throw new Error("owned PID signal failed");
      console.log('{"type":"result","subtype":"success","result":"owned-terminated"}');
      console.log('{"type":"turn.completed","usage":{}}');
    } finally {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGTERM");
    }
  }
}
