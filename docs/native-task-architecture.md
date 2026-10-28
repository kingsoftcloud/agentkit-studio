# Native task execution and presentation boundaries

## Scope and delivery order

This change is developed and reviewed in the Studio branch first. Native source packages are staged under `packages/agentkit-harness-{core,node,ui}` to keep the GitHub change reproducible and reviewable. They retain their public npm APIs and cannot import Studio or DSH. Studio consumes their packaged artifacts. After GitHub verification, the same reviewed package sources and their build inputs are synchronized to `ksadk-harness`; this is one implementation, not two independently maintained runtimes. No main merge or public npm publication is part of this change.

## Execution control and durable history

The run journal remains authoritative for configuration, intents, receipts, tool observations and terminal outcomes. Session UI records are projections. A lease renews only lease metadata; event polling reads only the requested sequence suffix; cancellation polling reads only unconsumed commands. These control operations must not deserialize all past receipts and commit payloads. Commit replay uses a versioned SHA-256 identity of the canonical batch, while the actual batch contents remain in the snapshot/event/receipt journal.

SQLite schema 2 compacts legacy commit identities atomically on open. Stop old owners before opening an existing database with the new package. Older package versions reject schema 2, so downgrades require a pre-upgrade backup. The migration preserves run identity, configuration, claims, receipts, event order and replay conflict detection.

## One owner for tool-result retention

Tool execution follows this order:

1. Native commits and claims the original effect intent.
2. The host settles approvals, dispatch authority and post-execution policies.
3. The accepted observation returns to Native without an unrelated host spill locator.
4. Native applies its model-view budget and archives only authorized observation bytes.
5. Native commits receipts and scoped artifact grants with the task transition.
6. Continuation reads use the granted artifact API and explicit page offsets.

The host negotiates `caller/v1` retention for a runtime that implements this pipeline. This contract changes output ownership, never authorization: denial, redaction, error outcomes, media policy and additional contexts still apply. Tool text and arbitrary file paths cannot mint artifact permissions. Archive failure cannot change a known write outcome or trigger its replay.

## Tool presentation receipts

Workspace mutation previews are derived only from preimages already captured by the execution checkpoint and the bytes actually published. The presentation path does not open files. A bounded `agentkit.workspace-display/v1` projection contains applied diff hunks, real positions and change counts; binary/oversized/unavailable sources are marked omitted rather than guessed. Preview timeout/failure cannot change the known tool outcome. Display metadata is included only with a successful accepted observation, and is removed when host post-policy output is redacted or uncertain.

Session delivery carries this projection in `tool/result.meta`, outside model-visible content, linked to the original call through the committed tool receipt. Reopening a session restores the same metadata. Live command stdout/stderr are bounded, post-policy observations scoped to the current operation; they do not replace the committed receipt or establish command success. Background observation reattaches to the original owned task without launching a command.

Isolated-child file links open an authenticated read-only viewer bound to the original child workspace. The Host checks ancestry, isolation identity, path and file identity; it never falls back to a parent file or merges the child output. The independent UI renders bounded UTF-8 byte pages as current file observations, separately from task verification. The conversation shell clips overflow while transcript and embedded viewers own scrolling, so sidebar focus cannot horizontally displace the main conversation.

New admissions also pin `agentkit.native-context-ownership/v1` in the recovery capsule. Native supplies its own bound skill catalog; the host supplies environment snapshots and external work. Source kinds are classified independently of prose. Filtering preserves source indices for attachments. Catalog/environment refresh after a candidate cannot itself create another task. Legacy capsules retain their admitted policy and bytes.

## Recovery contracts

Execution semantics are declared in the tool registry and pinned in each run configuration. `readOnly` alone is insufficient to authorize replay. Workspace listing, reading and search explicitly declare safe re-observation. Recovery reads current bytes and establishes a fresh observation; it does not claim to recover bytes that were never received. Mutation recovery continues to reconcile durable receipts and preimages. Unknown writes, external calls and unclassified tools are never blindly repeated. Existing runs keep their original sealed definitions.

### Permission waiting and actual dispatch

The real local delivery task exposed a different failure: a workspace write waited for Host approval inside its 30-second tool deadline. Expiry produced `tool_outcome_unknown` before the body had written anything. The original file was confirmed unchanged; the run was cancelled without replaying the write. This evidence does not establish the exception in the earlier research run.

New Studio workspace/command admissions pin `executionTimeoutPolicy: dispatch/v1`. A negotiated ToolPort reports dispatch immediately after approvals and authority rechecks, before entering the body. The per-tool deadline starts once at that boundary; repeated notifications cannot extend it. Run wall and enclosing effect limits continue to bound preflight. Cancellation before dispatch prevents later entry. A post-dispatch timeout stays uncertain. A crash without a completed receipt still follows conservative reconciliation; an in-memory callback grants no replay authority. Child and auxiliary wrappers forward this lifecycle separately from the immutable JSON request.

The deadline/kernel/auxiliary group passed 33 checks. A Studio boundary check verifies that no dispatch notification or file write occurs during permission waiting and that original sealed definitions keep the absence of the new policy.

### Package identity is part of execution evidence

Replacing a local archive at the same filename/version updated the lockfile integrity but left old installed Core bytes under the hoisted dependency layout. A subsequent real-model attempt therefore still used the old deadline implementation; it is not successful validation of the new policy. Source tests alone did not detect this installation mismatch.

Local source packing now gives each archive a SHA-256 content identity in its filename and updates Studio's dependencies and shared Core override together. Build verification compares every installed Native file to its pinned archive, and isolated Studio archive verification repeats that comparison. Both gates also retain the single-Core constructor check. The stale installation is a captured failing reproducer. No npm registry publication is performed.

## State copies and context admission

The captured real long-task CPU profile spends most samples in `model-json` string/value decoding reached through detached copies. Internal state copying now validates and detaches the JSON value tree directly. Canonical encoding remains the hash/persistence boundary; external wire decoding still rejects duplicate keys and preserves exact integers. This avoids repeatedly encoding and scanning large immutable source strings merely to return detached state. On a captured 1,287,539-byte live run header, six local iterations averaged 11.25 ms for the former encode/decode path and 0.88 ms for direct detached copies. This measures one operation, not end-to-end task speed, and does not prove the first historical interruption's exception.

