import type { Spec } from "./schemas.ts";

// Bounded phrases shared by request exemptions and spec validation; normalize punctuation/whitespace.
// Code bans must end a clause (optionally "in this task"); scoped/compatibility constraints are allowed.
const phrases = [
  /\b(?:specification|spec|documentation|docs) only\b/,
  /\bonly (?:write|produce|update) (?:the )?(?:specification|documentation|docs)\b/,
  /\b(?:do not|don t|must not) (?:modify|edit|change|write) (?:any |the |source |production )?code(?: in this task)?$/,
  /^no code (?:changes|modifications|edits)(?: in this task)?$/,
  /^code (?:changes|modifications|edits) (?:are )?(?:forbidden|prohibited|not allowed)(?: in this task)?$/,
  /\bdo not modify anything(?: in this task)?$/,
];

function restricted(text: string): boolean {
  return text.split(/[.!?;]/).some((clause) => {
    const normalized = clause.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ");
    return phrases.some((phrase) => phrase.test(normalized.trim()));
  });
}

/** Return the original offending sentence for retry feedback, before any spec is persisted. */
export function specScopeViolation(spec: Spec, request: string): string | null {
  if (restricted(request)) return null;
  for (const text of [
    spec.summary,
    ...spec.requirements,
    ...spec.acceptance_criteria.map((a) => a.criterion),
  ]) {
    for (const sentence of text.match(/[^.!?]+[.!?]?/g) ?? []) {
      if (restricted(sentence)) return sentence.trim();
    }
  }
  return null;
}
