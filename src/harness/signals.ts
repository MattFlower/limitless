import type { AgentEvent } from "./types.ts";

const unquote = (s: string) => {
  const value = s.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return s.startsWith('"') ? value.replace(/\\(["\\$`])/g, "$1") : value;
};
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\2(?:\n|$)/g;
const SH = /^(?:ba|z|da|k)?sh$/;
const JS = /^(?:node|bun|nodejs)$/;
const jsSignal = (code: string) =>
  /(?<![\w$.])process\s*\.\s*kill\s*\(/.test(
    code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""),
  );

/** Advisory recognition of ordinary executable forms, not a shell/JavaScript security analyzer. */
export function signalCommand(command: string, depth = 0): boolean {
  if (depth > 6) return false;
  let found = false;
  // A heredoc is code only when fed to an interpreter; anything else (cat > file) is literal data.
  command = command.replace(HEREDOC, (_, _q, _d, rest: string, body: string, at: number) => {
    // The command word of the segment holding `<<`, after any VAR=value assignments.
    const head = /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(\S*)[^;&|(\n]*$/.exec(command.slice(0, at))?.[1] ?? "";
    const base = head.replace(/.*\//, "");
    found ||= SH.test(base) ? signalCommand(body, depth + 1) : JS.test(base) && jsSignal(body);
    return `${rest}\n`;
  });
  if (found) return true;
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
    const code = (flag: RegExp) => {
      // Skip interpreter options (and the values of those that take one) up to the code argument.
      for (let j = i + 1; tokens[j]?.startsWith("-"); j++) {
        if (flag.test(tokens[j] ?? "")) return unquote(tokens[j + 1] ?? "");
        if (/^(?:-[roO]|--require|--import|--loader)$/.test(tokens[j] ?? "")) j++;
      }
      return "";
    };
    if (SH.test(name) && signalCommand(code(/^-[a-z]*c[a-z]*$/), depth + 1)) return true;
    if (JS.test(name) && jsSignal(code(/^(?:-[ep]|--eval|--print)$/))) return true;
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
