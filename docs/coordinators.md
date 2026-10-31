# Every machine a coordinator

Design slice of #902. This document describes the inspected checkout and a proposed design;
nothing proposed here is implemented yet. The claim and fencing decisions below come from
the settled #902 review results supplied with this task, not new GitHub experiments.

The goal is that every machine is a coordinator and any machine can leave at any time.
Closing machine-a or stopping machine-b reduces throughput; it does not strand their runs.
One machine works alone, any combination works together, and zero machines pauses work.
Throughput should approach linear growth where independent work and provider capacity allow;
repository landing, shared subscriptions and storage/API limits remain serial constraints.
Timing and slice sizes below are design estimates, not measurements.

The single-coordinator default keeps working unchanged until shared mode is explicitly enabled.
Shared mode requires independently available durable storage and compatible coordinators;
it must never silently fall back to local-only ownership after losing those dependencies.
Model routing evaluation and implementation of this proposal are outside this document.

## 1. State inventory

Today SQLite, run files and worktrees on one coordinator jointly determine what happens next.
`RunState` in `src/pipeline/context.ts` is persisted in `runs.state_json`; copying `runs` alone
does not copy its artifacts, observations, pending effects or unpublished Git objects.
The table specifies proposed homes. “Private” means private-to-owner; secret values require
separate machine provisioning. Public means explicitly publication-safe, not merely redacted.
SQLite remains a local projection of shared records, never a database file shared over a LAN.

