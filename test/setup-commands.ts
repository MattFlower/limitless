import { assertReadOnlyCommand as assertExistingCommand } from "./fixtures/setup-commands.ts";

export function assertReadOnlyCommand(args: string[]): void {
  if (args.join(" ") !== "gh api user") assertExistingCommand(args);
}
