import type { Repo, Run } from "./types.ts";

/**
 * Authority to push onto a stored factory run's own PR branch. It comes only from a server-side
 * record (a review round's), never from request fields.
 */
export interface FactoryBranchGrant {
  /** The stored run whose own branch and PR the delivery updates. */
  owner: Pick<Run, "id" | "repoId" | "branch" | "prUrl" | "deliveryBranch">;
  /** The PR and head the record was issued for; the push leases on `head`. */
  prUrl: string;
  head: string;
}

/** A PR as looked up just before acting on it; a lookup missing any field is never one of these. */
export interface PrHead {
  state: string;
  crossRepository: boolean;
  /** `owner/name` of the head repository. */
  headRepo: string;
  headBranch: string;
  headSha: string;
}

type DeliveryRun = Pick<
  Partial<Run>,
  "source" | "requestedBy" | "sourceRef" | "baseBranch" | "deliveryBranch" | "githubWebhookVerified"
>;

/** Public request fields alone must never authorize bypassing the repository's PR policy. */
export function assertExistingBranchDelivery(
  repo: Repo,
  run: DeliveryRun,
  grant?: FactoryBranchGrant | null,
): void {
  // A review round delivers only onto its owner's branch, whatever its stored fields say.
  if (grant || run.sourceRef?.kind === "review-round") {
    if (!grant) refuse("a review round without its verdict record");
    else assertFactoryBranch(repo, run, grant);
    return;
  }
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

/**
 * On every delivery attempt onto a factory branch: the stored grant holds, and so does the PR as
 * seen now, at `at`: the reviewed head before a push, or this delivery's own earlier push.
 */
export function assertFactoryBranchPush(
  repo: Repo,
  run: DeliveryRun,
  grant: FactoryBranchGrant,
  pr: PrHead,
  remoteHead: string | null,
  at = grant.head,
): void {
  assertFactoryBranch(repo, run, grant);
  const problem = prHeadProblem(repo, grant.owner.branch as string, pr);
  if (problem) refuse(problem);
  const expected = at === grant.head ? `the reviewed ${at}` : `this round's pushed ${at}`;
  if (remoteHead !== at)
    throw new Error(`head moved: the PR branch is at ${remoteHead ?? "nothing"}, not ${expected}`);
  if (pr.headSha !== at)
    throw new Error(`head moved: GitHub reports the PR head at ${pr.headSha}, not ${expected}`);
}

/** Why the PR is not open with its head on `branch` in this repository (not a fork), or null. */
export function prHeadProblem(repo: Repo, branch: string, pr: PrHead): string | null {
  if (pr.state !== "OPEN") return `the PR is ${pr.state.toLowerCase()}, not open`;
  if (pr.crossRepository || pr.headRepo.toLowerCase() !== repo.slug.toLowerCase())
    return "the PR head is in another repository";
  if (pr.headBranch !== branch) return `the PR head branch is ${pr.headBranch}, not ${branch}`;
  return null;
}

function refuse(why: string): never {
  throw new Error(`existing-branch delivery refused: ${why}`);
}

/** The round record, its owner, the owner's PR and branch, and the run's own fields all agree. */
function assertFactoryBranch(repo: Repo, run: DeliveryRun, { owner, prUrl, head }: FactoryBranchGrant): void {
  if (repo.kind !== "github" || owner.repoId !== repo.id)
    refuse("not a factory run of this GitHub repository");
  if (
    !owner.branch ||
    owner.deliveryBranch ||
    run.deliveryBranch !== owner.branch ||
    run.baseBranch !== owner.branch
  )
    refuse(`${run.deliveryBranch ?? "no branch"} is not the factory run's own branch`);
  const pr = owner.prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9][0-9]*$/);
  if (pr?.[1]?.toLowerCase() !== repo.slug.toLowerCase() || prUrl !== owner.prUrl)
    refuse("the round's PR is not the factory run's PR in this repository");
  const ref = run.sourceRef;
  if (
    ref?.kind !== "review-round" ||
    ref.runId !== owner.id ||
    ref.prUrl !== prUrl ||
    ref.reviewedSha !== head
  )
    refuse("the run's source does not match its review round record");
  if (!/^[a-f0-9]{40}$/.test(head)) refuse("invalid reviewed head");
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