| State item / inspected tables or fields | Who needs it to continue or land | Sensitivity | Proposed home |
| --- | --- | --- | --- |
| Repository identity and effective policy: `repos`, relevant `settings` keys | Admission, adopter and lander need the same repository, profile, trust and gate policy | private | private shared store; public GitHub base SHA identifies repository policy; local paths regenerated |
| Run identity, request, origin, status, cancellation, phases and checkpoints: `runs`, `stages`, `RunState.phase`, `flow`, `parked` | Adopter and clients need one logical run and its last completed transition | private | private shared store; GitHub claim ref selects its checkpoint |
| Round/retry budgets and selected execution context: `round`, `triedImplementers`, `environmentRetryRound`, `feedback`, triage and pinned review mode/lenses | Adopter must preserve consumed attempts, constraints and trusted base policy | private | private shared store; no fresh retry budget on adoption |
| Publication and merge checkpoints: `publishingSha`, `publishedSha`, `deliveryComplete`, verdict-comment flags, `deliveryMerges`, `postMergeRejection`, `needsHumanReason` | Adopter and lander reconcile completed or uncertain effects | private | private shared store; GitHub branch, PR and issue confirm actual effects |
| Spec and artifact catalogue: `artifacts`, `RunState.spec` | Adopter, reviewer and verifier reuse accepted requirements | private | private shared store; only separately approved publication copies reach GitHub PR/issue |
| Holdout scenarios, author identity and generation status: `holdout`, `holdoutStatus`, verifier `modelOutput` | Holdout author/verifier and adopter; implementer must not receive them | private | private shared store with role-separated delivery; never public GitHub |
| Reports, report sources, reviews, verification and audit evidence: `artifacts`, `lastVerifiedEvidence`, `reviewHistory` | Adopter and lander need original evidence and exact SHA bindings | private | private shared store; only checked public summaries on GitHub PR |
| Gate results and execution provenance: `gate_jobs`, `agent_gate_executions`, `completedChecks`, `gateEvidence`, post-merge gate state | Adopter/lander distinguish completed checks from interrupted attempts | private | private shared store; machine/environment-bound evidence revalidated or regenerated |
| Agent jobs and attempt ledger: `agent_jobs`, `agent_job_events`, `agent_job_attempt_events` | Adopter needs accepted result, parent SHA, consumed attempt and pending execution identity | private | private shared store for semantic records; executor processes regenerated, never remotely resumed |
| Review rounds and authority: `review_rounds`, `review_approvals`, `pr_heads`, `github_observation_sequence` | Reviewer, adopter and any lander need current-head approval and observation ordering | private | private shared store; GitHub PR supplies current head and authenticated review evidence |
| Land queue: `land_entries`, approval-wait sequence and merge/push intent | Any lander continues the exact approved attempt | private | private shared store; GitHub land-lock ref selects durable land checkpoint |
| Questions and answers: `questions`, `inbox`, `RunState.answers` | Adopter and owner-facing clients need unresolved questions, answers and inbound dedupe | private | private shared store; public GitHub issue only for explicitly public exchanges |
| Processed comments (#922): `github_processed_comments`, `github_comment_boundaries` | Every poller needs shared run/refusal receipts and original enable boundary | private | private shared store; GitHub issue/comment IDs identify input, not ownership |
| Issue-queue lifecycle: `issue_lifecycle_effects`, latest issue run in `runs`, queue policy in `settings`/config | Claimant and reconciler need failure/reapproval boundary, pending labels/comments and terminal history | private | private shared store; GitHub issue supplies current labels, timeline and blockers |
| Follow-up triggers and failure episodes: `conflict_triggers`, `ci_fix_triggers`, `ci_failures` | Pollers and adopter must not recreate the same conflict/CI round | private | private shared store; GitHub PR/checks re-observed on adoption |
| PR observation caches: `github_prs`, `github_pr_expiry`, `github_access`, review snapshots in `settings` | Poller/lander need fresh CI, head, access and closed/reopened state | private | regenerated from GitHub PR/API; durable approval ordering stays shared |
| Passing baselines: `passing_baselines`, `baseline`, `baselineCached` | Adopter and gate executor need evidence for their own environment | private | regenerated on adoption; never transplant a cached pass across machines |
| Bare caches, worktrees, trusted Git-path records, scratch, previews and CLI sessions | Adopter needs committed input/output, not another machine's paths or processes | private | regenerated on adoption; unpublished committed objects first saved in private shared store |
| Invocation accounting: `invocations`, token/cost totals | Adopter and admission need spent budget and interrupted-attempt accounting | private | private shared store; raw CLI transcripts stay local unless explicitly retained privately |
| Provider quota and health: `provider_state`, `quota_alerts` | Schedulers need account-scoped quota/spend and machine-scoped endpoint health | private | private shared store for account observations/reservations; local health regenerated |
| Capacity/identity: `workers` capabilities, heartbeat and release compatibility | Claimants need compatible peers and fresh capacity | private | private shared store for expiring adverts; legacy pairing credentials remain machine-local |
| Host gate/provider slots: `slot_pools`, `slot_requests` | Local executor bounds resources; shared account reservations are distinct | private | regenerated locally; stale host slots never become successor authority |
| Conversation admission: `chat_messages`, `chat_proposals`, `chat_receipts`, `chat_calls` | Concierge/client needs confirmed request and deduped submission | private | private shared store; adoption needs confirmed request, not a replayed conversation |
| Feed and acknowledgement: `feed`, `feed_cursors` | CLI/UI/MCP/orchestrator need stable shared pagination and consumer acknowledgement | private | private shared store for canonical event IDs/acks; local feed projection regenerated |
| Per-machine config (`config.toml`, environment overrides), endpoints and tool paths | Local executor needs valid bindings; adopter needs portable effective policy | private | regenerated via machine provisioning; portable policy snapshot in private shared store |
| Secrets (`secrets.env`, tokens, CLI logins, storage encryption keys) | Each authorized coordinator authenticates independently | secret | regenerated via separate machine provisioning; never in checkpoint or public GitHub |
| Private-strings list (`private-strings.txt`) and policy version | Every publisher and adopter needs exact owner policy parity | private | private shared store with restricted access; local protected copy verified before claiming |

Holdouts, private-filtered reports, secrets and private strings never reach the public repository,
including its refs, commit messages, trees, PR bodies, issue comments, logs and attachments.
A private-filtered report remains private even if a display renderer has removed some spans.
Public GitHub holds only safe code, approved public summaries and minimal opaque coordination
metadata. Check complete publication sources using the [privacy design](privacy-boundaries.md);
its proposed protections are not assumed to exist today. Never upload raw SQLite or run folders.
The daemon imports private state outside agent sandboxes. Implementers receive only their allowed
spec/feedback projection, never the full checkpoint, holdout or shared-store credentials. Preserve
the holdout author's base-only view and verifier-only scenario delivery after adoption; probe
the same read boundaries on the new machine before running agents.

Tables that do not steer adoption and stay machine-local (not portable run authority):
`auth_sessions`, `auth_passkeys` (secret authentication material; provision each endpoint);
`owner_diagnostics`, `events` (private diagnostics; required decisions/evidence are checkpointed);
`executors`, `process_cleanups`, `process_discoveries` (private host/process ownership);
`eval_runs`, `eval_trials`, `eval_trials_effort`, `eval_run_options`, `eval_run_systems`,
`eval_run_concurrency`, `eval_run_requests` (private independent eval state, not production runs);
`runtime_models`, `served_models`, `model_discovery`, `catalog_history` (private local discovery);
`routing_cells`, `routing_prefer`, `routing_history` (private installed routing policy/history).
Policy required by a portable run is pinned in its effective-policy record; this design neither
changes nor evaluates routing. `eval_trials_effort` is a historical table renamed to `eval_trials`.
`applied_migrations` and `schema_migrations` are excluded migration bookkeeping, kept local.

**How we searched.** Run these commands from the repository root; they inspect code, not owner
configuration. The first includes both frozen baseline migrations and timestamped SQL files.
Follow the named fields into engine/save, store methods and integrations to distinguish caches
from durable decisions; listing migration filenames alone misses `settings` and file state.

```sh
rg --no-filename -o 'CREATE TABLE (IF NOT EXISTS )?[a-z_]+' src/db | sort -u
rg -n -A 155 '^export interface RunState' src/pipeline/context.ts
rg -n 'loadConfig|config.toml|secrets.env|process.env' src/config.ts
rg -n 'loadPrivateStrings|privateStringsDigest' src/gates/private.ts src/workers/client.ts
rg -n 'Boundary|boundary|Processed|Lifecycle|latestIssueRun' src/integrations/issue-queue.ts src/db/store.ts
rg -n 'onAC|confinement|agents|privateStringsDigest' src/workers/protocol.ts src/workers/client.ts
```

Private shared store candidates and failure modes:

| Candidate | Strength | Failure modes / adoption consequence |
| --- | --- | --- |
| Private GitHub repository (or private gist) | Familiar authentication, Git objects and history; repository refs can serialize manifests | API/rate-limit outage also blocks claims; large binary history and retention are awkward; accidental visibility change discloses content. An unlisted gist is not private access control. |
| Owner-controlled private object storage | Immutable blobs, versioned conditional writes, access controls and independent availability | Requires credentials, key backup and a proven consistency contract; outage blocks checkpoints; deletion/key loss prevents adoption. Eventually consistent listings cannot decide ownership. |
| Peer replication among coordinators | No separate hosted data service | Two sleeping peers can lose the only copies; partitions require quorum/conflict rules; acknowledged local writes are not durable if that peer leaves. |

**Owner decision (2026-10-28): a private companion GitHub repository holding encrypted blobs.**
It adds no new service: an outage there also blocks claims, which already depend on GitHub.
Blobs are Git objects (immutable, content-addressed), and manifests are refs in that repository,
written with the same GraphQL `updateRefs` and `beforeOid` compare-and-swap as the claims, so a
lost race re-reads the tip. Payloads are encrypted with keys provisioned per machine and never
stored on GitHub, so an accidental visibility change discloses nothing readable. Use a token scoped
to that repository only, and verify a restore before enabling shared mode. The candidates table
above stays as the rationale; any future backend must keep these same semantics.
Use random object keys and authenticated encrypted payloads; keep decryption keys off GitHub.
The public claim contains only opaque run/generation IDs, lease data and an encrypted checkpoint
object key/digest. It contains no private-policy digest, machine endpoint, request or report text.
Safe synthetic commit identity and GitHub timestamps avoid publishing local account metadata.

Each checkpoint manifest has a schema version, generation, sequence, previous digest, input/base
and head SHAs, phase/round, artifact digests and pending/completed effect IDs. Upload all blobs,
verify reads, then CAS the claim ref to the manifest pointer. That ref update commits the
checkpoint; local SQLite success alone never does. An interrupted upload leaves an ignored blob.
Renewal and checkpoint writers serialize updates per claim and preserve each other's pointer.
New-generation acquisition preserves the last pointer; manifests may originate in an older
generation if selected by this chain. Unknown schema or missing/corrupt blobs blocks execution
with a private diagnostic; never reconstruct holdouts from public summaries or reset the run.

Repository control records (input receipts/boundaries, approvals, land requests, policy and member
directory) use conditional private-store manifests and globally unique IDs, not local row numbers.
Each mutation records authenticated actor and idempotency key; a lost CAS re-reads and rechecks
conditions. Run-derived receipts point to a claim-committed checkpoint, so an orphan upload or
stale generation cannot authorize effects. Shared input reservations name the logical run and
remain adoptable; a crash between reservation and claim completion does not consume the request.
Retain referenced blobs through completion and the configured recovery window; a departing
machine cannot garbage-collect shared evidence. Storage/GitHub failure pauses new work safely;
machine departure alone never removes the durable copy. No peer is the required storage server.

## 2. Adoption protocol

1. Poll shared inputs, claims and capabilities. For an expired or explicitly released claim,
   find a compatible checkpoint before competing; a waiting-for-answer run stays waiting.
   Read GitHub time and the current tip; only GitHub's clock judges expiry, never local wall time.
2. CAS `refs/limitless/claims/<issue>` with GraphQL `updateRefs` and `beforeOid`, preserving run ID,
   checkpoint pointer and branch/PR identity while advancing generation. On any ambiguous/lost
   race, re-read the tip; do not infer success from a generic API error. No REST claim writes.
3. Fetch the selected private manifest and verify schema, digests, policy and capability parity.
   Establish the new generation's lease window before launching work. A new claim holder may
   checkpoint inherited state but may not accept late output from the departed generation.
4. Reconcile pending GitHub effects against branch SHAs, PR identity, comment markers and current
   run cancellation/approval. Persist the observation under the new generation before advancing.
   An unresolved write outcome suspends that effect; do not blindly repeat a non-idempotent call.
5. Rebuild worktree and trusted Git paths from pinned SHAs and privately stored unpublished Git
   objects. Validate bundles/objects as untrusted input, retaining existing Git/confinement rules.
   Reuse completed spec, holdout, answers, review history, consumed attempts and approved evidence.
   Regenerate baselines, scratch, previews and tool sessions. Rerun interrupted stages and checks
   whose SHA, policy or execution environment no longer matches; preserve failed/flaky history.
6. Continue the deterministic phase machine from its last durable checkpoint. Publish the next
   checkpoint before scheduling another execution unit, and keep renewing the claim while active.

The duplicate-work bound is at most one in-flight round per run per lost lease; outside the
round loop it is one stage. The existing parallel holdout belongs to that same round, so at most
one holdout invocation and one main-stage invocation can be orphaned together. Persist independent
completion before advancing either task. Lost-lease retries consume the existing attempt ledger;
successive departures may each waste one unit, never restart completed history or reset budgets.
Do not start a later stage/round without a fresh lease check and durable predecessor checkpoint.
Executors bind results to generation, job, attempt, parent SHA and input digest; late results
cannot enter the successor's checkpoint. Revoking a remote attempt does not prove its process
stopped; only its owner can clean it up, and the stale executor cannot start another attempt.

A returning departed coordinator first stops its owned execution **without publishing**: its
generation is stale. Before resuming any queued callback, inspect clocks and re-read ownership;
abort its own process handles and quarantine local results. Then reconcile its local SQLite,
worktree and pending effects against the authoritative pointer and GitHub. Retain diagnostics
privately; discard speculative edits after reconciliation. Never overwrite the successor's state
or kill processes belonging to another machine. Rejoining requires a fresh capability advert;
even when nobody adopted, an expired lease requires a new generation before work can resume.

Earlier #902 rules change explicitly:

- **“Never adopt” is replaced:** released/expired work is adopted under a new generation.
- **“Never take over a parked run” is replaced for departure parking:** a portable parked
  checkpoint is eligible. Human holds, cancellation, failed policy checks and needs-human decisions
  remain blocking until their recorded condition is resolved; departure does not grant approval.
- **The accepted duplicate-PR residual is narrowed, not claimed eliminated:** preserve one stable
  run branch and a durable create-PR intent, then search all open/closed PRs by that identity before
  retrying. A timed-out in-flight request can still complete after the successor's lookup because
  GitHub PR creation has no claim-generation CAS. Record both IDs, select one canonical PR and
  reconcile the redundant PR under current authority; never create a new PR merely on adoption.

The guard before every GitHub write checks current generation, cancellation and a sleep-aware
safe window; recheck state after awaits and pin ref/PR-head writes to the expected SHA.
GitHub does not enforce our generation on comments or PR creation: a pre-write guard cannot
retract a request already in flight. Durable intents, reconciliation and the stated residual
cover that gap; model output or an old local receipt is never evidence of a completed effect.
Agent CLIs never gain direct publication authority; all factory GitHub write paths use the guard.
For CLI/UI requests without an issue, define an equivalent namespaced run claim; existing-PR
follow-ups share a PR authority key. Do not invent synthetic public issues for private requests.

## 3. Graceful leave

On battery, sleep/lid-close notification, network loss or explicit `limitless leave`, enter
draining immediately: advertise leaving, stop claiming and start nothing new (including land
entries, retries and follow-up rounds). `src/workers/client.ts` already reports heartbeat `onAC`;
reuse its power observation. Its Linux probe currently assumes AC, so do not treat that value as
proof of Linux power supply; unknown power is ineligible unless owner policy explicitly permits.
An owner may explicitly allow battery operation; the conservative shared-mode default drains.

Budget **30 seconds** from observing leave to a durable checkpoint and explicit lease release.
Allow the current execution to finish only inside that budget; otherwise cancel owned handles,
keep the last completed checkpoint, record interruption if possible and discard unfinished output.
Upload referenced blobs before publishing the checkpoint, then CAS the claim to released while
preserving the pointer. A successor increments generation immediately; never delete the ref.
Release a held land lock by the same sequence, including its pending-effect ledger.

Lid close may give no notice, and network loss may prevent both upload and release. Missing the
budget falls back to **10-minute lease expiry**, judged on GitHub's clock; no early takeover based
only on a missing heartbeat. Stop local work when the budget ends, even if release failed.
Sleep detection compares suspend-inclusive and suspend-exclusive clocks; any unsafe discontinuity
invalidates the local write window before waking callbacks run. Renew every 3 minutes only while
able to honor the lease. Returning network/power does not revive a released or expired generation.
`leave` exits draining only through explicit rejoin/start policy, not a queued job racing shutdown.
The normal graceful hand-off target is 30 seconds plus successor polling/storage latency;
unannounced loss costs up to the lease remainder plus polling and reconstruction time.

## 4. Capability-aware claiming

Start with `workers` and `src/workers/protocol.ts`, plus migrations
`20261015T145911-workers.sql`, `20261023T025234-worker-agent-capabilities.sql` and
`20261026T1254-worker-capabilities-ext.sql`. These already separate agent and extended capability
fields for compatibility; they are not yet a coordinator directory or an adoption contract.

Each authenticated advert includes a random machine ID, supported checkpoint/protocol versions,
OS/architecture, confinement backend and successful probe identity, agent CLI versions and login
status, private-strings parity/version, free execution slots, power state and draining state.
Endpoints and capability details live privately. Logins advertise availability, never tokens;
private-strings parity is checked against the restricted shared policy, never a public digest.
Expire adverts after 90 seconds without heartbeat; this removes eligibility, not a live claim.

A machine claims only work it can complete: all remaining agent roles, gates, publication and
storage access must be supported, including required independent verification and policy parity.
Freshly check login, confinement and parity before starting a stage or publishing; unknown or
mismatched capability is ineligible. A machine losing capability checkpoints and drains its run
for a compatible adopter; it does not weaken confinement or mark the run needs-human for leaving.
If no compatible machine is up, preserve an explicit waiting-for-capability state and poll.
Do not depend on another currently advertised peer finishing an essential remaining agent role.

Linux machines cannot run agent rounds until #839. A Linux machine may meanwhile execute supported
gate jobs under proven bubblewrap/Landlock, or claim a gate/landing-only task if it can finish that
entire task; it cannot claim an implementation run expecting a Mac to return later. Every job
also carries OS/toolchain requirements; incompatible baseline evidence is never reused.
Use existing routing unchanged within eligible execution; capability admission is deterministic.

## 5. Reaching the factory

In shared mode configure several authenticated seed endpoints such as `<host>` and a factory ID;
read an expiring member directory from private storage after connecting. Prefer the local daemon,
then try reachable compatible members. No seed, proxy or elected API leader is required to stay up.
Public GitHub claims contain opaque member IDs only; endpoints are never published there.

CLI and stdio MCP share discovery; HTTP MCP and UI can connect to any member. The UI reconnects
through its configured endpoints and refreshes shared snapshots after SSE reconnect. The
orchestrator uses the same API/MCP discovery and shared feed cursor, not a designated laptop.
Each endpoint retains its existing authentication boundary; membership alone does not authorize
an unauthenticated LAN request. Browser access needs compatible origins/session provisioning.

Any reachable coordinator answers shared-state queries from authoritative manifests and claim
pointers, tagging snapshot generation/version and freshness. Local logs, processes and health are
identified as machine-local. A stale/offline projection can be displayed as stale but cannot
approve, enqueue or cancel work. Mutations use durable idempotency keys and conditional shared
records; acknowledge only after persistence. The run holder consumes answers/cancellation from
those records; callers need not reach it directly. A timeout is reconciled by the same request ID.

Polling alone must discover eligible issues/comments, admissions, expired claims, answers,
approvals, CI/head changes and land requests. Share the original enable boundaries so a newly
joined machine never replays old commands. Poll with overlapping observation windows and durable
receipts, advancing cursors only after receipts commit; reconcile uncertain effects separately.
Webhooks are optional wake-up hints through the same dedupe path. Periodic directory and record
reads recover missed hints and reconnects. With no reachable shared store, expose unavailable
state rather than acknowledge a local-only mutation; GitHub loss also stops lease-dependent work.

## 6. Landing and approvals

An approval is a shared record binding repository, PR, run, exact reviewed SHA, reviewer authority,
resolved findings, observation version and revocation/staleness. Persist explicit CLI/MCP/UI
approvals there too; a local `review_approvals` row or a model assertion grants no authority.
Authenticated GitHub reviews are observations, checked against owner policy before acceptance.
Use shared per-PR observation versions and conditional updates, replacing machine-local
`github_observation_sequence` ordering. An older in-flight poll cannot overwrite a newer head,
changes-requested verdict or cancellation. Unobserved/UNKNOWN state never revalidates approval.

Any capable coordinator may land an approved PR. Acquire the per-repository land-lock ref using
the same CAS, generation fencing, 10-minute expiry, 3-minute renewal and both clocks as claims.
Keep one active land entry per repository; its durable lock checkpoint includes approved SHA,
prepared merge, gate/CI evidence, pending push/merge and cancellation. Run ownership and landing
authority cannot concurrently push the same PR: land waits for a durable delivery hand-off, and
an active land entry excludes repair pushes until cancelled or released through shared control.

Re-read approval/head/base after awaits. Check trusted base policy, private strings and exact
commit; gate an updated base merge, wait for CI on the resulting head and merge with
`--match-head-commit`. Any moved head or stale approval blocks merging; recorded base merges use
the existing explicit authorization rule. Adoption of `waiting_ci` continues observing its SHA;
adoption of `merging` first asks whether GitHub already merged. Never repeat a merge or comment
just because its local completion receipt was lost. Human review rules survive machine departure.

## 7. Retiring the worker model

Gate jobs and agent jobs become generation-bound execution units owned by a coordinator, using
existing deadlines, result validation and cancellation. Bundles become the transport for portable
committed objects/checkpoint input, validated without trusting repository configuration. Heartbeat
and capabilities become private member adverts; scheduling moves from one dispatcher's queue to
independent eligible claims. Pairing/trust/revocation remains explicit; promotion is not automatic.
Local process scopes, gate slots, confinement probes and cleanup remain executor responsibilities.

Migrate in order: ship disabled shared-state readers/contracts; test export/import and fenced
adoption; provision storage/policy/secrets separately; enroll compatible machines; drain legacy
runs before enabling shared admission per repository. Keep legacy coordinator/worker dispatch for
repositories not enabled. One repository has one admission mode, never two competing schedulers.
Do not adopt older local-only runs without an explicit validated export of all required state;
let them finish locally before cutover. An incompatible binary cannot claim shared work.
Rollback drains shared work and disables shared admission before restoring the local release;
the old daemon cannot safely resume portable runs from partial SQLite projections. Older
observers also lack claim-loss suppression: restarting one against stale shared projections is
not a supported rollback. C13 owns reconciliation/adoption of the surviving logical run. Additive
schemas preserve old local runs; shared mode configuration must not be passed to older binaries
that reject new keys. No fleet-wide simultaneous upgrade is required before opting in.

#832 and its Linux slices contribute usable gate executors and confinement foundations along the
way. #838's Linux gate/Git work and #881's mount-plan validation/pinning inform reusable executor
boundaries (`sandbox-linux.ts`, Landlock and validated bind sources); they do not make Linux an
agent coordinator. #839 remains the agent-round prerequisite. Keep those worker stories useful
through transition, then remove coordinator-dependent dispatch only after equivalent shared
execution, capability reporting, upgrade and revocation paths are verified. No Linux changes here.

## 8. Slices

**Owner decision (2026-10-28): the minimum path first.** Build first the smallest
dependency-closed set of slices that makes "close any one machine, and its in-flight work continues
on another" true end to end, with C02 implemented on the private companion repository. Approvals
and landing may keep waiting for the orchestrator in that first path. Shared approvals and land
adoption, failover discovery, the shared feed, quota reservations and conversation admission
(C16, C17, C19–C22) come after, unless a slice in the minimum path needs one of them to be correct.

These are proposed replacement #902 implementation slices, in dependency order; sizes are
estimated changed source lines (tests accompany each slice separately), all at most 250.
Split an overrun at the stated contract rather than silently increasing scope. Every slice stays
disabled in the default local mode until the end-to-end adoption path is ready.

| ID | One-line scope | Source lines | Dependencies |
| --- | --- | --- | --- |
| C01 | Versioned portable checkpoint/effect identities and local-mode adapter | 180 | none |
| C02 | Private object-store immutable blob IO and digest/schema validation | 220 | C01 |
| C03 | Conditional private control manifests, idempotent inputs and boundary receipts | 240 | C02 |
| C04 | GraphQL claim CAS, one-file commits, generations and ambiguous-result reads | 220 | C01 |
| C05 | Dual-clock lease/renew/release state and GitHub-time expiry | 230 | C04 |
| C06 | Shared GitHub-write guard primitive and cancellation/generation checks | 160 | C05 |
| C07 | Guard pipeline/publication/git writes, including resume and manual paths | 240 | C06 |
| C08 | Guard poller/lifecycle/review/landing writes and inventory every caller | 240 | C06, C07 |
| C09 | Export/import run phases, attempts, pinned policy and unpublished Git objects | 240 | C01, C02 |
| C10 | Export/import private artifacts, holdout isolation and evidence bindings | 230 | C09 |
| C11 | Upload-first checkpoint CAS/pointer selection and local projection recovery | 240 | C04, C05, C10 |
| C12 | Pending-effect reconciliation for pushes, PR creation and lifecycle comments | 240 | C03, C08, C11 |
| C13 | Claim adoption and return quarantine with stage/round replay bound | 240 | C12 |
| C14 | Private capability adverts, parity checks and complete-task admission | 230 | C03, C05 |
| C15 | Drain/leave state, 30-second checkpoint budget and power/sleep/network triggers | 240 | C13, C14 |
| C16 | Shared review rounds/approvals, head observation versions and revocations | 220 | C03, C08 |
| C17 | Land-lock lease and durable queue/merge checkpoint adoption | 240 | C05, C12, C16 |
| C18 | Shared issue/comment polling, lifecycle boundaries and follow-up dedupe | 240 | C03, C13, C14 |
| C19 | Shared questions/answers, cancellation and conversation admission receipts | 230 | C03, C11 |
| C20 | Account quota/accounting reservations and host-local health separation | 220 | C03, C14 |
| C21 | Authenticated member discovery and CLI/MCP idempotent failover | 240 | C14, C19 |
| C22 | Shared feed IDs/cursors and UI reconnect/snapshot refresh | 240 | C03, C21 |
| C23 | Bind gate/agent jobs and bundle results to generation and attempt | 240 | C11, C14 |
| C24 | Opt-in repository cutover/export checks, rollback gate and legacy drain | 220 | C15, C17, C18, C20, C22, C23 |

Settled pieces **carry over unchanged**: `refs/limitless/claims/<issue>` written only through
GraphQL `updateRefs` with `beforeOid`; re-read after a lost race (generic errors are ambiguous);
one-file-tree claim commits with GitHub timestamps and no Actions run; generation as fencing
token; 10-minute expiry and 3-minute renewal measured on suspend-inclusive and suspend-exclusive
clocks; the guard before every GitHub write; expiry judged only on GitHub's clock; and one
per-repository land lock using the same lease rules. REST `PATCH force:false` is not claim CAS.

What changes: claims select portable checkpoints and retain stable run identity across holders;
departure parks become adoptable, returners quarantine stale work, input/approval/effect records
become shared, and eligibility requires complete-task capabilities. Early release complements
expiry. The prior never-adopt assumptions and routine duplicate-PR tolerance are replaced by the
adoption/reconciliation rules above; an already-in-flight PR-create race remains explicit.

Each implementation slice needs fake-harness/offline-store tests for its contract; no tests call
live models, GitHub or storage. Integration acceptance before C24 enables shared mode includes
crash between blob upload/ref CAS, lost CAS response, departure during pending push/PR/merge,
simultaneous adopters, wake with stale generation, mismatched private policy, missing storage,
approval/head races, polling with webhooks off and local-mode compatibility. The complete path
must preserve consumed budgets, holdout secrecy and exact-SHA evidence across those failures.
