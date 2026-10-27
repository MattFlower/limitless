# Complete-text privacy boundaries

Design slice (c1) of #880; implementation belongs to #919 (c2). This document describes
the inspected checkout, not protection already implemented. Only this document and its
architecture cross-reference change here. All example values are synthetic.

## Rule and scope

At every storage or outbound boundary, the authoritative supported decoded private-string
check must examine complete text **before credential redaction and before any cut**.
Checking an already-redacted or clipped rendering cannot establish that invariant.
For example, removing a credential overlapping `host.example` can erase the evidence
needed to recognize the rest of that private value, including an escaped remainder.

Supported means `src/gates/private.ts:normalizedLayers`: raw text; successive percent-byte,
backslash-Unicode and HTML-entity decoding; relevant standard-base64 runs at four alignments;
whitespace-collapsed variants; NFKC and lowercase matching, with five convergence rounds.
Preserve those semantics, including literal HTML references and line breaks. Nonconvergence
withholds text even with an empty policy. This does not add slash-escape decoding (#917),
implement the ReDoS fix (#916), cover adversarial encodings (#335), or join credentials
across lines. Retain slice (a)'s ReDoS regression without changing that fix here.

## Reproducible inventory

Run from the repository root:

```sh
rg -n 'redactCredentials|privateMatches|slice\(|truncate|[A-Z_]*_TAIL' src scripts
rg -n 'redactGate|redactJsonLine|protectCredentials|privateOutputData|loadOutputPrivacy|checkPublication|sanitizePublication' src scripts
rg -n 'runProcess|runConfined|onStdoutLine|onStderrLine|tailLimit|maxLineLength|substr\(|clampData|putArtifact|setRunState|addEvent|recordOwnerDiagnostic|JSON.stringify|appendFileSync' src scripts
```

Follow producers and callers with `rg -n '<function-name>' src scripts`, then inspect their
bodies with `sed -n '<start>,<end>p' <file>`. In particular, follow `runOne` back into
`runSandboxed`/`runProcess`, parsers before `onAgentEvent`, and publication before `gh`/git.
The second and third searches catch indirect helpers, SQL cuts, recursive payloads and
publication copies that a search for `redactCredentials` alone misses. Inspect string keys,
numeric credential renderings, nested retries, error causes and historical read paths too.

Notation below describes **today**, from left to right: P = decoded private check;
C = credential redaction; T = terminal normalization bundled with C; cut = selection/cap.
“None” means no local privacy check, not that upstream text is safe. U means JavaScript
UTF-16 code units, B means UTF-8 bytes, CP means Unicode code points. Unless specified,
actual clipping is unavailable downstream; a textual omission marker is not provenance.
Rows group equivalent destinations but name the source entry points needed to trace them.

| Class; file:function | Destination and current order | Cuts and actual truncation provenance today |
| --- | --- | --- |
| A. `src/util/proc.ts:runProcess`, `lineSplitter`; `src/harness/sandbox.ts:runSandboxed` | Process tails and line callbacks: UTF-8 decode → optional T+C → tail/line cuts; no P. `onRawChunk` is an internal pre-redaction observer. | Default 64,000 U per stream; aggregate and per-stream booleans known. Optional `maxLineLength` prefix cap adds `[truncated]`, but callback has no boolean; sandbox forwarding can cap again. |
| B. `src/gates/run.ts:runOne` | GateResult/hooks → engine, workers and caches: A → T+C again → trim/join stdout and stderr → tail. Raw launch scan precedes these changes; no P. | Last 6,000 U of combined tails, plus timeout marker. Drops A's booleans; `GateResult.output` and `failures` have no clipping metadata. |
| C. `src/gates/failures.ts:FailureExcerpts.observe`, `finish`, `result`, `formatGateOutput` | A's lines → T+C (also in runOne) → diagnostic selection; formatting applies `redactGateData` then more cuts; no P. | Lines: 8,000 U and 39 buffered rows (38 with timeout); ≤10 excerpts in an 8,000-U total budget. Internal clipped/omitted known, returned only as text. Formatter default 3,000 U; excerpt budget limit−1,002 and last 1,000 U, or legacy tail of limit U. Metadata lost. |
| D. `src/pipeline/engine.ts:gateEvents`; `src/pipeline/context.ts:RunContext.event`, `onAgentEvent`; `src/db/store.ts:Store.addEvent`, `clampData` | Stored events and pub/sub: B or harness C → optional holdout filter → T+C of message/data → Store cuts; no configured-private P. | Thinking 2,000 U; tool-command state 500 U, message 300 U; tool-result message 400 U, data retains parser's output. Store message 4,000 U loses flag; serialized data 16,000 U becomes `{truncated:true,preview}`. Live event data uses original payload, stored data uses preview. |
| E. `src/pipeline/prompts.ts:formatGateFeedback`, `gateTable`, `reviewPrompt`, `verifierPrompt`; `src/pipeline/engine.ts:oneRound` | Gate diagnostics → C's formatter → feedback; some engine feedback applies T+C → `redactPrivate` (literal replacement then P). Final assembly reaches F. | Inherits B/C cuts without provenance. Review patches/first-parent patches cap at 40,000 U with textual length notices; implementer report at 4,000 U without a flag. |
| F. `src/pipeline/context.ts:RunContext.invoke`; `src/pipeline/triage-decisions.ts:condenseRequest`, `triageDecisions`; `src/concierge.ts:Concierge.prompt`, `interpret` | Model dispatch: invoke applies T+C to final prompt/system append, no P. Decision and concierge contexts also construct model inputs outside gate formatting. | condenseRequest caps fields at 12,000 U (MAX_FIELD) with hidden-character counts; triage title/text/reason 80/2,000/300 U. Concierge selects 30 messages, old contents 1,600 U, 100 repo slugs at 300 U, 15 run titles at 200 U; flags unavailable at dispatch. |
| G. `src/harness/types.ts:redactJsonLine`, `protectCredentials`; `src/harness/claude.ts:runClaude`, `ClaudeStreamParser.feed`; `src/harness/codex.ts:runCodex`, `CodexStreamParser.feed`, `item` | Invocation logs, events and results: parse JSON → recursive C (including keys/numbers) → optional text filter; parser receives C'd JSON. stderr uses optional filter, protected spec applies C; no configured-private P. | Parsers cap malformed status at 500 U and tool output at 20,000 U before D. Process tails default 64,000 U; final stderr/error tails 2,000 U; flags not carried into AgentEvent/AgentResult. Logs also receive pre-parser lines. |
| H. `src/harness/decisions.ts:errorDetail`, `runDecisions`; `src/harness/browser-mcp.ts:browserMcp` | Provider HTTP diagnostics/logs and browser warnings: JSON field selection, auth-token replacement/C and optional log filter; no authoritative P. | Decision error normalizes whitespace and caps 200 U; no provenance. Browser warning has no local text cap. Full HTTP text may exist before selection. |
| I. `src/pipeline/context.ts:redactPostMergeComparisons`, RunContext constructor, `save`, `artifact`; `src/pipeline/engine.ts:oneRound` | Post-merge comparisons/state/artifacts: attribute workers using name matching → recursive T+C, including retry/confirmation diagnostics → save/putArtifact. Constructor sanitizes resumed comparisons; no P. | Inherits B/C and remote cuts. No local cap or clipping flags; worker attribution collisions become null. JSON artifacts are parsed before C; plaintext artifacts use T+C. |
| J. `src/db/workers.ts:WorkerStore.sanitize`, `agentJobEvents`, `event`, `complete`, `fail`; `src/workers/client.ts:runWorker`; `src/workers/reporting.ts:agentPathMask` | Worker result/event/error persistence and HTTPS: sanitize = recursive T+C → privateOutputData(P then C); agent batches use recursive C separately. Client masks paths after C; coordinator sanitizes again. | Upstream gate/parser cuts; client failure/update warning 4,000 U. Missing source provenance; worker results and nested keys must be covered, not just summary strings. |
| K. `src/util/private-output.ts:loadOutputPrivacy`, `privateOutputData` | CLI/MCP/worker outward copies: P with private entries plus registered credentials → C, or withhold on `[redacted]`; policy load failure returns null. Recursive values and keys checked. | Optional truncated argument defaults false; recursive adapter never supplies per-field flags. Correct local order cannot repair previous C/cuts. |
| L. `src/integrations/mcp.ts:compactRun`, `createMcpServer` | MCP JSON content: tool result → recursive T+C → K; errors T+C → K. compactRun calls K before title/error cuts, final wrapper follows. | Title/error 200/500 U; explained land reason 500 U; events inherit Store caps. No per-field flags. Feed budget applied after substitutions. |
| M. `src/integrations/mcp.ts:httpBackend`; `src/integrations/mcp-http.ts:mountMcp` | HTTP backend errors: first C(raw body), then, if valid JSON, replace with serialize(C(parsed body)); outer handler later T+C → P. Successful responses parse JSON. SDK HTTP transport forwards handler content without another privacy check. | No local body cap, but upstream daemon messages may be clipped. Both literal/escaped spellings can be erased before P, despite JSON parsing; network exception also C'd before outer P. |
| N. `src/integrations/mcp-change.ts:getChange`, `redactReport`, `buildReportRedactor` | Change-view reports/diffs/files: complete available patch/report filtering with policy and holdout catalogue → page → K; historical sources may already be C'd or clipped. | PATCH_CAP 16,000 U, REPORT_CAP 4,000 U; file lists ≤50 entries/16,000 serialized U per page. Page knows suffix omission via `offset+cap<length`, not upstream loss or omitted prefix. `report-sources.json` retains some complete pre-display sources. |
| O. `src/db/store.ts:Store.addFeedItems`, feed-producing SQL migrations; `src/feed.ts:limitFeedPage`; `src/cli/digest.ts:printDigest` | Feed DB/API/MCP/digest: producer-dependent C/none → SQL substr; API uses T+C, MCP adds K; digest recovers run/question/land source → K → display cut → quote. | DB title/summary 200/500 CP, no field flags. Digest infers clipping from fallback length ≥200/500 CP. Display caps 200/500 CP and 20 total lines. limitFeedPage knows oversized-item replacement (`truncated:true`), ≤100 items/16 KiB serialized JSON; that is not field provenance. |
| P. `src/server/http.ts:serialize`, `redactGateArtifact`, `sse`, `profileText`, `createHttpRoutes`; `src/cli/main.ts:api`, `follow`, `formatEvent`, `main` | HTTP JSON/errors, SSE backlog/live, artifact/log downloads and CLI stdout/stderr: recursive T+C, artifacts parse JSON first; CLI API errors C, event display whitespace fold then cut. No P. | profileText 64 KiB B after C; event display 220 U and run-list title 60 U, flags lost. Log reads inherit G; serialization has no cap. Routing/authentication does not sanitize content. |
| Q. `src/pipeline/report.ts:clipText`, `clipCell`, `renderReportArtifacts`, `saveReport`; `src/pipeline/report-privacy.ts:reportText` | Report artifacts and later PR/MCP copies: input-specific T+C/path rewriting → rendering/cuts. No universal complete-source P before rendering. | Cells 300 U; implementer summary 5,000 U at line when possible. clipText keeps full `source` on a real cut, recorded in report sources; private spans can omit source because entire span is withheld. This provenance must survive adapters. |
| R. `src/pipeline/engine.ts:publicationText`, `checkPublication`, delivery callers; `src/land/queue.ts:LandQueue.reportBody`, `checkPublication`; `src/integrations/issue-lifecycle.ts:reconcileIssueLifecycle` | PR bodies/comments, squash body and issue comments: C/path rewriting → P on resulting publication copy; range inspection separately checks original commits. | Blocked evidence 300 U, blocked comment 60,000 U before P; no flag. Report sources/cuts inherited. Workflow/discreet checks remain separate. |
| S. `src/pipeline/engine.ts:commitMessage`, `mergeMessage`, `oneRound`; `src/git/repos.ts:slugify`, `commitAll`, `checkPrivatePublication`, `mergePullRequest`; `scripts/check-private-strings.ts`; `scripts/land-pr.sh` | Commit/merge/squash metadata, branch/tags/files: commitAll writes supplied message; private publication scans original range metadata/objects before push/merge. Manual script checks subject/branch too. | slugify default 40 U; CI-fix commit report C → trim → 2,000 U; title may originate Store's 80-U cut. Original range metadata checked without display cuts; sh refuses oversize results. Local commit metadata can precede P. |
| T. `src/util/proc.ts:sh`; `src/pipeline/context.ts:RunContext.invoke`, `runStage`; `src/pipeline/engine.ts:executeScopedRun`; `src/pipeline/review.ts:runReview`; `src/router/providers.ts:ProviderTracker.record`, `blockModel` | Thrown errors, invocation/run state, routing health and review diagnostics: C/T+C or none → error selection/cut → storage/logs, no universal P. | sh captures ≤50,000,000 U per stream and refuses overflow, but CommandError message C → 4,000 U; stdout/stderr remain attached. Routing attempts 300 U, validation 500 U, run errors 2,000 U, panel skips 300 U; provider blocks/failure/quota reasons 200/300 U. Flags lost. |
| U. `src/db/store.ts:Store.insertRun`, `updateRun`, `updateInvocation`, `setRunState`, `putArtifact`, `recordOwnerDiagnostic`, `recordCiFixTrigger`, `recordInbox`, `addChatMessage`, `recordEvalTrial` | Additional SQLite boundaries: caller-supplied data, generally no central P/C. Owner diagnostic uses T+C; CI failure fields C before persistence. Outward readers later apply their own filters. | Prompt-derived title 80 U; CI check/line 500 U, excerpt 2,000 U. Other JSON/text has no local cap, but callers may already cut it. Trusted execution/checkpoint data must remain distinct from display copies. |
| V. `src/integrations/discord.ts:GatewayDiscordPort.start`, `createThread`, `sendMessage`; `DiscordIntegration.start`, `command`, `mention` | Discord replies, messages, embeds and thread names: source-specific filters/none → display cuts → network; no universal P/C. | Content 2,000 U; intermediate chunks/errors 1,900 U, question 1,850 U; thread 100 U, embed title 256 U. Flags absent; selection/chunking is not a complete-text check. |
| W. `src/cli/service.ts:gates`, `tailLines`; `src/land/redact-deploy.ts:module body`; `src/land/deploy-process.ts:deployJobStatus`; `src/evals/implement.ts:gradeImplement`; `src/util/ssh-tunnel.ts:SshTunnels.spawn`; `src/workers/update.ts:updateWorker` | Deploy logs/errors, eval feedback, tunnel errors and worker update errors: C or none → tails → logs/state/network; no P. | Deploy tail 60 lines/4,000 B (1,000 B with excerpts), lines last 500 U; deployJobStatus last 4,000 U after C; eval last 6,000 U; tunnel stderr last 500 U; update details each floor(3,800/count) U after C. Flags lost. |
| X. `src/app.ts:Factory.constructor`; `src/cli/daemon.ts:startDaemon`; `src/gates/slots.ts:DatabaseSlotPool.schedule`, `refresh`, `armLease` warnings; `src/integrations/github.ts:githubWebhook`; `src/integrations/issue-queue.ts:startIssueQueue`, `src/integrations/github-poller.ts:startGitHubPoller`, lifecycle logging; `src/land/auto-deploy.ts:AutoDeploy` methods | Console/service logs, inbox notes, provider/catalog/capability warnings: generally C only; no uniform P and no common local cap. Error objects can inherit T's cuts. | Unavailable upstream provenance. Include `src/cli/gate-slot.ts`, `agent-test.ts`, `src/workers/capabilities.ts`, router runtime-policy/catalog diagnostics and browser/read-policy errors through the same error adapter. |
| Y. `src/gates/audit.ts:auditDiff`; `src/git/repos.ts:checkPrivatePublication`; `scripts/review-escape-cases.ts:reviewEscapeCases`; `scripts/implement-replay-cases.ts:generateReplayCases` | Audit findings/persisted lastAudit, publication refusals, generated case files/console diagnostics: audit scans original added text and sanitizes findings using P including credential spellings; scripts mix P-first candidate checks and C → redactPrivate diagnostics. | No local display cap for findings; git sh overflow refuses. Scripts' report/error redactions cannot establish completeness of already-clipped source data. Synthetic benchmark/demo/build scripts are not production disclosure paths. |
| Z. `src/integrations/ci-classifier.ts:publication`, `bounded`, `ciSignature`; `src/db/store.ts:Store.recordCiFailure`, `recordCiFixTrigger` | GitHub CI log/signature → feed, persisted failure, retry prompt/comment: select a credential-padded window → C → trim/cut; no P on complete log. | Line/check default 500 U, excerpt 2,000 U, context windows 500 U. Padding preserves credential overlap only; original private-check/truncation provenance lost. |
| AA. `src/server/auth.ts:Auth.signIn`; `src/server/passkeys.ts:Passkeys.register`; `src/cli/setup.ts:safe`; `src/cli/deploy-wait.ts:localDeployClient`; `src/evals/checklist.ts:checklistPrompt`; `scripts/smoke.ts:formatRow`, `verifyLiveCheck`; `scripts/packaged-smoke.ts:main` diagnostic filter | Device labels → SQLite/API; setup/deploy/checklist/smoke diagnostics → console or stored report: labels cut without P/C, diagnostics use C or source-dependent filtering; no uniform P. | Device labels 256 U; smoke reasons whitespace-folded to 240 U, retry note 200 U, verifier error 2,000 U. Checklist selects whole items up to 12,000 U with an omitted count; setup masks configured values before C. Clipping flags absent. |
| AB. `src/pipeline/agent-gate.ts:sessionResult`; `src/gates/agent-tests.ts:AgentTestSession.request`; `src/cli/agent-test.ts:agentTestCommand` | In-session factory gate → capability reply → agent-test stdout read by the running model: B → redactGateData → formatGateOutput → T+C, then C again in request and CLI. Command name C → agent-test event (D). No P. | Inherits B/C cuts plus formatter 3,000 U; reply `{status,text}` has no clipping field. |
| AC. `src/pipeline/preview.ts:startPreview`; `src/pipeline/engine.ts:oneRound` (`preparePreview` stage) | Preview build/seed/serve output → thrown Error → stage failure, run error and events (T/D): runConfined without `redactOutput`, so raw tails/lines → cuts → later C; no P. | Process tail 4,000 U, serve lines `maxLineLength` 4,000 U, readiness log last 4,000 U, build/seed error last 4,000 U after trim. A's booleans dropped; serve-exit error untrimmed tail. |

Every other first-search file is folded into a row or excluded as not publishing free text:

- Folded: `src/gates/output.ts` (B: raw launch scan, redactGateOutput); `src/gates/publication.ts` (R: path rewriting, publicationMatches aliases P); `src/util/terminal-redaction.ts` (T's matcher buffers); `src/evals/runner.ts` (W: C'd setup output/errors); `src/pipeline/review-shadow.ts` (T: shadow reason cut to 500 U before ctx.log's C); `src/pipeline/lan-agent.ts`, `src/gates/inplace.ts` (J/X: C'd job errors/logs); `src/git/confinement.ts`, `src/harness/read-policy.ts`, `src/integrations/github-identity.ts`, `src/router/runtime-catalog.ts`, `src/router/runtime-policy.ts` (X: C'd errors/warnings); `src/workers/validation.ts` (J: refuses credential-bearing ingress); `src/core/types.ts` (O: FeedItem.truncated is pagination).
- Excluded src: `src/harness/stream-fault.ts` (fixed message), `src/gates/test-coverage.ts` (comment), `src/integrations/github-token.ts` (refuses truncated token output), `src/integrations/github-notifier.ts` (check-list pagination); argv/path/config parsing in `src/cli/auth.ts`, `src/cli/setup-config.ts`, `src/config.ts`, `src/gc.ts`, `src/git/command.ts`, `src/git/hardening.ts`, `src/harness/landlock.ts`, `src/harness/scratch.ts`, `src/harness/signals.ts`, `src/harness/slotted.ts`, `src/pipeline/gate-evidence.ts`, `src/server/workers.ts`, `src/util/cidr.ts`; date/hash/ID shortening in `src/core/since.ts`, `src/db/migration-runner.ts`, `src/pipeline/markers.ts`, `src/router/config-catalog.ts`, `src/router/router.ts`; arrays/counts/bytes in `src/evals/stats.ts`, `src/gates/attribution.ts`, `src/gates/docs.ts`, `src/gates/lan.ts` (copies J's events), `src/gates/media.ts`, `src/pipeline/shadow-report.ts`, `src/util/stall.ts`.
- Excluded scripts (synthetic data, argv, paths, sampling): `scripts/seed-demo.ts`, `scripts/benchmark-holdout-redaction.ts`, `scripts/benchmark-worker-reporting.ts`, `scripts/build-binary.ts`, `scripts/build-site.ts`, `scripts/site-screenshots.ts`, `scripts/git-confined.ts`, `scripts/probe-process-recovery.ts`, `scripts/review-pending.ts`, `scripts/review-trace.ts`, `scripts/spike-ci-timing.ts`.
- Second/third searches, folded: `src/gates/executor.ts`, `src/gates/junit.ts` (B/C); `src/pipeline/post-merge-confirmation.ts` (I); `src/harness/llm.ts` (G logs); `src/integrations/mcp-status.ts` (K/L); `src/pipeline/verification.ts` (E/F verifier request); `src/pipeline/agent-executor.ts` (T reader-setup error); `src/cli/owner-diagnostics.ts` (U/P, T+C then print); `src/workers/publication.ts` (S branch checks). `src/gates/cache.ts` and `src/gates/detect.ts` compare redacted names internally and are excluded.

Include excluded files' error callers in T/X when those do publish. Feed/CI list `truncated`
flags describe pagination or missing observations, not text clipping. Credential files, API
authorization headers and model authentication are intentional secret transport, not diagnostic
output; filtering them would break authentication. Repository content publication retains its
existing refusal checks rather than rewriting source files.

## One shared contract (proposed)

Introduce `protectText` and its opaque result `BoundaryText` in `src/util/privacy-boundary.ts`.
It uses the decoder/matcher in `src/gates/private.ts`, the compiled credential matcher in
`src/util/credential-matcher.ts` and terminal handling without importing proc.ts back into itself.
No boundary invents a second private matcher. Existing APIs become adapters to this contract.

Input: `{text, provenance, policy, cut?, terminal?}`. Provenance is a tagged union:
`complete`, `cut` with `truncated:true`, or `legacy-unknown`. Only the capture/reader that
possesses the original may assert complete. `cut`/unknown without a verifiable checked-source
receipt returns a fixed withheld marker, not a prefix-based guess. Never assert that the
original was checked because the retained fragment passed P, or because its length is small.

For complete input: check raw text through all supported decoded forms; if terminal controls
will be removed, check the complete visible form too **without credential replacement first**.
Any match, unreadable policy, invalid input decoding, nonconvergence or resource refusal
returns a fixed marker and a reason code containing no source text. Otherwise apply C, then
any path/holdout/display transformations and requested cut. Recheck newly assembled/rendered
text for matches introduced by joins or rewriting; retain the prior source-check evidence.
Never use C's output as a substitute for examining its original. Publication adapters may
refuse instead of substituting a marker when changing commit metadata would change intent.

Output: `{text, truncated, checkedComplete, withheld, policyDigest}` inside BoundaryText.
`truncated` is true only if some original source exceeded a real cap (including omitted rows,
prefixes or suffixes), false for known complete uncut text, undefined for unknown history.
For each new cap compare source length **before that cut**, in its declared U/B/CP/row units:
equality is not clipping. Propagate prior true; a later cut cannot clear it. Prior unknown
remains unknown unless a new actual cut establishes true. Withholding is separate from clipping.

Cuts consume BoundaryText but preserve only evidence about the complete source, **not proof
that the cut rendering is safe**. NFKC is sensitive to cuts: with policy `host.example`,
`"host.example\u0301"` has no match, but `.slice(0, 12)` removes the combining acute accent
and exposes `host.example`. Every changed rendering (including line selection, trim, prefix,
tail, byte cut and omission-marker joins) must pass P on its exact bytes before storage or
emission, in addition to the complete-source check before C and cuts. Pass actual clipping
provenance to P's partial-prefix check; false stays false for a complete exact-limit message.
A match/refusal withholds the whole candidate; do not repeatedly shorten it until it passes.
Concatenation tracks component provenance and checks the full new rendering before its cut,
then validates the cut result. Further rewriting/C also requires exact-output validation.
Only byte-identical output with the same policy/credential version may reuse a rendering
receipt. A cut never transfers that receipt, even when the source receipt remains available.
Arrays/objects use one recursive adapter for values, string keys and numeric display strings;
key collisions after withholding replace the containing diagnostic object rather than overwrite
another field. Parse complete JSON before field sanitization, and check complete raw fallback
text if parsing fails. This is essential for mixed literal/escaped MCP HTTP error fields.

Mapping: A/B/G/W/AC use capture adapters; C/E/F/Q/Z/AB use formatting adapters; D/I/J/T/U/AA use
persistence adapters; K/L/M/N/O/P/R/S/V/X/Y/AA use output/publication/error adapters. All call
protectText on originals, or consume an internally issued BoundaryText with matching policy.
Keep raw gate names, worker association keys, commands and machine verdicts internal; produce
safe diagnostic projections separately. Remote clients/models cannot grant themselves a proof.
Worker ingress validates through the same adapter; caller-supplied booleans are not evidence.

Persist optional per-field `textPrivacy` metadata alongside existing diagnostic JSON: source
truncated state, check version/policy digest and digest of the exact safe field. Bind a receipt
to factory-written bytes, not an arbitrary model object's claim. Credentials added or policy
changed invalidate reuse; unavailable originals then require withholding. Do not persist raw
sources merely to recheck them later. Cached receipts contain no private text or credentials.

## Streams: complete capture before publication

Choose complete capture, not a sliding window. The actual decoder accepts arbitrarily long
backslash runs, base64 runs and whitespace sequences; NFKC can depend on combining sequences.
A bound from “longest entry × six” does not justify equivalence to normalizedLayers.

For gate diagnostics retain stdout/stderr in private process memory, with one **aggregate cap
of 8 Mi U** per running command. Decode UTF-8 incrementally with fatal error detection so a
split multibyte character is preserved. Do not write raw capture to scratch, logs or events.
Raw launch/coverage/attribution scanners may classify internally; their diagnostic strings
cannot leave that internal state before protection. Preserve raw confinement verdicts.
Bound internal scanners' line buffers too; overflow marks evidence incomplete without retaining
an oversized line. Gate classification must not depend on releasing free text for publication.

At both EOFs, check each complete stream, plus the complete joined diagnostic rendering, before
C, line framing, excerpts or the 6,000-U tail. Avoid an extra joined scan when one stream is
empty and joining/trim adds no new text. Then release sanitized BoundaryText to those consumers.
Consumers validate each changed excerpt/tail/line rendering before releasing it in turn;
stream completion alone does not certify a normalization-sensitive cut.
If a process times out/cancels before a complete logical value, mark provenance unknown and
withhold its free text; retain typed exit/timeout/confinement facts. Decode failures do likewise.
If the cap is exceeded, discard retained free text, drain the rest without buffering, record
actual `truncated:true`, and emit only fixed withholding text at completion. No partial early
publication is allowed. This limits retained stream state regardless of command output size.

Harness JSONL needs the same ordering before log append, protectCredentials and parser cuts.
Complete JSON records are parseable internal input; check all scalar fields/keys before C.
Accumulate incremental text for a logical message until its completion event; intermediate
free text can be withheld while typed progress/status still flows. Apply the same aggregate
cap, discard/withhold overflow and incomplete messages, and never log unchecked raw records.
This adds conservative withholding, not a second harness execution or a control-flow decision.

## Cost, retained state and c2 benchmark

No performance measurement was made for this documentation change. The issue reports about
1.3 s for privateMatches on 5 MiB with eight private entries. That is a baseline observation,
not a guarantee, and cannot be multiplied by 600 to predict a compiled credential scan.

Prepare normalized entries, minimum base64 candidate length and literal search structures once
per policy digest; reuse the credential automaton across all 600 registrations. Decode each
candidate/form once, matching the prepared private and credential policies against it; avoid
normalizing every entry again for each base64 token. Preserve current match/refusal semantics.
Use one traversal of decoder forms, checking and releasing obsolete forms instead of retaining
normalizedLayers' whole array. This is a performance adaptation, not a new decoding language.

For 5 MiB mostly ASCII stdout, eight entries and 600 synthetic credentials, budget one complete
raw check; a second full visible-form check only if terminal stripping changes text; and one
terminal/credential pass after acceptance. With nonempty stderr the joined view adds a check.
Each “check” can visit up to 16 forms across five rounds; it is not one byte scan. Base64 can
try four alignments per relevant run. Reuse complete-source evidence across consumers, but
check each distinct cut/rendering; reuse exact safe bytes for repeated events/prompt fragments.
Never scan each growing stream prefix or run a 600-entry regex loop on every output chunk.

Estimate for unchanged decoder cost: ~1.3 s private work with one form source, ~2.6 s with
raw plus different visible source, and up to ~3.9 s with another joined source, plus roughly
0.1–0.6 s for normalization/credential/output handling. These are planning estimates only;
prepared policies may improve them, and escape-heavy output can cost more. Measure the
combined path, including decoded credential checks, before accepting a c2 performance claim.
Add work proportional to the sum of distinct rendering lengths, not just captured bytes:
an 8,000-U excerpt plus a 6,000-U tail adds about 3.5 ms at the reported ASCII baseline rate
per validation pass (estimate, not measurement). Line/excerpt selection, final C'd output and
prompt assemblies add further checks; one extra full 5-MiB rendering adds about 1.3 s.
Cache only exact renderings under policy/credential version; record lengths/scan counts and
bound cache retention within the checker budget. Check cut candidates serially.

Five MiB ASCII uses ≤10 MiB per UTF-16 text copy; capture, visible/output and several current
decoder forms suggest ~60–120 MiB peak text storage, plus matcher/object overhead. The capture
cap bounds raw retention at 16 MiB; decoder expansion needs a separate 32-Mi-U per-form cap
and refusal before retaining oversized forms. Normalization may transiently expand further;
measure RSS rather than claiming the capture cap bounds total memory. Stream forms one at a
time and budget ~250 MiB per active checker including temporary copies, subject to measurement.
Existing gate concurrency bounds concurrent captures; do not add unbounded checker parallelism.

Reproduce locally in c2, without network, models or owner configuration:

1. Under `mkdtemp(os.tmpdir())`, make a disposable Bun driver importing the checkout by absolute
   file URL. Pass eight explicit synthetic entries (`host.example` variants) and register 600
   distinct `<credential>`-based synthetic values. Never load the real private-strings file.
2. Generate exactly `5*1024*1024` ASCII bytes, with ordinary lines and sparse synthetic matches;
   repeat with SGR, mixed supported escapes, a long base64 run, both streams and no matches.
   Feed 32-KiB chunks, then single-byte splits around escapes/UTF-8. Include cap+1 overflow.
3. In fresh processes for base and c2, use two warmups and five timed trials; report medians,
   Bun/OS/architecture, total bytes, scan counts, compilation time separately, retained capture,
   peak RSS and receipts reused. Instrument synthetic consumers for events/excerpts/prompts,
   counting post-cut checks too; include combining-mark cuts and many distinct excerpts.
   Report full before/after timings and verify identical safe output across chunkings.
4. `bun scripts/benchmark-credential-redaction.ts <baseline-proc.ts>` supplies a separate
   credential-only comparison (see its header for snapshot setup); it does not measure P.
   Keep all drivers/snapshots/output in scratch and remove them. Tests never assert timings.

## c2 adversarial regression matrix

Each row names the inventory classes it covers. Use explicit synthetic policy/credentials,
fake harnesses, fake HTTP/Discord/gh ports and disposable local git/SQLite; no real services.
Observe final bytes and stored fields, not a model's assertion that checking happened.

| Classes / trigger construction | Observable result required | Existing test target or local approach |
| --- | --- | --- |
| A/B: emit `host.exam\\u0070le` in chunks; register `host.exam` as overlapping credential, then also test literal prefix plus escaped remainder and Unicode-normalized variants. | GateResult, stored gate event and implement prompt withhold the complete affected diagnostic; neither escaped remainder nor private prefix survives. Raw confinement detection still works. | `test/proc.test.ts`, `test/gates.test.ts`, `test/gate-feedback.test.ts`. |
| A/B/C: place a private value so last-6,000-U selection starts inside `\\u002e` or `%2e`; exceed process tail too. | Tail is derived only after full-source withholding; process/gate flags remain true even if marker is short. Exactly-at-limit clean streams retain false. | `test/gates.test.ts`, `test/proc.test.ts`. |
| C/E: place host.example across the 8,000-U line/excerpt and formatter cuts; also exceed row/excerpt count. | Excerpts and formatted feedback cannot leak a prefix; real omissions propagate true through formatGateOutput to saved prompts. Legacy excerpts without source are withheld, not certified complete. | `test/gate-feedback.test.ts`, `test/pipeline-gates.test.ts`. |
| All cut adapters: policy `host.example`, source `"host.example\u0301"`, then `.slice(0, 12)`; place the same combining sequence at excerpt, tail, byte/CP and field caps, including a second cut of checked output. | Assert source P has zero matches and candidate P has one; every stored/emitted cut withholds, keeps actual truncated:true and gains no safety receipt from its source. Uncut safe control remains visible. | `test/publication-text.test.ts`, `test/gate-feedback.test.ts`, `test/proc.test.ts`; table-driven shared-contract checks in c2. |
| D/T/U: complete message of exactly 4,000 U ending `host.` with policy host.example; compare 4,001-U source cut to same limit, and old row with missing metadata. | Complete exact-limit safe text remains visible with false; actually cut text has true; unchecked cut/legacy text is withheld. Data preview and live SSE never bypass checks. | `test/pipeline-gates.test.ts`, `test/proc.test.ts`; temporary Store plus route fixture. |
| D/G/H: tool result >20,000 U, thinking >2,000 U, malformed JSON/status, nested credential key/number and error cause; private value crosses each cap or message delta. | Logs, AgentResult, event message/data and invocation error contain safe text/markers; no raw early append. Auth/decision error caps preserve provenance; incomplete delta is withheld. | `test/harness.test.ts`, `test/decisions.test.ts`, `test/browser-mcp.test.ts`. |
| E/F: full diagnostic/report/patch includes private entry just beyond 3,000/4,000/40,000-U cuts; concierge history/decision field similarly crosses its cap. | Inspect captured AgentSpec prompt/system/decision payload: private source withheld before selection, all final dispatch paths covered. | `test/gate-feedback.test.ts`, `test/triage-decisions.test.ts`, `test/concierge.test.ts`; fake harness. |
| I/J: post-merge firstAttempt/targetedRetry/coordinatorConfirmation, worker attribution map key, worker event batch and error each contain escaped host.example overlapping a credential. | SQLite state/artifacts/jobs/events and worker HTTP body withhold private fields without changing worker attribution/verdicts; restart keeps flags. | `test/workers.test.ts`, `test/pipeline-gates.test.ts`, `test/gate-evidence.test.ts`. |
| K/L/M: HTTP non-2xx JSON with one literal and one Unicode-escaped private/credential field, including keys; also malformed JSON and transport exception. | Stdio and HTTP MCP isError content withhold both spellings before C; JSON parsed first when valid. Status-only fallback remains safe with unreadable policy. | `test/mcp-proxy.test.ts`, `test/mcp-http.test.ts`, `test/mcp.test.ts`. |
| N/Q: private value crosses report cell/summary/page cut, Markdown entity boundary or diff page; source is present versus legacy missing source. | Report artifact/source sidecar and change-view pages cannot expose a private prefix; clean page offsets/budgets still work and source omission is explicit. | `test/mcp-proxy.test.ts`, `test/report.test.ts`, `test/report-redaction.test.ts`. |
| O: titles/summaries exactly 200/500 CP versus cap+1, astral characters, recoverable source and feed-only legacy row; oversized serialized item. | Stored feed metadata, digest stdout and MCP/feed pages distinguish true/false/unknown without length heuristics; safe complete text stays readable. Pagination flag remains separate. | `test/digest-cli.test.ts`, `test/feed-store.test.ts`, `test/feed-http.test.ts`. |
| P: nested private keys/values in REST errors, SSE backlog/live, artifact JSON/plaintext, log download, profile sample and CLI event. | HTTP/SSE/download/CLI bytes withhold before byte/U caps; key collisions withhold object, no lost diagnostic replaces another. | `test/profile-http.test.ts`, `test/feed-http.test.ts`, `test/feed-cli.test.ts`; route fixture for artifacts/events. |
| R/S: overlapping credential in PR comment/body, commit subject/author/tag/branch, squash body and issue comment; entry straddles commit-report cut. | Fake gh receives no unchecked text; local metadata publication refuses or withholds before write, original range inspection still blocks private objects. | `test/github-delivery.test.ts`, `test/git-integrity.test.ts`, `test/publication-text.test.ts`; manual script with fake gh. |
| V: private value beyond Discord 100/256/1,850/1,900/2,000-U selections, including embed and thread name. | Fake port observes safe full-source substitution before every network cut, no private fragment in reply/error. | `test/discord.test.ts`. |
| W/X/Y: private value in deploy output/tail, eval/tunnel/update error, provider/catalog warning, audit filename/detail and script-generated case. | Captured log, persisted reason, script output and fake worker HTTP contain only safe projections/markers; fixed machine fields unaffected. | `test/deploy.test.ts`, `test/deploy-process.test.ts`, `test/workers.test.ts`, `test/pipeline-audit.test.ts`; scratch script fixtures. |
| Z/AA: CI window splits private value beyond credential padding; device label crosses 256-U cut; setup/checklist/smoke/deploy-client error contains escaped host.example. | Stored label/signature/feed, retry prompt and printed diagnostics withhold before cuts; synthetic safe exact-limit controls stay visible. | `test/ci-classifier.test.ts`, `test/auth-http.test.ts`, `test/deploy.test.ts`; fake setup/smoke ports with no live probes. |
| AB/AC: failing in-session factory gate and preview build/seed/serve print escaped host.example overlapping a credential beyond the 3,000/4,000-U cuts. | agent-test stdout, capability reply, stage error and stored run error/events withhold it; exit status/readiness verdicts unchanged. | `test/agent-test-session.test.ts`, `test/agent-test-cli.test.ts`, `test/preview.test.ts`; fake handler, local `sh` preview commands. |
| All adapters: policy read failure, >5 decoding rounds, invalid UTF-8, EOF/cancel mid-message, cap+1 stream, metadata forged by model/old writer. | Fixed marker/refusal, no source-bearing exception; no unchecked chunk published; true only for observed cuts, unknown for unproven completeness. | `test/publication-text.test.ts`, `test/proc.test.ts`, `test/harness.test.ts`, `test/workers.test.ts`. |
| Decoder regression: long backslash run followed by incomplete/nonmatching Unicode escape, doubling 32/64/128 Ki U; same private match near end. | Correct match/clean/refusal result without pathological runtime; retain #916's existing reproduction verbatim as regression input, no timing assertion/fix here. | `test/publication-text.test.ts`; synthetic benchmark above for scaling. |

## Compatibility and implementation slices

Historical rows remain readable and are never destructively rewritten. Missing textPrivacy
means unknown, not false; prefer an available complete source, otherwise withhold free-text
diagnostics on outward reads. Preserve IDs, counts, status and typed verdicts. Recheck old
report sources too: “full source” relative to a display cut may already contain redacted text.
Owner-visible formatting/data remains as today except additional conservative withholding.

New metadata is optional, additive JSON next to existing strings, tolerated by old readers
and absent from old writers. Verify strict worker/MCP validators accept optional fields before
sending them. An old writer changing a row invalidates a bound field digest; never reuse stale
proof. If feed/event scalar fields need metadata, add a new table keyed by row ID in a new
timestamped migration, following `src/db/migrations/README.md`; no table rebuild or extra column
on a positionally inserted table. Old release inserts and reads must continue after rollback.
Old releases do not gain the new protection; old/new mixed operation treats missing proof as
unknown. Omit new wire metadata for peers that reject it; never require it to resume a run.
Keep executable commands, checkpoints and routing state usable; apply conservative
filtering to diagnostic projections rather than rewriting execution inputs or dropping rows.

Resume from existing phases/checkpoints without repeating gates, invocations, commits or PR
comments just to obtain source text. Completed old results can be withheld diagnostically;
only genuinely interrupted work uses its existing resume path. Persist proofs with their
diagnostic value atomically; an interrupted capture has no complete-source proof to recover.

c2 estimate: **about 900 changed lines**, including tests and counting additions/deletions.
Use these dependency-ordered slices, each reporting its protected classes, rather than one PR:

| Slice / dependency | Scope and changed-line budget | Verification before claiming coverage |
| --- | --- | --- |
| c2.1 / slice (a) | Contract/prepared policy/provenance + recursive adapter and post-cut validation, ~115 implementation + 85 tests = 200. | publication-text/credential tests including combining-mark cuts, synthetic scan/memory benchmark; no universal protection claim yet. |
| c2.2 / c2.1 | Complete bounded gate capture, excerpts/tail and gate metadata, ~100 + 70 = 170. | proc/gates/feedback tests; split/overlap/cap cases and whole gate benchmark. Other producers remain explicitly unaudited. |
| c2.3 / c2.2 | Harness logs/results/events, prompts and post-merge/worker persistence, ~110 + 70 = 180. | harness/pipeline/workers restart tests; no unchecked log append, flags survive persistence. |
| c2.4 / c2.3 | MCP transport/results, REST/SSE, privateOutputData, feed/digest/change/report adapters and optional metadata storage, ~120 + 80 = 200. | MCP/feed/digest/report/HTTP tests plus old-writer/new-reader and rollback migration fixtures. |
| c2.5 / c2.4 | PR/commit/Discord/deploy/eval/log/script adapters and remaining audit, ~90 + 60 = 150. | Publication/delivery/Discord/deploy/eval tests and repeat inventory search; claim universal coverage only when every row is accounted for. |

Ship adapters only with their source provenance path; unconverted/missing proof is withheld,
never represented as checked. Each slice runs affected test files, Biome on supported changed
files and `bunx tsc --noEmit`; factory gates run the full suite. If a slice overruns its estimate,
split by producer/consumer with the same conservative interim contract instead of silently
expanding its scope. No implementation, tests, benchmark code or migration is added in c1.
