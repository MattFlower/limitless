import type { EvalGrade } from "../../src/core/types.ts";
import type { ReviewCase } from "../../src/evals/cases.ts";
import type { Review } from "../../src/pipeline/schemas.ts";

// Development labels preserve the report excerpts and checkout-local provenance. The table below
// deliberately relocates, combines and paraphrases them; these are grader fixtures, not new cases.
export const graderReports = {
  deliveryAuth: {
    paraphrase: "An untrusted API run may force-push main through deliveryBranch.",
    provenance: "evals/review/cases.json: review-001, defects[0]; muis2georfnu round 1; review round 1",
    defect: {
      file: "src/pipeline/engine.ts",
      lines: [116, 118],
      severity: "major",
      category: "security",
      summary:
        "Existing-branch delivery (skip PR, force-push to run.deliveryBranch) is authorized by the mere presence of deliveryBranch; nothing requires the run to come from the signature-verified GitHub/Dependabot webhook. deliveryBranch/baseBranch/sourceRef are accepted verbatim from POST /api/runs (store.ts createRun), so any API caller could get a run force-pushed onto main, bypassing mergePolicy and PR review.",
      required: true,
      foundBy: "review round 1",
    },
  },
  discordError: {
    paraphrase: "Unhandled Discord client errors terminate the daemon.",
    provenance:
      "evals/review/cases.json: review-014, defects[0]; muishhw85816 round 0 (relabelled: not clean); review eval (codex/sol), verified by orchestrator",
    defect: {
      file: "src/integrations/discord.ts",
      lines: [93, 106],
      severity: "major",
      category: "correctness",
      summary: "The discord.js Client has no 'error' listener; an emitted error event can crash the daemon",
      required: true,
      foundBy: "review eval (codex/sol), verified by orchestrator",
    },
  },
  discordEvents: {
    paraphrase: "Events arrive before the thread id is stored and are lost.",
    provenance:
      "evals/review/cases.json: review-014, defects[1]; muishhw85816 round 0 (relabelled: not clean); review eval (codex/sol); confirmed by a failing test in PR #19",
    defect: {
      file: "src/integrations/discord.ts",
      lines: [300, 312],
      severity: "major",
      category: "correctness",
      summary:
        "The run can emit events before its Discord thread id is persisted, so early events are dropped",
      required: true,
      foundBy: "review eval (codex/sol); confirmed by a failing test in PR #19",
    },
  },
  discordSend: {
    paraphrase: "Failed terminal-message sends are marked complete and never retried.",
    provenance:
      "evals/review/cases.json: review-014, defects[2]; muishhw85816 round 0 (relabelled: not clean); review eval (codex/sol); confirmed by a failing test in PR #19",
    defect: {
      file: "src/integrations/discord.ts",
      lines: [220, 228],
      severity: "major",
      category: "correctness",
      summary:
        "The terminal summary is marked delivered before the send succeeds, so a failed send is never retried",
      required: true,
      foundBy: "review eval (codex/sol); confirmed by a failing test in PR #19",
    },
  },
  repoOwner: {
    paraphrase: "An allowed actor can start work for a repository owned by somebody else.",
    provenance:
      "evals/review/cases.json: review-016, defects[0]; muis2georfnu round 2 (PR #4; approved head; R3 D06, D07); blind holdout scenario H-4 in the factory's verify stage (after two approving reviews)",
    defect: {
      file: "src/integrations/github.ts",
      lines: [41, 44],
      severity: "major",
      category: "security",
      summary:
        "mapGitHubEvent checked the actor login but not that repository.full_name belongs to cfg.githubOwner, so an owner action on someone else's repo could start a run.",
      required: true,
      foundBy: "blind holdout scenario H-4 in the factory's verify stage (after two approving reviews)",
    },
  },
  cleanBump: {
    paraphrase: "A clean Dependabot update cannot pass the empty-diff audit.",
    provenance:
      "evals/review/cases.json: review-016, defects[1]; muis2georfnu round 2 (PR #4; approved head; R3 D06, D07); owner, in production during the M4 Dependabot demo (tests only used fakes that 'fixed' something)",
    defect: {
      file: "src/integrations/github.ts",
      lines: [115, 127],
      severity: "blocker",
      category: "spec-mismatch",
      summary:
        "A Dependabot run is a quick 'verify and fix breakages' run; when the bump needs no fix the implementer makes no changes, the audit's empty-diff rule blocks every round, and clean bumps can never succeed",
      required: true,
      foundBy:
        "owner, in production during the M4 Dependabot demo (tests only used fakes that 'fixed' something)",
    },
  },
  quotaStorm: {
    paraphrase: "Each hard-limit rejection sends another alert because its reset boundary moves.",
    provenance:
      "evals/review/cases.json: review-017, defects[0]; muiuv8kp8140 round 1 (PR #6; approved head; R3 D09, D10); factory review round 2 (missed by the round 0 and round 1 reviews)",
    defect: {
      file: "src/router/providers.ts",
      lines: [265, 271],
      severity: "major",
      category: "logic",
      summary:
        "A quota rejection with no known window alerts on window 'hard_limit' with boundary = detail.exhaustedUntil, which codex.ts sets to Date.now()+30min on every rejection, so each rejection creates a new alert (alert storm)",
      required: true,
      foundBy: "factory review round 2 (missed by the round 0 and round 1 reviews)",
    },
  },
  quotaWindow: {
    paraphrase: "The alert uses the first resetting window instead of the exhausted window.",
    provenance:
      "evals/review/cases.json: review-017, defects[1]; muiuv8kp8140 round 1 (PR #6; approved head; R3 D09, D10); review-eval sweep, verified by orchestrator",
    defect: {
      file: "src/router/providers.ts",
      lines: [261, 264],
      severity: "major",
      category: "logic",
      summary:
        "A subscription quota rejection is attributed to the earliest-resetting known window rather than the exhausted one, mislabelling alerts and allowing a duplicate alert after the wrong window resets.",
      required: true,
      foundBy: "review-eval sweep, verified by orchestrator",
    },
  },
  deliveryRebase: {
    paraphrase: "A moving base makes delivery throw away the reviewed work.",
    provenance:
      "evals/review/cases.json: review-018, defects[0]; muiz1bvtxkeo round 3 (PR #12; approved head; R3 D15); orchestrator review (rewrote delivery as best-effort)",
    defect: {
      file: "src/pipeline/engine.ts",
      lines: [700, 716],
      severity: "major",
      category: "error-handling",
      summary:
        "Delivery throws and discards already-reviewed work when the base changed during the rebase, advanced again after the conflict-resolution round, or no longer descends from the recorded base, instead of delivering the checked head without rebasing",
      required: true,
      foundBy: "orchestrator review (rewrote delivery as best-effort)",
    },
  },
} satisfies Record<string, { provenance: string; paraphrase: string; defect: ReviewCase["defects"][number] }>;

