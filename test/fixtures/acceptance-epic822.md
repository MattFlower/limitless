## Epic Q: issues are the work queue

### Model
- **Eligible:** an open issue in a configured repository is eligible when both of these hold.
  - **Trusted origin.** A trusted account (configured; default: the GitHub owner) wrote it, and no one else has edited the body since. Use GitHub's edit history (`lastEditedBy` / `userContentEdits`). Comments never reach the run (#377), so only the body matters.
  - **Approved.** It carries a priority label `priority:0` … `priority:10` (lower is more urgent; owner, 2026-10-23), applied by a trusted account. The issue events API records who applied each label (`labeled` events carry `actor.login`; confirmed on #774). Today every label shows the owner, because the factory acts as the owner; with the App, the factory's own labels show as its bot account. No priority means a note or a draft, never built. With several priority labels, the most urgent wins and the issue gets a comment saying so.
  - **`priority:0` is urgent.** It takes the next free run slot ahead of everything else, and may exceed the issue-run cap by one. 1–3 are the everyday levels; the rest are room for later.
  - Epics (issues with sub-issues) are never built themselves.
- **Order:**
  - Higher priority first, then oldest first.
  - An issue whose blockers are open waits. Blockers come from GitHub's native "blocked by" relationship and sub-issue order where available, otherwise from a `Blocked by #n` line in the body.
- **Claim (exactly once), on every path.** A run for an issue can also start from the webhook `limitless` label, a `/limitless` comment, MCP, or `limitless run` with `Closes #n` (how I start issues today). All of them pass the same claim check, one implementation: an issue that's already claimed is refused with the claiming run's link. The webhook label trigger becomes a faster way into the queue, not a second path.
  - The label `limitless:in-progress` plus a comment naming the run, for people.
  - For machines, a claim record that is atomic. A label isn't: two coordinators can both add one. Create a ref, `refs/limitless/claims/<issue>`. GitHub refuses to create a ref that already exists, which gives compare-and-swap.
  - The ref points at a commit whose message names the coordinator and a lease deadline. The holder renews it; a stale claim can be taken over after its lease.
  - **Leases.** Each renewal is a new commit whose parent is the previous claim commit. Updating a ref without force must be a fast-forward, so renewing and taking over are compare-and-swap: a holder that has lost the claim can't renew, and of two coordinators taking over, only one succeeds. The commits get GitHub's own timestamps, so lease expiry doesn't depend on any machine's clock. Initial values: renew every 3 minutes, expire after 10.
  - **A machine that vanishes, freezes or sleeps** stops renewing. After the lease expires, another coordinator takes the claim.
  - **How a holder learns it lost the claim.** It keeps the time of its last successful renewal on a monotonic clock. After a freeze or a sleep, the first timer to fire sees a gap longer than the lease, so the holder assumes the claim is lost and asks GitHub before doing anything else. If the claim tip is someone else's commit, the claim is lost. If it is still its own, the holder renews with a fast-forward, which GitHub refuses if the ref moved in the meantime. A holder that has lost its claim cancels the local run and publishes nothing.
  - **Fencing.** Checking first narrows the window between waking and acting but can't close it, so every outward step is also pinned:
    - pushes carry the branch head they expect (`--force-with-lease=<branch>:<sha>`), so a stale holder's push fails once the new holder has pushed;
    - merges carry the checked head (`--match-head-commit`);
    - each claim commit carries a generation number, and the factory's comments and labels include it, so readers ignore a stale holder's late write;
    - the new holder re-reads the branch and PR before acting, so a stale push that landed first is only extra commits it adopts.
  - **Reconciliation.** The new holder adopts the existing branch and PR (found through the issue's links and the branch naming), and never opens a second one. Recorded side effects don't repeat (AGENTS.md).
  - **Alive but not progressing** is a different case. Renewals prove liveness, not progress, and another machine can't tell slow from stuck, so it never takes a live claim. Instead the holder records its last stage transition in the claim. The existing stage timeouts end a hung stage, and a run with no progress for a set time is labelled `limitless:needs-you` for the owner.
  - With one coordinator, the local run record (`sourceRef`) already dedupes; the ref makes it safe for more.
- **Lifecycle:**
  - Claimed → the run starts; the issue gets the run link.
  - PR opened → linked (`Closes #n`). Merged → GitHub closes the issue.
  - `needs_human` or a question → `limitless:needs-you` with the question.
  - Failed → the claim is released, the issue is labelled `limitless:failed` with the reason, and it is **not** picked again until a trusted account re-approves it, so a failing issue can't loop.
- **Polling:** conditional requests (`since`, ETags) every few minutes, inside a fixed rate-limit budget. Webhooks only make it faster. This also unblocks issue triggers on the work machine.
- **Comment commands:** a trusted author's comment that starts with `/limitless` or mentions the App (`@limitless-software-factory`) is a command, read by polling the repository's comment stream (`since`). The mention is only a text convention: without webhooks, GitHub doesn't deliver it to the App, and what matters is who wrote the comment.
- **Capacity:** a coordinator claims only when it has a free run slot. A cap on issue-sourced runs keeps room for hand-started work.

### Toward several coordinators
- What already travels through git or GitHub needs nothing new: each change's `.limitless.toml` from its base commit, PR state, CI, and approvals as PR reviews (#687's approval polling).
- What must become shared:
  1. **The issue claim** (above).
  2. **One land per repository at a time.** Today that lock is a row in one coordinator's database (`claimLandEntry`). Across machines it needs the same ref claim, `refs/limitless/land/<repo>`, and merges stay pinned with `--match-head-commit`.
  3. **The owner's attention:** questions and approvals go to the issue and the PR, not to one machine's UI.
- Each machine keeps its own database, providers, quota, executor (#784) and workers. A conversation with me on any machine files or edits issues, and whichever coordinator has capacity picks them up.

