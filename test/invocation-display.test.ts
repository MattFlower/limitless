import { expect, test } from "bun:test";
import { ROLE_DESCRIPTIONS, roleDescription } from "../src/core/role-descriptions.ts";
import type { Role } from "../src/core/types.ts";
import { invocationModelLabel } from "../ui/lib/invocation-model.ts";

test("every invocation role explains both its work and purpose", () => {
  const roles: Role[] = [
    "triage",
    "spec",
    "holdout",
    "implement",
    "review",
    "verify",
    "chat",
    "summarize",
    "plan",
    "plan_review",
  ];
  expect(Object.keys(ROLE_DESCRIPTIONS).sort()).toEqual([...roles].sort());
  for (const role of roles) {
    expect(ROLE_DESCRIPTIONS[role].length).toBeGreaterThan(30);
    expect(ROLE_DESCRIPTIONS[role]).toContain(" so ");
  }
});

test("unknown persisted roles receive useful help", () => {
  expect(roleDescription("synthesis_worker")).toContain("does not recognize");
  expect(roleDescription("__proto__")).toContain("does not recognize");
});

test("model labels show the recorded backend model and distinguish effort states", () => {
  const base = { modelId: "claude/opus", model: "claude-opus-5-5" };
  expect(invocationModelLabel({ ...base, effort: "high" })).toBe("claude/opus → claude-opus-5-5 · high");
  expect(invocationModelLabel({ ...base, effort: "default" })).toBe(
    "claude/opus → claude-opus-5-5 · backend default",
  );
  expect(invocationModelLabel({ ...base, effort: null })).toBe(
    "claude/opus → claude-opus-5-5 · unknown (legacy)",
  );
  expect(invocationModelLabel({ ...base, model: null, effort: null })).toBe(
    "claude/opus → unknown model (legacy) · unknown (legacy)",
  );
  expect(invocationModelLabel({ ...base, model: undefined, effort: "default" })).toBe(
    "claude/opus → unknown model (legacy) · backend default",
  );
});
