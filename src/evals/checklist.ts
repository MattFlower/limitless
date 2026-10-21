import { redactCredentials } from "../util/proc.ts";

export { ChecklistReviewSchema } from "../pipeline/schemas.ts";

export const CHECKLIST_CAP = 12_000;

/** Only base AGENTS.md is accepted by the caller; never substitute a checkout's rules. */
export function checklistPrompt(source: string | null): string {
  if (source === null) throw new Error("adversarial-checklist: missing base AGENTS.md");
  const bullets: { section: string; text: string }[] = [];
  let section = "";
  let fence = "";
  let current: (typeof bullets)[number] | undefined;
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    const fenced = !!fence;
    if (!fence && delimiter) fence = delimiter;
    else if (fence && new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = "";
    if (!fenced && !delimiter) {
      const heading = /^#{1,6} (.+?)\s*$/.exec(line);
      if (heading) {
        section = heading[1] ?? "";
        current = undefined;
      } else if (/^- /.test(line)) {
        current = { section, text: line.slice(2) };
        bullets.push(current);
        continue;
      } else if (line && !/^\s/.test(line)) current = undefined;
    }
    if (current) current.text += `\n${line}`;
  }
  const defects = bullets.filter((b) => b.section === "Defects reviews keep finding");
  const privacy = bullets.filter((b) => {
    const text = b.text.replace(/\s+/g, " ");
    return (
      b.section === "Privacy" &&
      /decode before (?:you )?redact/.test(text) &&
      /redact before (?:you )?truncate/.test(text)
    );
  });
  if (!defects.length || !privacy.length)
    throw new Error(
      "adversarial-checklist: base AGENTS.md requires recurring-defect bullets and Privacy redaction ordering",
    );
  const items = bullets.flatMap((b) => {
    const group = defects.includes(b) ? defects : privacy.includes(b) ? privacy : [];
    return group.length
      ? [`[${group === defects ? "defect" : "privacy"}-${group.indexOf(b) + 1}] ${b.text.trimEnd()}`]
      : [];
  });
  const included: string[] = [];
  for (const item of items) {
    const text = redactCredentials(item);
    if ([...included, text].join("\n\n").length > CHECKLIST_CAP) break;
    included.push(text);
  }
  const content = included.join("\n\n");
  const safeFence = "`".repeat(Math.max(3, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length + 1)));
  return `\n\nApply every included base AGENTS.md item below to the diff. Return one checklist entry per item: item is its bracketed source identifier; applies identifies relevant changed hunks (explicitly say non-applicable otherwise); checked describes the concrete command, traced path or input tried and its result, or explicitly says none. Give each emitted finding a unique id; checklist.finding links to that id or null. Applicability or a pattern match alone never justifies a blocking finding. Checklist claims are reviewer-reported evidence, not verified execution or grading credit.
${safeFence}text
${content}
${safeFence}
Checklist cap: ${CHECKLIST_CAP} characters; omitted ${items.length - included.length} whole items.\n`;
}
