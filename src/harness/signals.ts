import type { AgentEvent } from "./types.ts";

const unquote = (s: string) => {
  const value = s.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return s.startsWith('"') ? value.replace(/\\(["\\$`])/g, "$1") : value;
};
const jsSignal = (code: string) =>
  /(?<![\w$.])process\s*\.\s*kill\s*\(/.test(
    code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""),
  );

/** Advisory recognition of ordinary executable forms, not a shell/JavaScript security analyzer. */
export function signalCommand(command: string, depth = 0): boolean {
  if (depth > 6) return false;
  command = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\2(?:\n|$)/g, "\n");
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[;&|()\n]+|[^\s;&|()]+/g) ?? [];
  let start = true;
  let piped = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (/^[;&|()\n]+$/.test(token)) {
      start = true;
      piped = false;
      continue;
    }
    const name = unquote(token).split("/").at(-1) ?? "";
    if (token.startsWith("#")) {
      while (i < tokens.length && !tokens[i]?.includes("\n")) i++;
      start = true;
      continue;
    }
    if (!start) continue;
    if (name === "xargs") {
      piped = true;
      continue;
    }
    if (piped && /^(?:-n|-P|-I|-L)$/.test(token)) {
      i++;
      continue;
    }
    if (
      /^(?:exec|command|env|sudo|nohup|xargs|if|then|do|!)$/.test(name) ||
      /^\w+=/.test(token) ||
      token.startsWith("-")
    )
      continue;
    start = false;
    if (/^(?:pkill|killall)$/.test(name)) return true;
    const end = tokens.findIndex((t, n) => n > i && /^[;&|()\n]+$/.test(t));
    const operands = tokens.slice(i + 1, end < 0 ? undefined : end);
    if (
      name === "kill" &&
      !operands.some((t) => /^-[lL]$/.test(t)) &&
      (piped || operands.some((t) => /^-?(?:\d+$|[$%])/.test(unquote(t))))
    )
      return true;
    if (/^(?:ba|z|da|k)?sh$/.test(name)) {
      const flag = tokens[i + 1] ?? "";
      if (/^-[a-z]*c[a-z]*$/.test(flag) && signalCommand(unquote(tokens[i + 2] ?? ""), depth + 1))
        return true;
    }
    if (/^(?:node|bun|nodejs)$/.test(name)) {
      const flag = tokens[i + 1] ?? "";
      if (/^(?:-[ep]|--eval|--print)$/.test(flag) && jsSignal(unquote(tokens[i + 2] ?? ""))) return true;
    }
  }
  return false;
}
/** Emit once per tool id, including denied calls; never copy command contents into a warning. */
export function signalWarnings(emit: (event: AgentEvent) => void): (event: AgentEvent) => void {
  const seen = new Set<string>();
  return (event) => {
    emit(event);
    if (event.type !== "tool_call" || seen.has(event.id)) return;
    seen.add(event.id);
    const input = event.input as { command?: unknown; code?: unknown; cmd?: unknown } | null;
    const command = input?.command ?? input?.cmd;
    const detected = /^(?:Bash|shell|exec_command)$/.test(event.name)
      ? typeof command === "string" && signalCommand(command)
      : /(?:^|\.)(?:node_repl|js)$/.test(event.name) &&
        typeof input?.code === "string" &&
        jsSignal(input.code);
    if (detected) emit({ type: "warning", id: event.id, text: "Process signal attempt detected." });
  };
}
