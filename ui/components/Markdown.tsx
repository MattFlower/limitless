// A tiny, dependency-free Markdown renderer. It never touches innerHTML — every node is built
// through Solid JSX, so there is no way for artifact content to inject markup.
import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";

type Block =
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "hr" };

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const [, hashes, rest] = heading;
      blocks.push({ kind: "h", level: (hashes ?? "#").length as 1 | 2 | 3, text: (rest ?? "").trim() });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        rows.push(splitRow(lines[i] as string));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const ulItem = line.match(/^\s*[-*]\s+(.*)$/);
    if (ulItem) {
      const items: string[] = [(ulItem[1] ?? "").trim()];
      i++;
      while (i < lines.length) {
        const m = (lines[i] ?? "").match(/^\s*[-*]\s+(.*)$/);
        if (!m) break;
        items.push((m[1] ?? "").trim());
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    const olItem = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (olItem) {
      const items: string[] = [(olItem[1] ?? "").trim()];
      i++;
      while (i < lines.length) {
        const m = (lines[i] ?? "").match(/^\s*\d+[.)]\s+(.*)$/);
        if (!m) break;
        items.push((m[1] ?? "").trim());
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() && !(lines[i] ?? "").match(/^(#{1,3})\s+/)) {
      para.push((lines[i] ?? "").trim());
      i++;
    }
    blocks.push({ kind: "p", text: para.join(" ") });
  }
  return blocks;
}

/** Inline `code` and **bold**, single pass, non-nested — plenty for our own generated artifacts. */
function renderInline(text: string): JSX.Element[] {
  const parts: JSX.Element[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    if (m.index > last) parts.push(<span>{text.slice(last, m.index)}</span>);
    const token = m[0];
    if (token.startsWith("`")) parts.push(<code>{token.slice(1, -1)}</code>);
    else parts.push(<strong>{token.slice(2, -2)}</strong>);
    last = m.index + token.length;
    m = re.exec(text);
  }
  if (last < text.length) parts.push(<span>{text.slice(last)}</span>);
  return parts;
}

export const Markdown: Component<{ text: string }> = (props) => {
  const blocks = () => parseMarkdown(props.text);
  return (
    <div class="markdown">
      <For each={blocks()}>
        {(b) => {
          if (b.kind === "h") {
            if (b.level === 1) return <h1>{renderInline(b.text)}</h1>;
            if (b.level === 2) return <h2>{renderInline(b.text)}</h2>;
            return <h3>{renderInline(b.text)}</h3>;
          }
          if (b.kind === "p") return <p>{renderInline(b.text)}</p>;
          if (b.kind === "ul")
            return (
              <ul>
                <For each={b.items}>{(it) => <li>{renderInline(it)}</li>}</For>
              </ul>
            );
          if (b.kind === "ol")
            return (
              <ol>
                <For each={b.items}>{(it) => <li>{renderInline(it)}</li>}</For>
              </ol>
            );
          if (b.kind === "code")
            return (
              <pre>
                <code>{b.text}</code>
              </pre>
            );
          if (b.kind === "hr") return <hr />;
          return (
            <table>
              <thead>
                <tr>
                  <For each={b.header}>{(h) => <th>{h}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={b.rows}>
                  {(row) => (
                    <tr>
                      <For each={row}>{(c) => <td>{renderInline(c)}</td>}</For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          );
        }}
      </For>
      <Show when={blocks().length === 0}>
        <p class="text-faint">(empty)</p>
      </Show>
    </div>
  );
};
