import { agentEnv, runProcess } from "../src/util/proc.ts";

// No credentials, model requests, or signals: only sandbox startup and nesting.
console.log({ platform: process.platform, bun: Bun.version });
for (const target of ["self", "pgrp", "children", "same-sandbox"]) {
  const profile = `(version 1)(allow default)(deny signal)(allow signal (target ${target}))`;
  for (const nested of [false, true]) {
    const command = nested
      ? ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"]
      : ["/usr/bin/true"];
    const result = await runProcess({
      cmd: ["/usr/bin/sandbox-exec", "-p", profile, ...command],
      cwd: process.cwd(),
      env: agentEnv(),
      timeoutMs: 5000,
    });
    console.log(JSON.stringify({ target, nested, exit: result.exitCode, stderr: result.stderr.trim() }));
  }
}