New Studio admissions pin `budgetTiming: before-model/v1`. A fresh tool batch no longer exempts the entire transcript from the soft threshold on every turn. Instead its complete call/result group is mandatory for the next inference, while older groups may be summarized. The original transcript remains immutable. Existing runs without this marker retain their sealed policy; restarting an old run cannot silently change its budget semantics.

## Presentation protocol

The independent UI is mounted in the primary conversation through the maintained Host presentation seat. Exact desktop interaction parity is still an acceptance gate. The target includes desktop reasoning expansion/collapse, provider-backed incremental text, terminal commands and output, file edits with actual diffs, and interruption/recovery controls. The desktop UI and client source packages are checked out for direct implementation review.

A separate UI package owns the versioned event reducer, stable tool-call identity, replay/deduplication and timeline components. Studio uses an optional presentation seat within the resident conversation viewport rather than a separate task tab. A presenter receives a fallback for unsupported sessions and retains the host history loader, scrolling, composer and approvals. Host adapters translate Native events and provider stream frames into that protocol. The UI receives no kernel/store write authority. Persistent events establish final outcomes; transient frames improve latency and may be replaced by authoritative replay. Only actual provider reasoning is shown. Missing reasoning, token usage or final outcomes remain missing. An inactive driver with unfinished work must be presented as requiring recovery, not as a running tool or a completed task.

## Evidence and remaining work

The failed research task recorded six model calls, 142950 input tokens and 988 output tokens, then left four reads without receipts and no final report. The captured journal contained approximately 17.9 MB of duplicated canonical commit fingerprints; store profiling confirms unnecessary parsing and copying in control paths. This proves amplification, not the exact initial driver exception: the old host did not preserve that exception. Root-cause verification therefore still requires reproduction with structured driver diagnostics.

Targeted fencing, replay/conflict and SQLite atomicity tests pass. Host retention tests prove complete post-policy output, unchanged denial and rejection of unsupported retention contracts. UI integration, packaged consumption, initial-interruption reproduction and a real-model long task with output and recovery remain acceptance gates. Do not infer completion from unit tests or a terminal-looking screen.


## Current real-model acceptance attempt

The new `Native 长任务验收` Agent used the configured `deepseek-v4.1-flash` model in an isolated workspace. Its captured ledger reached 29 model calls, 43 tool calls, 1,152,375 reported input tokens and 19,859 output tokens, with accounting marked incomplete after a provider rate-limit failure. Neither requested report file existed. This attempt does not pass output or token-efficiency acceptance.

The later host exit was caused by the operator's diagnostic `Runtime.evaluate` dynamic import: `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` escaped as an unhandled rejection. It must not be attributed to the original Native interruption. The host was restarted against the preserved ledger, and the visible session shows interruption and an explicit resume action. No write replay or new task completion was asserted. End-to-end recovery and final output remain unverified.

The detached-copy, exact-integer and ledger group passed 24 checks; context planning passed 35, including preservation of the fresh parallel call/result group while older history is compacted. Studio budget/recovery/event-adapter checks passed 7. The resident Chat presenter passed its package type check and 14 existing injection regression checks; this is not desktop visual parity evidence. The first desktop package iteration was integrated and visibly mounted. A real Claude Code worker is now refining the direct-source reasoning/read/search presentation in an isolated directory. Its changes, installed package bytes, real-model delivery and visual parity still require acceptance.

The session adapter explicitly gives committed Assistant messages precedence over retained preview frames. Host frames remain available to its dispatcher until step/end, but their block indices can differ from the compact committed content. The UI must not display both as independent messages. Provisional tool argument previews have distinct identities and no execution status, applied diff or outcome; only a committed call creates an executable-tool row.

## Subsequent local acceptance

A newly created Native Agent completed a local order-reconciliation implementation against a 1,505-row fixture with the configured GLM-5.2 connection. It wrote tests before implementation, observed the missing-export failure, implemented the aggregate and CLI, and produced JSON, Markdown and rejected-row CSV reports plus a README. Independent operator execution returned exit 0 for all 25 tests. The generated summary matched the precomputed 1,500 accepted / 5 rejected rows, every region and every integer-cent total. A missing input returned nonzero and created no report directory. The run ended `completed / unverified`: these external checks are not forged into a Native verification receipt. Reported usage was 349,462 input and 9,573 output tokens; approval waits prevent using elapsed time as a model-speed benchmark. This is delivery evidence, not a token-efficiency claim.

The installed content-addressed packages also passed the approval timing scenario: the first write waited more than 43.7 seconds against a 30-second execution limit, then applied after approval and committed its receipt. Additional real Core/Host integration tests preserve unknown outcomes for post-dispatch expiry and forbid replay after a late successful response.

A separate real-model task committed a non-idempotent counter increment, then the operator killed only its local test Host during a running `pure-inference/v1` intent. Restart and the visible **resume original task** action continued the same Run with fence 2 instead of 1. All eight earlier receipt digests remained unchanged. The recovered task produced its audit report, the counter remained 1, and the journal contained only one counter-increment intent. Interrupted model usage remained explicitly incomplete. This validates one controlled inference interruption; it does not grant replay to unknown writes or claim coverage for every crash boundary.

Direct desktop-source review identified additional presentation requirements: live argument drafts are distinct from execution; published calls stay queued until the live owner enters their claimed tool intent (Host approvals still precede actual dispatch); an inactive owner overrides a stale `requesting_model` phase in both header and timeline. Command output freezes the visible text when a reader scrolls up, retains that snapshot across completion, and resumes the latest tail at the bottom. A browser component check exercised those transitions. Long commands use a three-line collapsed preview and a separately scrollable expanded region. Synthetic component checks remain separate from real-model evidence.

Normal model-settings serialization previously dropped protocol/limits/parameters, including the thinking switch. A shared profile projection now preserves these fields and exposes an explicit Native thinking selection. The completed real-model tasks did not contain provider reasoning, so thinking presentation still requires a new run after deploying this profile fix. Independent Markdown/code rendering, complete desktop visual parity, live command output, final package integration and remote verification remain open gates. No claim of full UI parity is made here.

