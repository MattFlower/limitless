export function assertReadOnlyCommand(args: string[]): void {
  const command = args.join(" ");
  if (
    ![
      "git --version",
      "git rev-parse HEAD",
      "gh auth status",
      "claude --version",
      "claude auth status",
      "codex --version",
      "codex login status",
      "python3 --version",
    ].includes(command) &&
    !/^gh api repos\/[\w.-]+\/[\w.-]+ -i$/.test(command)
  )
    throw new Error(`Unexpected command: ${command}`);
}
