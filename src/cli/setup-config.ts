import { tomlValue } from "../router/config-catalog.ts";

type Statement = { table: string[]; key?: string; path?: string[]; text: string };
const segment = String.raw`(?:[\w-]+|"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*')`;
const key = `${segment}(?:[ \\t]*\\.[ \\t]*${segment})*`;
const tableHeader = new RegExp(
  `^\\s*(?:\\[\\[[ \\t]*(${key})[ \\t]*\\]\\]|\\[[ \\t]*(${key})[ \\t]*\\])\\s*(?:#.*)?(?:\\r?\\n)?$`,
);
const keyAssignment = new RegExp(`^\\s*(${key})\\s*=`);

function keyPath(key: string): string[] {
  // Let TOML decode quoted segments and escapes without losing literal dots.
  let value: unknown = Bun.TOML.parse(`${key} = 0`);
  const path: string[] = [];
  while (typeof value === "object" && value !== null) {
    const entry = Object.entries(value)[0];
    if (!entry) throw new Error("Cannot patch config.toml; fix TOML syntax");
    path.push(entry[0]);
    value = entry[1];
  }
  return path;
}
const inTable = (p: Statement, name: string) => p.table.length === 1 && p.table[0] === name;
const hasKey = (p: Statement, ...keys: string[]) => {
  const path = p.path ? p.table.concat(p.path) : [];
  return path.length === keys.length && path.every((segment, i) => segment === keys[i]);
};

/** Keep original statements intact, including multiline values and comments. */
function statements(text: string): Statement[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: Statement[] = [];
  let table: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    const header = tableHeader.exec(line);
    if (header) table = keyPath(header[1] ?? header[2] ?? "");
    const assignment = keyAssignment.exec(line);
    if (assignment) {
      while (true) {
        try {
          Bun.TOML.parse(line);
          break;
        } catch {
          if (++i >= lines.length) throw new Error("Cannot patch config.toml; fix TOML syntax");
          line += lines[i];
        }
      }
    }
    const key = assignment?.[1];
    result.push({ table, key, path: key === undefined ? undefined : keyPath(key), text: line });
  }
  return result;
}
const assignments = (value: object) =>
  Object.entries(value)
    .map(([k, v]) => `${tomlValue(k)} = ${tomlValue(v)}\n`)
    .join("");

/** Find an inline member's delimiter without treating string or nested-value commas as separators. */
function inlineValueEnd(text: string, start: number): { end: number; delimiter: number } {
  let depth = 0,
    end = start;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length;
      while (i < text.length && !text.startsWith(quote, i)) {
        if (c === '"' && text[i] === "\\") i++;
        i++;
      }
      i += quote.length - 1;
      if (quote.length === 3) for (let extra = 0; extra < 2 && text[i + 1] === c; extra++) i++;
    } else if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    } else if (depth === 0 && (c === "," || c === "}")) return { end, delimiter: i };
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if (c && !/\s/.test(c)) end = i + 1;
  }
  throw new Error("Cannot patch inline github table; fix TOML syntax");
}

function skipTrivia(text: string, start: number): number {
  while (start < text.length) {
    if (/\s/.test(text[start] ?? "")) start++;
    else if (text[start] === "#") {
      while (start < text.length && text[start] !== "\n") start++;
    } else break;
  }
  return start;
}