After deployment, normal Settings save preserved `thinking: { type: enabled }` for the isolated test profile without changing the default profile or credentials. A new GLM-5.2 session admitted that option and the explicit provider-visible thinking policy, used only the two requested file reads, and displayed actual provider reasoning, the streaming latest-line summary, a manually expanded thought that stayed open after completion, a GFM table, and a completed highlighted code block. It ended `completed / unverified`; this validates presentation and profile propagation, not every answer-quality constraint. The independent UI phase passed 120 checks; 20 Studio integration checks and the 3,116-file archive gate passed. The live installed package tree matches all 348 pinned Native files. Full visual parity, live command output and remote verification remain open.

### Context and row interaction check (2026-10-27)

- Studio now consumes a content-free context quote from the Native ledger. It
  shows the most recent admitted request estimate, output reservation, automatic
  compaction threshold, adopted compaction count, and active/interrupted/blocked
  compaction status. This is not cumulative billed input or an exact tokenizer
  measurement. A summary proposal alone does not increase the completed count.
- Read file chips open the host preview. Execute/edit rows disclose inline.
  The standard timeline no longer adds separate inspection buttons or a modal
  inspection route. The standalone diagnostic inspector API remains available.
- Collapsed reasoning uses real provider text: same-line deltas refresh in place,
  new line identities roll with a bounded playback queue, and reduced motion
  bypasses transitions. No timer fabricates characters or reasoning content.
- Validation: 133 UI/adapter tests, 35 context-planning tests; browser checks of
  row disclosure and summary playback. The installed Studio independently shows
  the prior real run's 7,712-token quote against a 128,000 window and zero adopted
  compactions. That short run is not real-model compaction acceptance. Manual
  Native compaction commands and timeline-positioned compaction markers remain
  outside this completed check. No main merge or remote publication occurred.

### Source-aligned compaction notices (2026-10-27)

The diagnostic context block and cumulative billing line were removed from the
conversation body after visual review. Context estimates, thresholds and usage
remain in Run and Child Tasks details. The primary timeline consumes versioned
`context.marker` events and renders a one-line divider, with the committed
Native ledger determining start, adoption, failure or interruption. Summary
model proposals alone cannot complete a marker. Tool-call and source-message
IDs anchor notices to the original boundary; unloaded anchors remain hidden.
The current recovery projection supplies the latest run's markers. Restoring
markers for older runs after starting later turns remains a required integration
check; no historical replay parity is claimed yet.

The default rejection-only delivery verifier is no longer presented as a user-
configured positive acceptance oracle. Ordinary completion is neutral while its
stored outcome remains unverified. Explicit acceptance verifiers, failures and
partial outcomes retain their evidence-based presentation.

This group passed 139 checks plus 12 targeted final checks and the 3,122-file
archive check. The synthetic browser fixture confirms one marker updates in
place and has no diagnostic panel; it is not real-model compaction evidence.
Claude Code completed a read-only historical-error audit. Its proposed SQL
names do not match this store and were not executed; its absence claims are not
accepted as proof that all older host logs have been exhausted. The original
first driver error remains unproven.

### Table controls and subagent pane (2026-10-27)

The normal completed response no longer inserts an end-of-turn footer or an
ordinary completion badge. Active reasoning/tool rows carry their own state;
failures, interruption and explicit verification requirements remain distinct.
The Markdown table now uses the directly adapted table component rather than
Streamdown's default controls: a right-aligned horizontal copy-Markdown,
download-CSV and fullscreen-preview toolbar, real overflow expansion, edge
shadows and a virtual scrollbar. The resident Host scroll viewport declares the
layout boundary. CSV export retains UTF-8 and escapes spreadsheet formulas.
The standalone preview manages focus containment/restoration and scroll lock.

Child rows bind by the exact projected parent tool-call ID. Clicking the whole
row opens the corresponding read-only right-sidebar tab, rendered with the same
independent timeline. Committed child messages and tool receipts determine the
content and outcome; bounded ephemeral provider text is scoped to the current
operation and fence, hidden after receipt commitment, and never grants execution
authority. Provider reasoning requires the explicit visibility policy. The Host
owns docking and authenticated reads; the independent package owns presentation.
An early dispatch row is anchored after its committed assistant content by the
exact call ID rather than the transport arrival order.

A new local GLM-5.2 parent/reader task completed and returned the fixture's exact
1500 accepted, 5 rejected, 1379 counted and 50734872 net cents. The parent computed
121 and displayed its table. Reported combined usage was 14253 input / 1282 output
tokens. The child pane was visibly opened after child completion; that observation
is not proof of live child streaming. Source tests cover operation/fence-bound
stream caching, but a new live-browser observation is still required. Shared
parent-workspace file chips use the Host preview; isolated child-workspace preview
is not connected and must not silently open the parent's file instead.

Targeted checks in this phase: 80 child integration cases, 143 independent UI and
adapter cases, 16 child transport/panel cases, 14 Host injection regressions,
Chat TypeScript check, maintained-source ancestry/patch regeneration, and the
3130-file packaged archive gate. These are local evidence, not full visual parity,
real automatic compaction, live command output, or remote CI acceptance. The
original first interruption's missing driver exception remains unproven.


### Conversation status presentation (local verification, 2026-10-27)

The independent UI package now exports `./status-panel` with injected React and
optional portals. It owns mini/panel/auto display, the 1280px container-query
breakpoint, collapsible progress/agent/terminal sections, Todo focus windows,
ended-child directory rows and the independent child-directory body. Studio
supplies a dedicated viewport presentation seat and authenticated facts/actions.
The seat stays sticky when the enclosing conversation owns scrolling; it does
not join the transcript's narrow message column. Display preference persists,
and choosing Auto restores container-driven collapse.

Committed Todo state comes through the public Node activity-status read model.
Child links preserve their original parent run, child run and child session IDs.
The directory reuses the existing authenticated child inventory. Unknown process
observations stay visible as unconfirmed instead of being counted as running.
Git observations are bounded, cached and read-only; a real temporary-repository
check verified tracked/untracked counts, disabled execution of repository filters,
and byte-identical Git index before/after. Unavailable Git is not shown as zero.
Commit/push, branch mutation and command cancellation are not supplied to the
current Studio panel and therefore have no active buttons.

