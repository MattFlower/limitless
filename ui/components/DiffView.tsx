import type { Component } from "solid-js";
import { For, Show } from "solid-js";

interface DiffLine {
  kind: "add" | "del" | "hunk" | "ctx" | "meta";
  text: string;
}
interface DiffFile {
  header: string;
  lines: DiffLine[];
}

function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(.+)$/);
      current = { header: m?.[1] ?? line, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      current = { header: "(patch)", lines: [] };
      files.push(current);
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ")) continue;
    if (line.startsWith("@@")) current.lines.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) current.lines.push({ kind: "add", text: line });
    else if (line.startsWith("-")) current.lines.push({ kind: "del", text: line });
    else current.lines.push({ kind: "ctx", text: line });
  }
  return files;
}

export const DiffView: Component<{ patch: string }> = (props) => {
  const files = () => parseDiff(props.patch);
  return (
    <div class="diff card">
      <Show when={files().length > 0} fallback={<div class="card-pad text-faint mono">(empty diff)</div>}>
        <For each={files()}>
          {(f) => (
            <div>
              <div class="diff-file">{f.header}</div>
              <pre>
                <For each={f.lines}>
                  {(l) => <div class={`diff-line diff-${l.kind}`}>{l.text || " "}</div>}
                </For>
              </pre>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};
