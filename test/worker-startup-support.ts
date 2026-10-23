export const workerStartupFailures = [
  [
    "Codex helper",
    "ERROR codex_core::session: Failed to create session: failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with status exit status: 71: sandbox-exec: execvp() of '/opt/example/codex' failed: Operation not permitted",
  ],
  ...["mkdir", "rmdir"].map((operation) => [
    `Claude ${operation}`,
    `API Error: EPERM: operation not permitted, ${operation} '/home/example/.config/anthropic/credentials.lock'`,
  ]),
];