A real configured GLM-5.2 run performed three read-only steps, updated the durable
Todo list to 3/3, read REQUIREMENTS.md, delegated summary.json to a reader, and
explained the actual difference 1500 - 1379 = 121. Browser inspection verified the
progress panel, collapse/expand and Auto setting, ended-child directory, and
opening the corresponding child timeline with the exact 1500/1379 values.
The evidence is under `.artifacts/task-ui-stage/real-todo-subagent-status.json`.

Phase checks: 89 targeted child/activity/Git integration cases, 21 recovery cases,
164 UI phase cases before the last panel refinements, then 37 focused panel/model
cases after them, 14 Host injection regressions, Chat typecheck and browser build,
maintained-source ancestry/patch regeneration, public package integrity, and the
3138-file Studio archive gate. No full repository suite was repeated for each edit.
This establishes the local status-panel path, not full visual parity. Live child
streaming, live command output, automatic-compaction history and the isolated
child-workspace preview still require the remaining integration/acceptance work.
No main merge or remote publish was performed. Overall completion estimate: 82%.


### Follow-up observations and requested entry removal

The conversation-rewind header contribution was removed at the user's request.
The 12 existing child-panel checks passed after updating the removed contribution's
old composition assertion; the packaged Studio passed its archive gate and the
running sidebar page was refreshed to verify the entry was absent. This UI change
adds no new execution or recovery authority.

A scoped read-only audit of the original interrupted Run confirmed four claimed
workspace reads, an uncertain recovery receipt and a frozen tool definition with
no explicit safe-read replay policy. That proves why claimed-effect recovery did
not automatically replay those reads. It does not prove which exception or process
termination originally lost their receipts; no such original error is present in
the surviving journal or the scoped historical Host logs inspected. Evidence:
`.artifacts/task-ui-stage/original-interruption-audit.json`.

A completed, bounded Claude Code read-only audit identified a separate remaining
presentation gap: context markers are projected only from the current Run through
`presentationTurn`, so earlier markers disappear after a later Run becomes head.
The correction still needs implementation: expose an authenticated, bounded and
paged history projection with exact Run/turn bindings, then apply markers separately
from the latest Run's tool/outcome state. Avoid repeated full ancestry loads on every
poll, arbitrary historical Run selection, and synthetic markers inferred from prose.
The audit itself is evidence of this gap, not proof that it is fixed. Overall: 82%.


The duplicate composer Todo strip is now suppressed within a conversation whose
viewport status presenter has claimed layout ownership. A host-owned DOM contract
coordinates these two presentations; the Todo projection itself is unchanged.
Conversations without a viewport status presenter keep the resident dock. Host
maintenance patch 060 carries the scoped layout rule and its explicit panel marker.
The nine existing Todo-panel checks pass. The Host Conversation TypeScript project
and browser bundle were rebuilt in that order: CSS rebuild alone had initially
left the old emitted JSX without the marker, which was detected in the real page
and corrected before acceptance. The browser then confirmed `display:none` for the
resident dock, no bottom task bar in accessibility, a visible 3/3 viewport panel,
and no conversation-rewind entry. Screenshot: `.artifacts/task-ui-stage/todo-dock-removed.png`.
Maintained-source ancestry/export checks and the 3139-file Studio archive gate pass.
Overall remains 82%; compaction-history transport and real streaming acceptance
are still open, along with the originally missing first-driver exception evidence.

### Durable context presentation history (2026-10-27)

Settled Native compaction facts now project into the Host session as ignorable
`agentkit-native/context-marker` events with the
`agentkit.native-context-presentation/v1` contract. They carry the owning session,
run, turn and exact Native message/tool anchor. They never carry summary prose,
mutate the model-visible surface, grant execution authority, or move the active
turn. Running-only observations remain transient. Each settled marker is appended
at its ledger adoption/terminal event position; placing it at the end of a live
delivery would change replay order and is explicitly covered by the warm/cold
delivery check.

The Studio transport adapter validates ownership and reduces each fact into the
independent UI event protocol. It no longer needs the current run's polling
response to retain an earlier turn's adopted compaction marker. No second Native
store or historical-run polling loop was introduced.

Forty focused delivery/client tests pass. The built Host SDK integration also
passes two Native turns across an actual process restart: thirteen fixture HTTP
model attempts (nine summaries), two real file writes, then a delegated default
engine turn. Stored markers from both Native runs survive cold UI projection.
This verifies the integration contract with a controlled HTTP model, not real
provider quality. The isolated Studio archive gate passes with 3139 files; a
configured GLM-5.2 task is separately exercising automatic compaction and output
continuity under an explicitly smaller per-Agent context budget.

The first controlled provider run hit its configured five-compaction ceiling:
24,576-token window, 4,096 reserved output, 0.55 trigger and 1,536 summary target.
It failed with `context_compaction_limit` after 214,303 active milliseconds,
124,876 input and 14,157 output tokens, without producing final artifacts. This
is retained as a failed stress case, not successful output acceptance. The
conversation preserved all five adopted markers across a second turn, browser
reload and an owned Host restart. Canceling the second turn during summary
generation produced a separate interrupted marker and did not rewrite the
first turn. The second turn was canceled after inspection confirmed that its
session still pinned immutable Agent revision 1, despite an editable revision 2
being available; it was not falsely reported as using the new budget.

Evidence: `.artifacts/task-ui-stage/real-context-budget-limit.json` and
`real-context-history.json`. A new Agent/session explicitly binds the 49,152-token
budget for the same output task. Raising this controlled budget does not resolve
the observed frequent-summary overhead; that issue remains under separate
planner/source review. Public terminal explanations now distinguish context
ceilings, no-progress, summary validation and mandatory-state overflow from
capability/approval failures. Four existing task-closure tests pass with the
budget-failure distinction. A bounded actual Claude Code review of marker
ordering, cold replay and ownership found no concrete defect.

### Actual approval timeout and execution file roots (2026-10-27)

The standard-budget provider run adopted two compactions and wrote
`effective.json`; an independent oracle confirmed all fifteen requested field
values. It is **not accepted as complete**: the report write entered
`awaiting_reconciliation` with an uncertain `effect_timeout` receipt. Its Host
approval audit shows the report question canceled after 120,218 ms, matching the
120,000 ms enclosing effect limit. The per-tool dispatch clock is 30,000 ms and
negotiated as `dispatch/v1`, so changing that clock alone cannot fix this failure.

