import type { Role } from "./types.ts";

/** Shared explanations for invocation roles, including their purpose in the pipeline. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  triage: "Classifies the request and its risk so the factory can choose the right run profile and models.",
  spec: "Turns the request into requirements and acceptance criteria so implementation has a clear target.",
  plan: "Plans the work before implementation so complex changes have an ordered approach.",
  plan_review: "Reviews the plan independently so gaps can be found before code changes begin.",
  holdout:
    "Writes acceptance scenarios from the base code, never the implementation, so verification can catch implementation blind spots.",
  implement: "Changes the code and runs checks so the requested behavior is built.",
  review: "Reviews the implementation independently so defects and scope problems can be caught.",
  verify:
    "Checks the result against acceptance scenarios so the run has independent evidence of correctness.",
  summarize: "Summarizes the outcome so the delivery report is clear and concise.",
  chat: "Handles conversation with the user so requests and status questions can be understood.",
};

export const roleLabel = (role: string): string => (role === "review_shadow" ? "shadow review" : role);

export function roleDescription(role: string): string {
  if (role === "review_shadow")
    return "Runs the review panel beside the single review so its findings can be compared; it never decides the run.";
  return Object.hasOwn(ROLE_DESCRIPTIONS, role)
    ? ROLE_DESCRIPTIONS[role as Role]
    : "This invocation has a role this version of Limitless does not recognize. Its purpose is unavailable here.";
}
