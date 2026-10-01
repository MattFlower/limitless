import type { Spec } from "./schemas.ts";

// Deliberately bounded scope phrases, shared by request exemptions and spec validation.
// Normalize punctuation (including hyphens) and whitespace; do not classify general prose.
const phrases = [
  /\b(?:specification|spec|documentation|docs) only\b/,
  /\bonly (?:write|produce|update) (?:the )?(?:specification|documentation|docs)\b/,
  /\b(?:do not|don t|must not) (?:modify|edit|change|write) (?:any |the |source |production )?code\b/,
  /\b(?:no|without(?: any)?) code (?:changes|modifications|edits)\b/,
  /\bcode (?:changes|modifications|edits) (?:are )?(?:forbidden|prohibited|not allowed)\b/,
  /\bdo not modify anything\b/,
];

function restricted(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ");
  return phrases.some((phrase) => phrase.test(normalized));
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