A whole-Kernel reproduction with a 50 ms outer effect, 100 ms permission wait
and 10 ms dispatch clock produces zero dispatches/writes but still commits an
uncertain receipt. The inner `executeTimedTool` can prove preflight non-execution;
the enclosing effect race drops that proof. Required follow-up is a versioned
authorization/dispatch/abort-settlement boundary, including durable human waits,
safe partial-batch settlement and late callback fencing. This does not establish
the missing first exception of the original read incident. Existing unknown
writes must retain their conservative classification until explicitly reconciled.
Evidence is in `real-context-product-pending.json`, `report-approval-audit.json`
and `outer-preflight-timeout-repro.json` under `.artifacts/task-ui-stage`.

Actual clicking also exposed a separate file-preview mismatch: Native wrote in
its bound execution root while the conversation shell supplied another cwd.
The authenticated local recovery view now advertises a scoped execution-workspace
descriptor. Studio resolves both tool-file clicks and Markdown links against
that root with traversal validation. Managed remote runs receive neither the
local descriptor nor local Git status. This stays in the Studio adapter; the
independent UI package still only emits file callbacks. Twenty-five targeted
link/status/recovery checks and the 3139-file archive gate pass.
The deployed archive was then checked in the actual browser: clicking the file
row opened the real JSON in its Native execution directory, and all fifteen
values were visible. Screenshot: `native-execution-file-preview.png` in the same
evidence directory. The unknown report write remains unresolved; overall progress
is 83%, not complete. The read-only Claude Code context-cost review is retained
for critical review; its proposal to subtract retained task tokens from the
separate summary request budget must not be adopted without checking those two
distinct model envelopes.

### Durable permission waiting (in integration, 84%)

The real report attempt above exposed an enclosing effect timeout during Host
approval. New admissions now negotiate `durable-preflight/v1` and
`executionTimeoutPolicy: dispatch/v2`; frozen older runs retain their absence or
original version. The Host's opt-in `dsh.tool-preflight-defer/v1` returns a pending
control projection through the tool's output schema, renderer and post-policy,
without entering guards or the body. Native commits the pending interaction and
releases the execution lease before asking the real Host approval service.
The matching applied ledger decision permits a new full registry invocation;
permission service availability and all execution guards are checked again.

Host permission replies and tool-owned question replies have different ownership.
The former remains in the receipt/event journal and is not sent as a tool's own
interaction token; a later tool-owned question still receives its exact reply.
The actual SDK integration caught this distinction: the first version incorrectly
forwarded a Host token to the workspace tool and produced
`interaction_unknown_or_expired` without writing. The corrected protocol passed
all four real Loader/SDK cases: a 1500ms human wait outside a 1000ms effect budget
then one actual write, a denied grant, a live guard denial after granting, and a
post-policy block of the pending projection. The last three create no files.
This is a controlled-model composition check, not real-model task quality proof.

The `dispatch/v2` live proof settles an enclosing timeout as known nonexecution
only when every call in that batch negotiated v2 and none reached dispatch. It
aborts late callbacks before entering the body. Started, mixed and legacy batches
remain conservative; loss of process-local proof after a crash remains unknown.
Whole-Kernel tests also recreate the owner between a Host permission and a
secondary tool question. The focused approval/timeout group passes 21 checks;
the Host defer group passes 6. Evidence and the SDK case records are retained in
`.artifacts/task-ui-stage/durable-approval-sdk/`. The old uncertain report intent
is not rewritten, retried or reclassified by these tests. New package deployment,
real-model completion and remaining UI gates are still pending.

### Real multi-Agent discovery starvation

The newly created GLM-5.2 Agent `ar-local-326be56710df4520` reproduced a read
timeout after 13 model calls in `context-continuity-v2`. No output write occurred.
The original run ended interrupted/unverified; its unknown read receipt remains
immutable. A live V8 profile shows both the background command watcher and A2A
wait-discovery worker repeatedly decoding every full snapshot for every scope.
This saturated the Host thread during the document task. It establishes the
hotspot in this run, not the missing exception from the first historical run.

RunStore now exposes detached, scoped `listHeads` discovery metadata. SQLite
uses its existing scope/session index to select headers without transferring
messages or tool receipts to JavaScript. Full snapshot listing is also scoped
before decoding. Host watchers use the headers; wait discovery skips live
leases and caches stable revisions without eligible waits. The ledger, fence,
approval and effect semantics are unchanged. A captured local ledger with eight
scopes and fifteen runs took 422.17ms for the previous full-snapshot scan and
12.53ms for the header scan, returning identical run IDs. This single local scan
is not an end-to-end speed claim. Seventy-seven scoped store/watcher checks and
the actual SDK approval regression pass. The archive passes 3145-file integrity.
See `real-v2-context-cpu.cpuprofile`, `real-v2-scan-incident.json` and
`real-v2-scan-benchmark.json` in the stage evidence directory. Live Host CPU and
same-session task continuation still require validation after deployment.

The real interruption also exposed a closed-loop ownership mismatch: Native's
terminal interrupted read left its DSH external-turn owner open, while recovery
rejected that terminal phase. An explicit continuation input therefore remained
queued. The shared safe-read predicate now permits closing that failed
presentation owner only when every unknown receipt belongs to an explicitly
repeatable pure read, with no unreceipted effect, child, or background task.
Closing emits an error ending, not a successful read, and dispatches no old tool.
Unknown writes and unclassified operations retain the recovery barrier.

Owned background-command interruption has a separate operator disposition.
After the operator confirms the original processes have stopped, the ledger
stores an idempotent review against the exact head/event cursor. It refuses an
active lease, an unreceipted effect, an unknown tool write, an unobserved command
or an unsettled descendant. The immutable terminal snapshot and effect journal
are preserved. The adapter may then close only the presentation owner with an
error ending, allowing a new task to inherit the unknown background observation.
This ends waiting; it neither claims recovery success nor replays the command.
Ninety-three driver/recovery checks and the actual SDK external-turn composition
pass, including a following input after a failed read and unchanged failed
receipts. The deployed Host subsequently consumed the existing queued
continuation in the same real session, creating linked Run
`native-dsh-6ffdf6300c26ca53dbec8bb7a058f5ee4aefe16f2a08ee83e46708d59be0af9f`.
The old interrupted Run's receipt and model/tool usage were independently checked
unchanged. Overall progress is approximately 86%; output writes, child review,
final independent output checks, and the remaining UI gates are not yet complete.

