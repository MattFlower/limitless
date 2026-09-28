import type { Repo, Run } from "./types.ts";

/** Public request fields alone must never authorize bypassing the repository's PR policy. */
export function assertExistingBranchDelivery(
  repo: Repo,
  run: Pick<
    Partial<Run>,
    "source" | "requestedBy" | "sourceRef" | "baseBranch" | "deliveryBranch" | "githubWebhookVerified"
  >,
): void {
  if (!run.deliveryBranch) return;
  const ref = run.sourceRef;
  if (
    run.githubWebhookVerified !== true ||
    run.source !== "github" ||
    run.requestedBy !== "dependabot[bot]" ||
    repo.kind !== "github" ||
    run.baseBranch !== run.deliveryBranch ||
    ref?.kind !== "pull_request" ||
    ref.repo !== repo.slug ||
    typeof ref.number !== "number" ||
    !Number.isSafeInteger(ref.number) ||
    ref.number <= 0 ||
    typeof ref.headSha !== "string" ||
    !/^[a-fA-F0-9]{40}$/.test(ref.headSha)
  )
    throw new Error("existing-branch delivery requires a verified GitHub Dependabot webhook");
}

/** Mirrors `git check-ref-format --branch`, so untrusted payload refs can't name invalid branches. */
export function isBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "@" &&
    name !== "HEAD" &&
    !name.startsWith("-") &&
    !name.endsWith(".") &&
    !name.includes("..") &&
    !name.includes("@{") &&
    ![...name].some((c) => c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) === 0x7f || "~^:?*[\\".includes(c)) &&
    name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
