import type { AgentEvent } from "./types.ts";

const unquote = (s: string) => {
  return s.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, double: string | undefined, single: string) =>
    double === undefined ? single : double.replace(/\\(["\\$`])/g, "$1"),
  );
};
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\2(?:\n|$)/g;
const SH = /^(?:ba|z|da|k)?sh$/;
const JS = /^(?:node|bun|nodejs)$/;
const WRAPPERS = new Map([
  ["timeout", /^(?:-[ks]|--kill-after|--signal)$/],
  ["nice", /^(?:-n|--adjustment)$/],
  ["time", /^(?:-[fo]|--format|--output)$/],
  ["watch", /^(?:-n|--interval)$/],
  ["stdbuf", /^(?:-[ioe]|--input|--output|--error)$/],
]);
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
  const tokens = command.match(/(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()"'])+|[;&|()\n]+/g) ?? [];
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
    if (name === "command" && /^-[vV]$/.test(tokens[i + 1] ?? "")) {
      start = false;
      continue;
    }
    const takesValue = WRAPPERS.get(name);
    if (takesValue) {
      while (tokens[i + 1]?.startsWith("-")) {
        const option = tokens[++i] ?? "";
        if (option === "--") break;
        if (takesValue.test(option)) i++;
      }
      if (name === "timeout") i++; // The duration precedes the wrapped command.
      continue;
    }
    if (name === "xargs") {
      piped = true;
      continue;
    }
    if (piped && /^(?:-n|-P|-I|-L|-a|-d|-E|-s)$/.test(token)) {
      i++;
      continue;
    }
    if (
      /^(?:exec|command|env|sudo|nohup|xargs|if|then|do|!|\{|\})$/.test(name) ||
      /^\w+=/.test(token) ||
      token.startsWith("-")
    )
      continue;
    start = false;
    if (/^(?:pkill|killall)$/.test(name)) return true;
    const end = tokens.findIndex((t, n) => n > i && /^[;&|()\n]+$/.test(t));
    const operands = tokens.slice(i + 1, end < 0 ? undefined : end).map(unquote);
    if (
      name === "kill" &&
      !operands.some((t) => /^-[lL]$/.test(t)) &&
      !operands.some(
        (t, n) =>
          /^(?:-0|-s0|--signal=0)$/.test(t) || (/^(?:-s|--signal)$/.test(t) && operands[n + 1] === "0"),
      ) &&
      (piped || operands.some((t) => /^-?(?:\d+$|[$%])/.test(t)))
    )
      return true;
    const code = (flag: RegExp) => {
      // Skip interpreter options (and the values of those that take one) up to the code argument.
      for (let j = i + 1; tokens[j]?.startsWith("-"); j++) {
        const option = unquote(tokens[j] ?? "");
        const equals = option.indexOf("=");
        if (equals >= 0 && flag.test(option.slice(0, equals))) return option.slice(equals + 1);
        if (flag.test(option)) return unquote(tokens[j + 1] ?? "");
        if (/^(?:-[roO]|--require|--import|--loader)$/.test(option)) j++;
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