The linked real continuation completed. Independent checks cover all 386 lines
of each of three documents across the two journaled runs; exactly one successful
non-overwriting write per output; parent rereads of both outputs; fifteen exact
oracle values; and the actual reviewer child reading the outputs without any
workspace mutation. `real-v2-product.json` retains the output hashes, both run
identities, child identity, approvals and separate usage. Across the interrupted
run, continuation and child, usage is 763793 input tokens and 14658 output tokens
(27 model calls). Combined parent active elapsed time is approximately twelve
minutes, including the interrupted attempt; wall time includes diagnosis and
deployment and is not a model-speed comparison. Token overhead remains high.
The runtime's `unverified/required_verification_incomplete` outcome is retained;
the independent oracle check does not retroactively grant runtime acceptance.

The right-hand child pane opens the actual complete review. The child had
already completed at the observed click, so this does not prove live child
streaming. Evidence: `real-v2-live-thinking.png`, `real-v2-child-result.png`.
The audit also found that the cold Session tool-result projection can lose an
explicit uncertain result when only `isError` and raw content are projected;
the active ledger overlay had previously retained it. A versioned outcome fact
from the same journal is needed for reliable historical presentation. This
presentation gap, live child/command streaming, context-prefix/token efficiency,
the missing first historical exception, and downstream repository sync remain
open. Overall progress is approximately 88%, not complete.

### Historical uncertainty and live child verification

Tool Session results now carry the versioned `agentkit.native-tool-outcome/v1`
fact for uncertain outcomes, derived from the committed Native event rather
than parsing model text. For older Sessions, a scope- and Session-bound SQLite
query returns only the uncertain call identities; it selects the newest
completed observation and falls back to unresolved receipts when no completed
event exists. Later confirmed observations take precedence over retained old
uncertain receipts. The client applies these facts as a view projection even
after a task has ended, without reopening the task or rewriting its history.
The updated package passed 51 focused checks, the actual SDK/Loader approval
and continuation scenarios, installed package identity, and isolated Studio
archive integrity. The running Studio was restarted with that verified archive.
A cold reload of the real v2 Session now shows its old read as `执行结果未知`.
An independent comparison with the pre-change captured SQLite database confirms
that all original receipts and usage remain byte-for-byte/value identical.

A fresh real GLM task in Session
`session-38b8bbb0-d347-4e22-9093-779ecb5b16b6` exercised the right child pane
while the child was still requesting model output. The pane gained three actual
file-read rows, showed changing provider thought previews, and allowed the
provider thought to expand. Its completed table contains
all 96 source components and all 288 exact field values; independent checks
confirm coverage of all 386 input lines and no workspace mutations. The child
used 35956 input and 4821 output tokens in 69448 ms active time. The parent used
23278 input and 1148 output tokens in 62251 ms active time. These are separate
runtime timers, not additive wall time or a speed benchmark. Both retain the
runtime's `unverified` outcome; the independent oracle is not runtime acceptance.
Evidence and replayable checks are in `real-child-live-proof.json` and
`verify-real-child-live.mjs` under the local task evidence directory.

This closes the historical uncertainty and observed live-child presentation
gates. Live command output, context/token efficiency, the first historical
exception without preserved diagnostics, and downstream repository sync remain
open. Overall progress is approximately 89%, not complete. The separate review
of prompt, environment, budget and discovery recommendations remains read-only;
this verification does not authorize implementing those recommendations.

### Command observation transport and explicit preview governance

The Node command transport now accepts an invocation-local `onProgress`
capability, outside its immutable request. Authorized stdout/stderr chunks are
observed during both direct and supervised foreground execution. Every emission
checks the original signal and execution authority; cancellation/revocation
suppresses later data. Supervised output drains all retained byte windows,
including when the producer has already ended. Observation errors, including
rejecting promises, cannot rewrite the command's receipt or restart it.

`createCommandProgressObserver` adds a bounded, coalescing projection boundary
for a Host. Its required projector can withhold/redact output before publishing
`agentkit.command-preview/v1`; there is no raw-publication default. Pending
asynchronous projections are rejected after cancellation, close or ownership
loss. Preview payloads cannot carry an exit code or completion verdict. This
package imports no Studio/DSH/UI code and changes no model context, environment,
resource limits or compaction parameters.

Fifteen focused checks passed, including a real supervised command with a
secret split across chunks, streaming redaction, a 120000-byte completed output,
cancel/revocation, observer failures and malformed projector callbacks. Twenty-six
existing command-host/catalog checks passed. An earlier composition run returned
an uncertain command once; a subsequent complete focused run and three isolated
repetitions of the affected case passed. The original failed run remains recorded
in `native-command-progress-composition-tests-final.log`; its cause is not yet
established, so this is not a command reliability or end-to-end UI acceptance.

The reviewed Claude Code suggestion correctly identified the process callback,
but its proposed direct raw-output UI side channel was not adopted. A final
post-execution redactor cannot retroactively sanitize a preview already shown.
Studio still needs a negotiated streaming output governor and adapter connecting
authorized previews to its existing `tool.progress` UI protocol. Background
commands retain their owned output-reading path. The Node observation surface
alone does not close the live terminal gate. Its content-addressed local archive
passed installed/export checks and isolated Studio archive integrity; no npm
publication or main merge occurred. Overall progress remains approximately 89%.

### Local foreground command previews connected to Studio

The local Host now owns an invocation-scoped command observation cache. A
preview must match the current Session, scope, run, call, operation key and
execution fence, with a live lease and no committed tool receipt. Cancellation,
tool completion, disposal or a late output-policy response removes/rejects the
preview. Managed runs and background launch calls do not enter this local
foreground channel. Studio translates the bounded typed observation into the
independent UI's command presentation, with no result/exit claim and an explicit
marker when preview output is truncated. A committed result remains authoritative.

