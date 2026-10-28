import { type IssueText, issueTextRefusal } from "../integrations/issue-trust.ts";
import type { Acceptance } from "./schemas.ts";

export const ACCEPTANCE_BLOCK = "Acceptance runs require a compatible engine";
export interface AcceptanceSnapshot {
  ticket: IssueText;
  parent: IssueText;
}
export interface AcceptanceUnit {
  id: string;
  text: string;
  class: "behaviour" | "docs";
  sources: string[];
}
export interface AcceptanceState {
  snapshot: AcceptanceSnapshot;
  sha?: string;
  manifest?: AcceptanceUnit[];
  setupDone?: boolean;
  output?: Acceptance;
  outcome?: {
    sha: string;
    units: {
      unit: string;
      verdict: Acceptance["items"][number]["verdict"] | "not_assessed";
      citations: string[];
      refusals: string[];
    }[];
    summary: string;
    passed: boolean;
  };
}

export function acceptanceRunRequest({
  ticket,
  parent,
  trusted,
}: {
  ticket: IssueText;
  parent: IssueText | null | undefined;
  trusted: string[];
}): AcceptanceSnapshot {
  if (!parent) throw new Error("acceptance ticket has no parent");
  for (const [name, issue] of [
    ["ticket", ticket],
    ["parent", parent],
  ] as const) {
    const reason = issueTextRefusal(issue, trusted);
    if (reason) throw new Error(`${name}: ${reason}`);
  }
  return { ticket, parent };
}