type Report = keyof typeof graderReports;
interface AdversarialFixture {
  name: string;
  gold: Report[];
  claims: {
    report: Report;
    line: number;
    also?: Report;
    aliases?: number[];
    file?: string;
    severity?: Review["findings"][number]["severity"];
    verification?: "CONFIRMED" | "REFUTED";
  }[];
  mode?: "panel";
  expected: Pick<EvalGrade, "pass" | "score" | "review">;
}

export const adversarialReviewFixtures: AdversarialFixture[] = [
  {
    name: "01 right line, wrong mechanism: Discord delivery failure at the missing error listener",
    gold: ["discordError"],
    claims: [
      {
        report: "discordSend",
        line: 93,
      },
    ],
    expected: {
      pass: true,
      score: 1.0,
      review: {
        requiredMatched: 1,
        requiredTotal: 1,
        recall: 1.0,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 1,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "02 right line, wrong mechanism: delivery rebase refusal at branch authorization",
    gold: ["deliveryAuth"],
    claims: [
      {
        report: "deliveryRebase",
        line: 116,
      },
    ],
    expected: {
      pass: true,
      score: 1.0,
      review: {
        requiredMatched: 1,
        requiredTotal: 1,
        recall: 1.0,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 1,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "03 right line, wrong mechanism: empty diff at repository ownership check",
    gold: ["repoOwner"],
    claims: [
      {
        report: "cleanBump",
        line: 41,
      },
    ],
    expected: {
      pass: true,
      score: 1.0,
      review: {
        requiredMatched: 1,
        requiredTotal: 1,
        recall: 1.0,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 1,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "04 right mechanism outside upper location window: quota alert storm",
    gold: ["quotaStorm"],
    claims: [
      {
        report: "quotaStorm",
        line: 277,
      },
    ],
    expected: {
      pass: false,
      score: 0.0,
      review: {
        requiredMatched: 0,
        requiredTotal: 1,
        recall: 0.0,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 0,
            total: 1,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "05 right mechanism outside lower location window: Discord error listener",
    gold: ["discordError"],
    claims: [
      {
        report: "discordError",
        line: 87,
      },
    ],
    expected: {
      pass: false,
      score: 0.0,
      review: {
        requiredMatched: 0,
        requiredTotal: 1,
        recall: 0.0,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 0,
            total: 1,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "06 right mechanism and line in a different file",
    gold: ["repoOwner"],
    claims: [
      {
        report: "repoOwner",
        line: 41,
        file: "src/pipeline/engine.ts",
      },
    ],
    expected: {
      pass: false,
      score: 0.0,
      review: {
        requiredMatched: 0,
        requiredTotal: 1,
        recall: 0.0,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 0,
            total: 1,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "07 two claims in one comment in overlapping quota windows",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 262,
        also: "quotaWindow",
      },
    ],
    expected: {
      pass: false,
      score: 0.5,
      review: {
        requiredMatched: 1,
        requiredTotal: 2,
        recall: 0.5,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "08 two claims in one comment at only one Discord location",
    gold: ["discordError", "discordEvents"],
    claims: [
      {
        report: "discordError",
        line: 93,
        also: "discordEvents",
      },
    ],
    expected: {
      pass: false,
      score: 0.5,
      review: {
        requiredMatched: 1,
        requiredTotal: 2,
        recall: 0.5,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "09 merged duplicate paraphrases in overlapping quota windows",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 262,
        aliases: [264, 269],
      },
    ],
    expected: {
      pass: false,
      score: 0.5,
      review: {
        requiredMatched: 1,
        requiredTotal: 2,
        recall: 0.5,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "10 merged minor paraphrases under-rate at most one defect",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 262,
        severity: "minor",
        aliases: [264, 269],
      },
    ],
    expected: {
      pass: false,
      score: 0.0,
      review: {
        requiredMatched: 0,
        requiredTotal: 2,
        recall: 0.0,
        underRated: 1,
        blockingFindings: 0,
        requestChanges: false,
        falseBlock: null,
        verdictMatch: false,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 0,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "11 one merged claim with aliases in two gold windows",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 261,
        aliases: [276],
      },
    ],
    expected: {
      pass: false,
      score: 0.5,
      review: {
        requiredMatched: 1,
        requiredTotal: 2,
        recall: 0.5,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "12 one merged claim with disjoint Discord aliases",
    gold: ["discordError", "discordEvents"],
    claims: [
      {
        report: "discordError",
        line: 93,
        aliases: [300],
      },
    ],
    expected: {
      pass: false,
      score: 0.5,
      review: {
        requiredMatched: 1,
        requiredTotal: 2,
        recall: 0.5,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "13 alias-only detection with normalized file and inclusive lower boundary",
    gold: ["discordEvents"],
    claims: [
      {
        report: "discordEvents",
        line: 400,
        file: "././src/integrations/discord.ts",
        aliases: [295],
      },
    ],
    expected: {
      pass: true,
      score: 1.0,
      review: {
        requiredMatched: 1,
        requiredTotal: 1,
        recall: 1.0,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 1,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "14 separate findings require augmenting-path maximum matching",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 262,
      },
      {
        report: "quotaWindow",
        line: 272,
      },
    ],
    expected: {
      pass: true,
      score: 1.0,
      review: {
        requiredMatched: 2,
        requiredTotal: 2,
        recall: 1.0,
        underRated: 0,
        blockingFindings: 2,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 2,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "15 separate merged findings require maximum matching through aliases",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 400,
        aliases: [262],
      },
      {
        report: "quotaWindow",
        line: 500,
        aliases: [272],
      },
    ],
    expected: {
      pass: true,
      score: 1.0,
      review: {
        requiredMatched: 2,
        requiredTotal: 2,
        recall: 1.0,
        underRated: 0,
        blockingFindings: 2,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 2,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "16 normalized verbatim repeats cannot double-credit overlapping defects",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 262,
      },
      {
        report: "quotaStorm",
        line: 262,
        file: "./src/router/providers.ts",
      },
    ],
    expected: {
      pass: false,
      score: 0.5,
      review: {
        requiredMatched: 1,
        requiredTotal: 2,
        recall: 0.5,
        underRated: 0,
        blockingFindings: 2,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "17 merged claim prioritizes the blocker reached only by its alias",
    gold: ["repoOwner", "cleanBump"],
    claims: [
      {
        report: "repoOwner",
        line: 41,
        aliases: [115],
      },
    ],
    expected: {
      pass: false,
      score: 0.5,
      review: {
        requiredMatched: 1,
        requiredTotal: 2,
        recall: 0.5,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 1,
            total: 1,
          },
          medium: {
            caught: 0,
            total: 1,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
  },
  {
    name: "18 confirmed panel claim blocks despite finder nit severity, with one alias credit",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 262,
        severity: "nit",
        verification: "CONFIRMED",
        aliases: [272],
      },
    ],
    expected: {
      pass: false,
      score: 0.5,
      review: {
        requiredMatched: 1,
        requiredTotal: 2,
        recall: 0.5,
        underRated: 0,
        blockingFindings: 1,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 1,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
    mode: "panel",
  },
  {
    name: "19 refuted panel claim and aliases under-rate at most one missed defect",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      {
        report: "quotaStorm",
        line: 262,
        verification: "REFUTED",
        aliases: [272],
      },
    ],
    expected: {
      pass: false,
      score: 0.0,
      review: {
        requiredMatched: 0,
        requiredTotal: 2,
        recall: 0.0,
        underRated: 1,
        blockingFindings: 0,
        requestChanges: false,
        falseBlock: null,
        verdictMatch: false,
        bySeverity: {
          high: {
            caught: 0,
            total: 0,
          },
          medium: {
            caught: 0,
            total: 2,
          },
          low: {
            caught: 0,
            total: 0,
          },
        },
      },
    },
    mode: "panel",
  },
  {
    name: "20 separate claims at the same line remain independent vertices",
    gold: ["quotaStorm", "quotaWindow"],
    claims: [
      { report: "quotaStorm", line: 262 },
      { report: "quotaWindow", line: 262 },
    ],
    expected: {
      pass: true,
      score: 1,
      review: {
        requiredMatched: 2,
        requiredTotal: 2,
        recall: 1,
        underRated: 0,
        blockingFindings: 2,
        requestChanges: true,
        falseBlock: null,
        verdictMatch: true,
        bySeverity: {
          high: { caught: 0, total: 0 },
          medium: { caught: 2, total: 2 },
          low: { caught: 0, total: 0 },
        },
      },
    },
  },
];