Operator previews and final model-result content have separate disclosure
boundaries. The Node package still requires a projector. Studio's explicit local
operator projector shows the output of that operator's authorized command;
`studioNativeCommandOutputPolicy.projectPreview(source, execution)` can withhold
or redact it. Final model-result post-execute policies continue to run independently.
A deployment that needs operator redaction must provide that preview policy;
a final-only model redactor does not sanitize previously displayed operator bytes.
No Core callback or model-context injection was introduced for presentation.

The first real command exposed a renderer contract mismatch: the Host supplied
stdout/stderr while a legacy preview branch overwrote stdout from `fullText`.
The shared renderer now uses its single output extractor for both forms, and
event normalization preserves stderr. The failed UI attempt remains recorded
separately and is not acceptance evidence. Eighteen renderer checks and thirteen
adapter/state checks passed. A real Native kernel/gateway command check passed;
the actual SDK profile also passed its original six approval/recovery scenarios
and two command scenarios, proving governed operator previews before receipts
and independent final model-result redaction.

With the corrected installed UI archive `dffa89b3324296a4`, the configured GLM
model ran a new command in Session
`session-dc8c6252-5572-42f5-9f58-be49facc7dd3`. CUA read the rendered streaming
stdout as `live=1` and stderr as `diagnostic=2`; a subsequent ledger observation
still showed `executing_tools` and zero command receipts. Final stdout contained
all three stages, stderr matched, and the single actual command receipt had exit
code zero. No workspace files changed. The run used 9340 input and 391 output
tokens (7488 cached input), two model calls, and 27489 ms active time including
the fourteen-second command. It retains `unverified`, not a fabricated verified
outcome. Evidence: `real-command-live-proof.json`, `verify-real-command-live.mjs`,
and the `real-command-fixed-*` screenshots in the local task evidence directory.

This closes the observed local foreground preview gate. Background command
output, context/token overhead, downstream synchronization and the unclassified
earlier supervised-command result remain open. A Claude review proposed a slow
startup explanation, but that does not fit the observed approximately 0.7-second
failed case and overlooks the supervisor's startup-expiry check; it is not
accepted as its root cause. Overall progress is approximately 90%, not complete.

### Owned background output stage (approximately 91%)

The Node adapter now provides `createOwnedCommandOutputReader` through the
existing `native/owned-command` export. `agentkit.owned-command-output/v1` binds
every nonblocking read to the current scoped Session head, original committed
launch receipt and receipt-selected backend. It accepts byte cursors and a
4–65536-byte window per channel; it owns no launch, cancellation, notification
acknowledgment or model capability. Ownership is checked again after the read.
Unknown/incomplete outcomes cannot produce a known exit verdict.

Studio exposes the authenticated `sessions/native-command-output` read route.
Its resolved frozen preset and output disclosure policy are checked separately
from model-result policy. Display projection cannot mutate process facts;
withholding does not advance cursors. Aborting a view or disposing the Host
settles the request even if a custom display policy is noncooperative.

The independent UI package exports `command-output`: a bounded cursor view and
peer-injected React pane with separate stdout/stderr, actual status/exit,
reader-preserving follow, copy and explicit omission/uncertainty labels. Studio
only supplies right-pane docking and authenticated transport. Opening a status
panel terminal row reads its original process; it submits no task or tool.
Observed status updates the same scoped UI row without rewriting Native facts.

Configured GLM-5.2 acceptance used one authorized background `run_command` with
three stdout stages, one stderr stage, 35s + 25s waits, no network or workspace
writes. The original run completed after launching; the running pane showed the
first stage, browser refresh restored it and received the second stage, and the
completed pane showed all three stages and actual exit 0. A single durable
completion notification caused one additional model response and zero tools.
Cold Host restart also restored the final output and the ended-terminal group.

Evidence: `real-background-output-proof.json`, its replayable
`verify-real-background-output.mjs`, three timed UI observations and
`real-background-*.png` under the local task evidence directory. Actual command
elapsed time was 61106ms. Source + notification model usage was 16439 input,
458 output, 10176 cached-input and 127 reasoning tokens, 3 model calls and
1 tool call; summed active run time was 13737ms (background wall time is
separate). Runtime acceptance remains `unverified`; pricing is absent and cost
zero is not evidence of free usage. This controlled command does not establish
general long-task quality or token efficiency.

Validation: 42 targeted Node ownership/background cases; 166 Host route/status
and related regression cases; 4 independent output-view cases; then 11 focused
Host/status cases after lifetime and scoped-status integration. Client build,
contract typecheck, 360 installed Native files and the 3151-file release archive
passed. No full suite was rerun for individual edits. A remaining presentation
limitation is that inherited background rows can show their stable task ID in
place of the original command title. First historical interruption attribution,
the intermittent supervised unknown, context/token overhead and downstream
synchronization remain open. No merge, push or publication was performed.

### Failure attribution and cost audit stage

The driver now records `effect.failure_observed` and timed-tool boundaries
record `tool.failure_observed` alongside settlement. These bounded facts retain
known timeout, wall-budget, lease-loss or port-failure categories, signal state
and actually negotiated dispatch evidence. Arbitrary adapter error text,
names, codes and stacks are excluded. Observer failure cannot change tool
settlement. A live failure fact survives receipt retirement and cold reopen;
recovering a lost claim does not invent one. This adds diagnostic evidence,
not a retry permission or a success verdict. Original historical exceptions
were not retained, so their precise cause remains unproven.

`audit-real-context-cost.mjs` reads the original long-task ledger without model
calls or writes to the run. Its `real-context-cost-audit.json` records 530079
reported input tokens (50560 cached). Persisted transcript prefixes replayed
1888441 content characters over those calls, including 1349064 imported-history
characters. The final transcript contains 174389 content characters, of which
143691 are workspace read bodies and 19717 are repeated read text. The full
tool catalog's names/descriptions/schemas total 7446 characters; the final
continuity frame is 8678 characters. This is a character-volume diagnosis,
not per-field token billing, captured HTTP bodies, pruning authority or a cache
causality experiment. Compression thresholds, prompt content, environment
policy and child budgets were not changed by this stage.