function patchInlineGithub(text: string, github: Record<string, unknown>): string {
  const current = (Bun.TOML.parse(text) as { github: Record<string, unknown> }).github;
  const changes = ["repos", "merge"].filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(github[key]),
  );
  if (!changes.length) return text;
  const assignment = keyAssignment.exec(text);
  const open = text.indexOf("{", assignment?.[0].length);
  const edits: { start: number; end: number; value: string }[] = [];
  let cursor = open + 1;
  let insertion = cursor;
  let members = 0;
  while (true) {
    cursor = skipTrivia(text, cursor);
    if (text[cursor] === "}") break;
    const member = keyAssignment.exec(text.slice(cursor));
    if (!member) throw new Error("Cannot patch inline github table; fix TOML syntax");
    const path = keyPath(member[1] ?? "");
    const start = skipTrivia(text, cursor + member[0].length);
    const { delimiter, end } = inlineValueEnd(text, start);
    if (path.length === 1 && changes.includes(path[0] ?? "")) {
      const key = path[0] ?? "";
      edits.push({ start, end, value: tomlValue(github[key]) });
      changes.splice(changes.indexOf(key), 1);
    }
    insertion = end;
    members++;
    if (text[delimiter] === "}") break;
    cursor = delimiter + 1;
  }
  if (changes.length)
    edits.push({
      start: insertion,
      end: insertion,
      value: `${members ? ", " : " "}${changes.map((key) => `${key} = ${tomlValue(github[key])}`).join(", ")}`,
    });
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}

export function patchSetupConfig(
  original: string,
  github: Record<string, unknown>,
  entries: Record<string, unknown>[],
  added: string[],
  convert: boolean,
): string {
  const parts = statements(original);
  const githubInline = parts.find((p) => hasKey(p, "github"));
  if (githubInline) githubInline.text = patchInlineGithub(githubInline.text, github);
  else {
    const missing: Record<string, unknown> = {};
    for (const key of ["repos", "merge"]) {
      const part = parts.find((p) => hasKey(p, "github", key));
      if (!part) missing[key] = github[key];
      else {
        const value = Bun.TOML.parse(part.text) as Record<string, unknown>;
        const current = part.table.length === 0 ? (value.github as Record<string, unknown>)[key] : value[key];
        if (JSON.stringify(current) !== JSON.stringify(github[key])) {
          const comment = /\s+#.*(?:\r?\n)?$/.exec(part.text)?.[0] ?? "\n";
          part.text = `${part.key} = ${tomlValue(github[key])}${comment}`;
        }
      }
    }
    const at = parts.findIndex((p) => inTable(p, "github"));
    if (Object.keys(missing).length) {
      if (at >= 0) {
        const end = parts.findIndex((p, i) => i > at && !inTable(p, "github"));
        parts.splice(end < 0 ? parts.length : end, 0, {
          table: ["github"],
          text: `\n${assignments(missing)}`,
        });
      } else if (parts.some((p) => p.table.length === 0 && p.path?.[0] === "github")) {
        parts.unshift({
          table: [],
          text: Object.entries(missing)
            .map(([k, v]) => `github.${k} = ${tomlValue(v)}\n`)
            .join(""),
        });
      } else parts.push({ table: ["github"], text: `\n[github]\n${assignments(missing)}` });
    }
  }
  const providersInline = parts.find((p) => hasKey(p, "providers"));
  if (providersInline && !convert && added.length) {
    const additions = entries
      .filter((p) => added.includes(String(p.id ?? p.preset)))
      .map(tomlValue)
      .join(", ");
    let patched = false;
    for (const separator of [",", ""]) {
      const text = providersInline.text.replace(
        /\](\s*(?:#.*)?(?:\r?\n)?)$/,
        (_, tail: string) => `${separator}\n${additions}\n]${tail}`,
      );
      try {
        const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
        if (!Array.isArray(parsed.providers) || parsed.providers.length !== entries.length) continue;
        providersInline.text = text;
        patched = true;
        break;
      } catch {
        /* An existing array may already have a trailing comma. */
      }
    }
    if (!patched) throw new Error("Cannot patch providers; check config.toml array formatting");
  }
  const kept = parts.map((p) => {
    const owned = p.table[0] === "providers" || (p.table.length === 0 && p.path?.[0] === "providers");
    if (!convert || !owned || (!p.key && !p.text.trimStart().startsWith("["))) return p.text;
    const comment = /(?:^|\s)(#[^\n]*)(?:\r?\n)?$/.exec(p.text)?.[1];
    return comment ? `${comment}\n` : "";
  });
  let text = kept.join("");
  if (!providersInline || convert)
    for (const p of entries.filter((p) => convert || added.includes(String(p.id ?? p.preset))))
      text += `\n[[providers]]\n${assignments(p)}`;
  return text;
}
