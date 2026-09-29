import type { DecisionAnswer, DecisionTask } from "../harness/decisions.ts";
import { ComplexityEnum, TaskClassEnum, type Triage } from "./schemas.ts";

type Level = "low" | "medium" | "high";
const LEVELS: readonly Level[] = ["low", "medium", "high"];

const TASK_CLASSES: Record<Triage["task_class"], string> = {
  dependency_update:
    "Update, bump or pin third-party dependency versions (for example a Dependabot pull request)",
  bugfix: "Fix behavior that is broken, crashes or gives wrong results",
  feature: "Add new behavior, a new capability or a new option",
  refactor: "Restructure or rename existing code without changing its behavior",
  docs: "Change only documentation, comments or README text",
  test: "Add or fix tests only, without changing product code",
  chore: "Build, CI, tooling, configuration or repository housekeeping",
  question: "Ask for information or an explanation rather than a code change",
};

/** Today's profile rule from the triage prompt: large or risky → deep, trivial → quick. */
export function suggestedProfile(t: Pick<Triage, "complexity" | "risk">): Triage["suggested_profile"] {
  if (t.complexity === "large" || t.risk === "high") return "deep";
  return t.complexity === "trivial" ? "quick" : "standard";
}

function answer<T extends DecisionAnswer["type"]>(
  answers: Record<string, DecisionAnswer>,
  id: string,
  type: T,
): Extract<DecisionAnswer, { type: T }> {
  const value = answers[id];
  if (value?.type !== type) throw new Error(`missing ${type} answer for ${id}`);
  return value as Extract<DecisionAnswer, { type: T }>;
}

function level<T extends string>(
  answers: Record<string, DecisionAnswer>,
  id: string,
  levels: readonly T[],
): T {
  const value = levels[answer(answers, id, "score").level];
  if (value === undefined) throw new Error(`score out of range for ${id}`);
  return value;
}

/**
 * Triage as typed questions for a decision model. The model cannot write text, so the title and
 * summary come from the request, `suggested_profile` from the rule above, and it declines — letting
 * routing fall through to an LLM that can write blocking questions — when unsure or when questions
 * are likely needed.
 */
export function triageDecisions(
  input: { repoSlug: string; prompt: string; tree: string },
  minConfidence: number,
): DecisionTask {
  const request = input.prompt.trim();
  return {
    state: { repository: input.repoSlug, top_level_entries: input.tree, request },
    questions: {
      task_class: {
        type: "choice",
        instructions: "Which kind of software task does `request` ask for?",
        criteria: TASK_CLASSES,
      },
      complexity: {
        type: "score",
        instructions: "How much implementation work does `request` need?",
        criteria: [
          "Trivial: a mechanical one-line change such as a version bump or a typo fix",
          "Small: a focused change in one to three files",
          "Medium: a feature or fix spanning several files",
          "Large: architectural or multi-component work",
        ],
      },
      risk: {
        type: "score",
        instructions:
          "If the change asked for in `request` were implemented wrongly, how large would the damage be? Judge the blast radius, not the size of the change.",
        criteria: [
          "Low: self-contained features, documentation or tests",
          "Medium: behavior that much of the system depends on, such as the core pipeline, persistence, migrations or concurrency",
          "High: authentication or authorization (who may trigger or approve what), secrets or credentials, exposing something publicly, merge, deploy or review policy, deleting data or rewriting history, or spending money",
        ],
      },
      ambiguity: {
        type: "score",
        instructions: "How much does `request` leave for the requester to decide?",
        criteria: [
          "Nothing essential: an implementer can proceed, settling open details with reasonable assumptions",
          "It states its goal but leaves a choice between substantially different outcomes that an implementer would have to guess",
          'Everything: a sensible implementation is impossible without an answer from the requester, including requests that name no concrete outcome (for example "make it better")',
        ],
      },
      needs_questions: {
        type: "noul",
        instructions:
          "`request` cannot be implemented sensibly until the requester answers a question, for example because it names no concrete outcome.",
        criteria: {
          true: "No concrete outcome is named, or only the requester can make a decision that changes what gets built",
          false:
            "The outcome is clear enough to start; open details can be settled with reasonable assumptions",
        },
      },
    },
    interpret(answers): Triage {
      const complexity = level(answers, "complexity", ComplexityEnum.options);
      const risk = level(answers, "risk", LEVELS);
      const title =
        request
          .split("\n")[0]
          ?.replace(/^#+\s*/, "")
          .trim()
          .slice(0, 80) || "Request";
      return {
        title,
        task_class: TaskClassEnum.parse(answer(answers, "task_class", "choice").choice),
        complexity,
        risk,
        ambiguity: level(answers, "ambiguity", LEVELS),
        blocking_questions: [],
        summary: request
          .replace(/^#+\s*/gm, "")
          .replace(/\s+/g, " ")
          .slice(0, 300),
        suggested_profile: suggestedProfile({ complexity, risk }),
      };
    },
    decline(answers) {
      const unsure = Object.entries(answers).flatMap(([id, a]) =>
        a.type !== "noul" && a.confidence < minConfidence ? [`${id} ${a.confidence.toFixed(2)}`] : [],
      );
      const questions = answer(answers, "needs_questions", "noul").noul;
      const reasons = [
        ...(unsure.length ? [`confidence below ${minConfidence} (${unsure.join(", ")})`] : []),
        ...(questions >= 0.5 ? [`blocking questions likely (P=${questions.toFixed(2)})`] : []),
        ...(level(answers, "ambiguity", LEVELS) === "high" ? ["ambiguity high"] : []),
      ];
      return reasons.length ? reasons.join("; ") : null;
    },
  };
}