Background output pages now carry the original launch command from its
verified immutable receipt, including when a completion-notification run owns
the current session head. The independent output header and scoped status row
use that command rather than the inherited task ID. Output disclosure and
byte-cursor semantics are unchanged.

Stage checks passed: 50 focused Kernel/recovery/timed-tool cases, 30
command-output/status/UI cases, the eight real DSH SDK composition scenarios,
and 363 installed Native files matched their pinned archives. SDK evidence is
at the local `native-approval-sdk-SqJz1F` temporary directory. This verifies
diagnostic persistence and existing approval/recovery behavior, not the
missing historical exception or an improvement in token efficiency.

### Versioned ordered context projection

`ContextPlanningPolicy.continuityPlacement = after-history/v1` places the
unchanged current `execution_continuity` system frame after complete transcript
groups. The stable instruction prefix, all retained message roles/content,
tool pairing and summary trust labels are preserved. The same composer is used
for counting, summary adoption, admission and the actual dispatched request.
The derived frame is not appended to authoritative conversation history.

Studio admits this layout for new `openai-chat` runs and compatible new child
bindings. Restored runs use their pinned layout; omitted historical fields do
not activate it. Anthropic's separately journaled operator state and Responses
defaults are unchanged. Core rejects combining the new placement with the
existing journaled-system policy. Compression thresholds, output reservation,
prompts, tools, permissions and replay policies are unchanged.

The real configured GLM comparison in `real-context-layout-comparison.json`
used the actual planner, counter and HTTP model adapter on a four-step
synthetic-source query conversation. Both arms passed every exact lookup and
the final JSON check. Legacy: 33887 total input, 960 cached input (2.83%),
218 output tokens. Ordered: 33885 total input, 24192 cached input (71.39%),
269 output tokens. The recorded uncached inputs were 32927 and 9693.
Measured arm wall times were 11790ms and 8846ms; one run per arm cannot establish
a general latency improvement. Distinct stable batch IDs isolated prefixes.
This establishes cache reuse on this configured model and fixture, not fewer
total input tokens, monetary savings, broad model quality or Studio acceptance.

Subsequent actual Studio acceptance used the installed package and existing
GLM profile on `context-layout-delivery-v1`: two source reads, exactly one
non-overwriting write and one output reread. The four queried values and sum
2102 matched the independently generated oracle and actual source receipts.
`real-ordered-context-delivery-proof.json` pins the run and preserves runtime
`unverified` acceptance rather than rewriting it. Active elapsed time was
26974ms; usage was 59149 input / 1018 output, 39744 cached input (67.19%),
4 model calls and 4 tool calls. Working/final screenshots record the real
thinking, source reads, applied write diff, reread and result table.

Checks: 39 context/layout/summary cases, 9 binding/ownership cases, eight real
DSH SDK composition scenarios, contract typecheck, 363 pinned installed Native
files and a 3154-file release archive passed. Actual Claude Code performed a
read-only review with no actionable finding inside its allowed scope; its
review limitations and generic provider claims are not treated as independent
proof. Primary inspection additionally confirmed browser/deadline policy
messages append to the counted view, review wraps a copy of that view, and
children consume their resolved model's pinned context policy. Real provider
coverage remains GLM only. Historical-text retention, original exception
attribution, downstream source synchronization and final audit remain open.

### Historical source reuse and standalone source synchronization

New chat admissions may pin `sourceReusePolicy: captured-source/v1`. The request
projection folds only older, identical successful workspace observations with
Host-issued captured-source grants. It preserves the first retained body and
latest complete tool batch. Selection, counting and dispatch use the same
projection; canonical history, receipts and archived sources are unchanged.
Missing outcomes can be enriched only from an immediate parent's exact committed
receipt, never from model text. Older configs do not gain the policy on restore.

66 focused context/history/binding checks, the actual DSH SDK scenarios, contract
typecheck, 366 installed package files and the 3158-file Studio archive passed.
The installed Studio's real GLM audit produced the correct `audit.json` once and
left `result.json` unchanged. Its first request reused historical source pages
instead of performing all requested new reads. A read-only follow-up supplied
the missing ranges; the combined two requests cover all 240 input rows. Their
active elapsed times were 54901ms and 42142ms, with aggregate 141293 input / 5175
output tokens and 96512 cached input tokens. Both retain runtime `unverified`.
No identical-source reuse marker occurred in their prepared request views: this
proves integration and artifact correctness, not deduplication savings. The
controlled actual-file/kernel test separately proves reduced counted views.

The standalone repository now contains the same 430 source/build inputs for
Core, Node and UI. Existing five dirty paths were backed up and their lease,
event, fingerprint and safe-read changes retained through reviewed merges.
Standalone builds, 62 focused runtime checks, 170 UI checks, all three package
boundaries and packed-install RPC idempotency passed. A fresh install of the
standalone tarballs also passed real GLM process-restart acceptance: one read,
one write, three model calls, 1031 input / 272 output tokens, terminal reattach
without new effects. Its runtime outcome remains `unverified`; the external
exact-copy check does not rewrite acceptance. Installed UI React rendering and
bundled Markdown imports passed a controlled smoke check without Studio/DSH.

Proofs: `real-source-reuse-audit-proof.json`, `native-source-sync-parity.json`
and the standalone `real-model-restart-proof.json`. Original historical exception
attribution, actual-task reuse savings and final requirement audit remain open.
No main merge, remote push or npm publication was performed.

### Final local acceptance and known limitations

The scoped implementation is complete: independent Core, Node and UI packages
are consumed by Studio through pinned npm archives. Source parity covers 437
source/build inputs. Final installed Native integrity covers 371 files, and
the Studio release archive contains 3169 files. Real configured-model tasks
validated long-task artifacts, source reuse, child reasoning and isolated file
views, live foreground/background output, cold replay and explicit disposition
of an unknown background result followed by a new task in the same session.

Original interruption exceptions were not retained. Its historical root cause
and a separate intermittent historical command uncertainty remain known
limitations; current controlled fault checks cannot establish those past causes.
The user accepted this limitation and closed further historical investigation.
Independent artifact checks do not rewrite runtime `unverified` verdicts.
Acceptance covers the configured local model, not a broad quality benchmark.
No main merge, public npm release or Python integration is included.
