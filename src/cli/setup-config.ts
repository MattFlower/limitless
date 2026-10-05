import { tomlValue } from "../router/config-catalog.ts";

/** Keep original statements intact, including multiline values and comments. */
function statements(text: string): { table: string; key?: string; text: string }[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: { table: string; key?: string; text: string }[] = [];
  let table = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    const header = /^\s*\[\[?(.+?)\]\]?\s*(?:#.*)?(?:\r?\n)?$/.exec(line);
    if (header) table = header[1]?.replace(/["']/g, "").trim() ?? "";
    const assignment = /^\s*((?:"[^"\n]+"|'[^'\n]+'|[\w.-]+))\s*=/.exec(line);
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
    result.push({ table, key: assignment?.[1]?.replace(/^["']|["']$/g, ""), text: line });
  }
  return result;
}
const assignments = (value: object) =>
  Object.entries(value)
    .map(([k, v]) => `${tomlValue(k)} = ${tomlValue(v)}\n`)
    .join("");

export function patchSetupConfig(
  original: string,
  github: Record<string, unknown>,
  entries: Record<string, unknown>[],
  added: string[],
  convert: boolean,
): string {
  const parts = statements(original);
  const githubInline = parts.find((p) => p.table === "" && p.key === "github");
  if (githubInline) githubInline.text = `github = ${tomlValue(github)}\n`;
  else {
    const missing: Record<string, unknown> = {};
    for (const key of ["repos", "merge"]) {
      const part = parts.find(
        (p) => (p.table === "github" && p.key === key) || (p.table === "" && p.key === `github.${key}`),
      );
      if (!part) missing[key] = github[key];
      else {
        const value = Bun.TOML.parse(part.text) as Record<string, unknown>;
        const current = part.table === "" ? (value.github as Record<string, unknown>)[key] : value[key];
        if (JSON.stringify(current) !== JSON.stringify(github[key])) {
          const comment = /\s+#.*(?:\r?\n)?$/.exec(part.text)?.[0] ?? "\n";
          part.text = `${part.key} = ${tomlValue(github[key])}${comment}`;
        }
      }
    }
    const at = parts.findIndex((p) => p.table === "github");
    if (Object.keys(missing).length) {
      if (at >= 0) {
        const end = parts.findIndex((p, i) => i > at && p.table !== "github");
        parts.splice(end < 0 ? parts.length : end, 0, { table: "github", text: `\n${assignments(missing)}` });
      } else if (parts.some((p) => p.table === "" && p.key?.startsWith("github."))) {
        parts.unshift({
          table: "",
          text: Object.entries(missing)
            .map(([k, v]) => `github.${k} = ${tomlValue(v)}\n`)
            .join(""),
        });
      } else parts.push({ table: "github", text: `\n[github]\n${assignments(missing)}` });
    }
  }
  const providersInline = parts.find((p) => p.table === "" && p.key === "providers");
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
    const owned =
      p.table === "providers" ||
      p.table.startsWith("providers.") ||
      (p.table === "" && (p.key === "providers" || p.key?.startsWith("providers.")));
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
