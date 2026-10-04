import type { Repo, Run } from "./types.ts";

/**
 * Authority to push onto a stored factory run's own PR branch. It comes only from a server-side
 * record (a review round's), never from request fields. `prOpen` and `remoteHead` are observed
 * before a push; where they are omitted only the stored facts are checked.
 */
export interface FactoryBranchGrant {
  owner: Pick<Run, "repoId" | "branch" | "prUrl" | "deliveryBranch">;
  /** The PR head the grant was issued against; the push leases on it. */
  head: string;
  prOpen?: boolean;
  remoteHead?: string | null;
}

/** Public request fields alone must never authorize bypassing the repository's PR policy. */
export function assertExistingBranchDelivery(
  repo: Repo,
  run: Pick<
    Partial<Run>,
    "source" | "requestedBy" | "sourceRef" | "baseBranch" | "deliveryBranch" | "githubWebhookVerified"
  >,
  grant?: FactoryBranchGrant | null,
): void {
  if (!run.deliveryBranch) return;
  if (grant) {
    assertFactoryBranch(repo, run.deliveryBranch, run.baseBranch, grant);
    return;
  }
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

function assertFactoryBranch(
  repo: Repo,
  branch: string,
  base: string | null | undefined,
  { owner, head, prOpen, remoteHead }: FactoryBranchGrant,
): void {
  const refuse = (why: string) => {
    throw new Error(`existing-branch delivery refused: ${why}`);
  };
  if (repo.kind !== "github" || owner.repoId !== repo.id)
    refuse("not a factory run of this GitHub repository");
  if (!owner.branch || owner.deliveryBranch || branch !== owner.branch || base !== branch)
    refuse(`${branch} is not the factory run's own branch`);
  const pr = owner.prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9][0-9]*$/);
  if (pr?.[1]?.toLowerCase() !== repo.slug.toLowerCase())
    refuse("the factory run has no PR in this repository");
  if (!/^[a-f0-9]{40}$/.test(head)) refuse("invalid reviewed head");
  if (prOpen === false) refuse("the PR is no longer open");
  if (remoteHead !== undefined && remoteHead !== head)
    throw new Error(`head moved: the PR branch is at ${remoteHead ?? "nothing"}, not the reviewed ${head}`);
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
