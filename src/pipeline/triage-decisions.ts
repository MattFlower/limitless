import type { DecisionAnswer, DecisionTask } from "../harness/decisions.ts";
import { ISSUE_PREFACE, unquoteGitHub } from "../integrations/github.ts";
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
// HTML tags GitHub renders; other angle brackets (`Map<K, V>`) are text.
const TAG =
  /<\/?(?:a|b|i|em|strong|code|pre|p|br|hr|ul|ol|li|h[1-6]|blockquote|div|span|img|sub|sup|kbd|summary|table|thead|tbody|tr|td|th)\b[^>\n]*>/gi;

/** Markdown or HTML as text: no comments, collapsed `<details>` (release notes, logs), tags or link targets. */
function plainText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details\b[\s\S]*?<\/details>/gi, "")
    .replace(TAG, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ENTITIES[entity] ?? "")
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The request as the decision model sees it, since the model degrades with indirection and
 * irrelevant state: GitHub prompts come out of their quoted JSON, a comment's request is kept apart
 * from the issue it comments on, and markup and collapsed sections are dropped. `text` feeds the summary.
 */
export function condenseRequest(prompt: string): {
  state: Record<string, unknown>;
  title: string;
  text: string;
} {
  const quoted = unquoteGitHub(prompt);
  const field = (key: string) => {
    const value = quoted?.data[key];
    return typeof value === "string" ? value : "";
  };
  if (quoted && typeof quoted.data.request === "string") {
    const request = quoted.data.request.trim();
    const issue = { title: field("issueTitle"), body: plainText(field("issueBody")) };
    return { state: { request, issue }, title: request.split("\n")[0] ?? "", text: request };
  }
  if (quoted) {
    const { preface } = quoted;
    const title = field("title");
    const body = plainText(field("body"));
    const instruction = preface && preface !== ISSUE_PREFACE ? { instruction: preface } : {};
    return { state: { request: { ...instruction, title, body } }, title, text: `${title}\n${body}` };
  }
  const [first = "", ...rest] = prompt.trim().split("\n");
  const title = first.replace(/^#+\s*/, "").trim();
  const body = plainText(rest.join("\n"));
  return { state: { request: body ? { title, body } : title }, title, text: prompt.trim() };
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
  const request = condenseRequest(input.prompt);
  return {
    state: { repository: input.repoSlug, top_level_entries: input.tree, ...request.state },
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
          "Trivial: a mechanical edit with nothing to design, such as a version bump, a typo fix or changing one value",
          "Small: a focused change to one component and its tests, such as a single bug fix, a new option or command, tests for one function, or answering a question about the code",
          "Medium: a feature or fix spanning several components that must change together, such as storage, core logic and the API or UI that use it",
          "Large: architectural work, such as a new subsystem, a move to another platform or database, or a rewrite across many components",
        ],
      },
      risk: {
        type: "score",
        instructions:
          "Suppose the work asked for in `request` is done wrongly. How much harm could the mistake do? Judge what the work touches, not how much work it is.",
        criteria: [
          "Contained: the mistake stays in one place, for example a question answered without code changes, a dependency version bump, documentation, tests, CI checks, removing unused code, a command-line option or its output, a UI page or a self-contained feature",
          "Wide: the mistake breaks something much of the system relies on, for example the core pipeline or scheduler, stored data or database migrations, concurrency or recovery after a restart",
          "Severe: the mistake is a security or safety failure, for example who may access, trigger or approve something, secrets or credentials, exposing a service publicly, the rules for merging, deploying or reviewing changes, deleting data or rewriting git history, or spending money",
        ],
      },
      ambiguity: {
        type: "score",
        instructions: "How much does `request` leave for the requester to decide?",
        criteria: [
          "Clear: `request` names what to build, change or explain; the details it leaves open, such as names, flags, defaults or file layout, can be settled with reasonable assumptions",
          "Open choice: `request` names a goal, but reaching it means choosing between substantially different outcomes or designs that only the requester can settle, and a wrong guess would have to be redone",
          'Unclear: `request` names no concrete outcome (for example "make it better" or "make it faster"), or it cannot be implemented sensibly without an answer from the requester',
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
      const title = request.title.trim().slice(0, 80) || "Request";
      return {
        title,
        task_class: TaskClassEnum.parse(answer(answers, "task_class", "choice").choice),
        complexity,
        risk,
        ambiguity: level(answers, "ambiguity", LEVELS),
        blocking_questions: [],
        summary: request.text
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
      const unclear = level(answers, "ambiguity", LEVELS) === "high";
      const reasons = [
        ...(unsure.length ? [`confidence below ${minConfidence} (${unsure.join(", ")})`] : []),
        ...(questions >= 0.5 ? [`blocking questions likely (P=${questions.toFixed(2)})`] : []),
        ...(unclear ? ["ambiguity high"] : []),
      ];
      // A request that needs questions must reach a model that can write them, or a human.
      return reasons.length ? { reason: reasons.join("; "), lastResort: questions < 0.5 && !unclear } : null;
    },
  };
}
