export type SlottedCommands = string[][];

/** Parse command prefixes as argv, including quoted tokens; never interpret shell operators. */
export function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "",
    quote = "",
    started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (c === "\\" && quote !== "'") {
      const next = command[++i];
      if (next === undefined) throw new Error("unfinished escape");
      token += next;
      started = true;
    } else if (quote) {
      if (c === quote) quote = "";
      else token += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      if (/[;&|<>`$]/.test(c) || c < " ") throw new Error("expected argv prefix, not shell syntax");
      token += c;
      started = true;
    }
  }
  if (quote) throw new Error("unfinished quote");
  if (started) tokens.push(token);
  return tokens;
}

export function readSlottedCommands(
  contents: string | null,
  warn: (message: string) => void,
): SlottedCommands {
  if (contents === null) return [];
  try {
    const raw = Bun.TOML.parse(contents) as { limits?: { slotted_commands?: unknown } };
    const commands = raw.limits?.slotted_commands;
    if (commands === undefined) return [];
    if (!Array.isArray(commands)) throw new Error("expected an array of command strings");
    return commands.map((command: unknown) => {
      if (typeof command !== "string" || !command.trim())
        throw new Error("expected nonempty command strings");
      const argv = commandTokens(command);
      const executable = argv[0];
      if (!executable || executable === "." || executable === ".." || !/^[\w.+-]+$/.test(executable))
        throw new Error("executable must be a name without path separators");
      return argv;
    });
  } catch {
    warn("Invalid [limits].slotted_commands; agent command slotting is disabled");
    return [];
  }
}
