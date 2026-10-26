# Native / ZCode coding Harness alignment

Status: in progress. This is a new source-alignment task, not a reopening or a
replacement of the earlier Python-to-TypeScript migration acceptance.

## Confirmed scope

The target is ZCode's coding Harness internals and the task conversation
interaction/presentation needed to use that Harness inside the existing Studio.

- Harness: prompt/instruction assembly, model/tool loop, context and compaction,
  editing, permissions, plans/todos, steering/cancellation, background work,
  children and recovery.
- Task conversation: streaming answers and available model reasoning, tool
  arguments/results/progress, task status, approval/questions and user responses,
  stop/continue, and conversation history/rewind. Audit the complete path from
  provider events through persisted Session events to the Studio presentation;
  backend event support alone does not establish display parity. Check ordering,
  partial/error/cancel states and cold-history rendering without duplicate output.
  Reasoning display uses the provider's available display content; private replay
  signatures and other opaque protocol metadata remain separate.
- Keep Native's durable execution and lightweight design, existing multi-runtime
  boundaries, and future endpoint/cloud handoff interfaces. Implementing a cloud
  scheduler or full cross-runtime checkpoint portability is outside this phase.
- Exclude ZCode's desktop shell, account/billing/updater, office/document product
  modules and unrelated plugins, pages or visual redesign. Reuse Studio's current
  Session/UI ownership and presentation components where possible.

This clarification makes conversation presentation explicit within M3/M4 and
its end-to-end checks within M6. Unrelated product modules were already outside
the coding Harness target; excluding them earns no extra progress. The
denominator remains 100; this scope clarification itself earned no points.

## Reproducible inputs

- Native baseline: `ac9ee0b` on `feat-ksadk-harness` (resolve to the full Git
  commit when collecting benchmark results).
- ZCode: `https://github.com/zai-org/ZCode`,
  `3c5b227649371507ddc4eb46ac5133afe6db1cab`.
- Pi: `https://github.com/earendil-works/pi`,
  `d5b3de22d0e24a3e9c38a9410d3329b099717283`.
- Reference code is read-only outside this checkout. The local `zcode` skill
  contains third-party extracted configuration, not the official source.
- Source paths below are relative to ZCode's `apps/zcode-cli/packages/core/`
  unless another package is named. Reference design documents alone do not
  establish implemented behavior.

## Milestones and progress denominator

| Milestone | Weight | Completion evidence |
| --- | ---: | --- |
| M1: pinned inputs, source/call-chain audit and baseline cases | 15 | traceable matrix, reviewed implementation/tests, reproducible baseline |
| M2: prompt, project context, tool exposure and compaction | 15 | integrated requests and context behavior, bounded cost evidence |
| M3: model protocols, streaming, editing and tool execution | 20 | complete real adapter paths and relevant failure cases |
| M4: plans/todos, steering, permission, background and child control | 20 | persisted task control and Studio integration evidence |
| M5: recovery, undo, runtime boundaries and handoff | 15 | cold recovery, effect reconciliation, version/ownership invariants |
| M6: fixed local comparison tasks and final requirement audit | 15 | before/reference/after results, differences, performance and limitations |

Total: 100. Partial credit must identify a concrete completed checklist item;
test counts and lines changed do not determine progress. New scope or discovered
gaps are recorded here rather than hidden by changing the meaning of completion.

Initial completed checklist items: clean tracked baseline and target branch
verified; official ZCode checkout pinned; Pi source pin recorded. No capability
group is yet certified completely aligned.

Current earned progress: **40/100**: M1 4/15 (inputs, initial matrix and reviewed
source findings), M2 9/15 (explicit earlier cleanup, admitted Anthropic cache
projection, actual Host baseline/nested instruction refresh, and integrated local
deferred-tool discovery with durable cleanup/Session continuity, plus versioned
reference-default earlier cleanup through the actual Studio counter/command path,
authenticated cleaned-source summaries with SQLite recovery and actual Studio integration,
and admitted idle cleanup with persistent assistant clocks and cold Studio continuity), M3 6/20
(successful context-window truncation, durable cache usage accounting and
source-aligned edit matching and structured patches through actual packed Studio child tools,
plus Native-local catalog authoring and frozen-Build admission through authenticated Host routes,
and versioned creation/whitespace replacement through Edit with actual Host cold continuity), M4 9/20
(durable session Todo controls, compaction continuity and actual Studio projection
across cold Host turns, plus receipt-backed Plan transitions, tool restrictions and
actual Studio plan review, frozen non-destructive MCP Plan access and dynamic
local POSIX command Plan permission through the actual Host execution path,
plus child-local Todo continuity and durable coordinator responses through the
actual packed Studio Host, plus owned Plan delegation/wait with immutable child
mode inheritance and fresh continuation rebinding). The latest M4 point covers
that integrated child Plan behavior, not the whole child control or planning group.
The latest M3 point covers versioned empty-old-text Edit creation and whitespace
replacement, not the whole editing/undo or tool execution group.
M5 12/15 covers durable file preimages on the admitted writer path (one point)
and receipt-backed preview/authorized file-only rewind across a cold Studio Host
(one point), guarded compensation of failed file rewinds (one point), and
separately fenced cold final-receipt lookup through the production Host gateway
(one point), and explicit original-Run cold preimage compensation, including a
second process death during compensation and its product recovery entry (one point),
and exact closed-turn Native conversation fork admission, cold first-use/follow-up,
and fork-of-fork with independent Run/budget and paired historical tools (one point),
and exact ordinary Native before-input/root and in-turn message cuts with
cutoff-local Todo/discovery through cold packed Studio first use (one point),
and authenticated idle same-Session conversation rewind with cold rebased
continuation, repeated root rewind and branch-fenced workspace reads (one point),
and retained successful full Read/Write/Edit observation hydration on those idle
branches, with original freshness and post-policy/commit guards (one point),
and actual in-flight model cancellation before same-Session branch commit,
bounded Host settlement and cold continuation with immutable canceled ledger
(one point), and selective local background-command cleanup with kept-task
authority across a cold Host (one point; full removed-child and other-backend
cleanup remains pending), and authenticated preview-bound combined file/conversation
rewind, including active stop, cold continuation and repeated earlier cuts without
file resurrection (one point).
This does not certify full recovery/undo, full conversation branching or
cross-runtime handoff. M6 has no earned points yet. The denominator is unchanged; remaining session
exceptions, explicit child permission modes and other M4 controls are not
certified completely aligned.

## Source and implementation map

The entries below locate actual source and initial findings. `Pending` means
that implementation or end-to-end evidence is still missing, not that a Native
module with a related name is absent. This table will be updated as each path is
audited and integrated.

| Area | ZCode implementation / tests | Native implementation | Finding / acceptance to complete |
| --- | --- | --- | --- |
| Prompt and instructions | `src/context/builder.ts`, `sections/identity.ts`, `tests/context-builder.test.ts` | `src/host/services/native-harness.mjs`, `src/providers/native-context.mjs`, core `guidance.mts` | Stable/dynamic sections exist in reference. Audit actual Host assembly, project instruction discovery and provider cache layout; preserve admitted recovery prompt. Pending. |
| Model and stream | `src/runtime/methods/turn-model-step.ts`, `model-streaming-event.ts`, `../adapters/src/model/` | Node `model-{openai-chat,responses,anthropic,normalize}.mjs`, core `model-stream.mts`, `machine.mts` | Native already rejects truncated tool batches. Successful `model_context_window_exceeded` now enters bounded output continuation; buffered/SSE/local HTTP→kernel cases pass. Remaining protocol/stream audit pending. |
| Output continuation | `src/runtime/methods/turn-output-token-continuation.ts`, `tests/runtime-output-token-continuation*.test.ts` | core `output-recovery.mts`, `machine.mts`, `test/output-recovery.test.mjs` | Reference treats a completed truncated response differently from a rejected input-overflow request. Native retains its authenticated suffix/task recovery, original budgets and durable receipts. Compare boundary cases; pending. |
| Context / microcompact | `src/compact/microcompact.ts`, `src/runtime/methods/{microcompact,turn-loop}.ts`, `tests/microcompact.test.ts` | core `context-{planning,microcompact,view}.mts`, source working set, Node context counter | New explicitly enabled admissions derive the reference earlier threshold, use cleaned sources for still-needed summaries and support idle-triggered cleanup through persistent assistant completion clocks. Actual Host/counter/cold-continuation evidence is recorded below; original policies and explicit thresholds remain. Result-count versus batch recency, exact budget strategy and full context acceptance remain pending. |
| Local task conversation / thinking display | `src/runtime/methods/model.ts:278-330`, model streaming Session events | Node `assistant-stream.mjs`, `session-delivery.mjs`, Host `native-harness.mjs`, maintained DSH `api/session-controller` and conversation UI | Local Session stream consumption exists in maintained DSH; absence of a consumer in Studio `src/client` does not establish a local display gap. Native currently defaults `providerThinkingDisplay` to false; opt-in streaming, persisted display, reconnect/cancel/error ordering and rendered main-view parity still need acceptance. The cloud Assistant history/renderer filtering is a separate path. |
| Tool discovery / Skills / MCP | `src/tool/search/{exposure,history,search}.ts`, `src/tool/deferred-call.ts`, `tests/tool-search-*.test.ts` | core `tool-{discovery,search-ranking}.mts`, Node wire projections and `skill-disclosure.mjs`, Host `native-dsh-tools.mjs` / `native-subagents.mjs` | Local search/wrapper path now enters actual packed Host, real MCP, child authority, SQLite and cleanup. Skills retain existing progressive disclosure. Native Anthropic tool-reference optimization, complete deferred-selection comparison and task-cost benchmarking remain pending. |
| File search/read/edit and undo | `src/tool/handlers/`, `patch-{parser,apply}.ts`, `edit-matchers.ts`, `runtime/methods/file-rewind.ts` | core matchers/parsers, Node workspace ports/workers and `workspace-checkpoints.mjs`, Host source/directory projections and mutation lock | Matching, patches and receipt-backed file-only rewind pass actual packed Studio cold continuation and frozen-Build admission. Native read-state, publication and unknown-effect guards remain. Ordinary conversation fork and idle same-Session rewind also pass packed Host proofs. Preview-bound combined file/conversation rewind now passes actual packed Host active-stop, cold continuation and repeated root-cut proofs. New admitted v2 Edit supports absent-file creation and full-fresh-read whitespace replacement, actual Host denial and cold editing; v1/legacy behavior is preserved. Large/legacy-encoded files, range/pruned/reconciled read-state variants, full historical selection, remaining partial-restore reconciliation, hook aliases and read/write policy comparisons are pending. |
| Tool validation / execution | `src/tool/{executor,scheduler,input-normalization,model-contract}.ts` | core `tool-input.mts`, `machine.mts`, Host tool authority and DSH pipeline | Native has ledger-bound tools and read-only concurrency. Compare coercion, rejection feedback, ordering and resource conflicts. Pending. |
| Plan / Todo | `src/tool/handlers/{todo,plan-mode,plan-mode-prompts}.ts`, `../contracts/src/tools/{todo,plan-mode}.ts`, `src/permission/{service,plan-mode-policy}.ts`, `src/runtime/helpers/{runtime-reminders,plan-file-continuity}.ts`, `src/runtime/methods/turn-loop.ts` | core `todos.mts`, `plan-mode.mts`, `kernel.mts`, Node `session-delivery.mjs`, Host Native composition/interaction | Todo/Plan controls, Studio projections, review, cold-turn continuity, MCP/local command exceptions and owned child delegation/wait with default mode inheritance are integrated. Explicit child modes, remaining session exceptions and full reminder/control comparisons remain pending. |
| Steering / cancellation | `src/runtime/methods/{turn-guide-drain,runtime-command-active-loop}.ts`, `tests/runtime-command-queue.test.ts` | core `guidance.mts`, `kernel.mts`, Host interaction bridge | Compare interruption timing, queued input ownership, priority and restored commands. Pending. |
| Background / children | subagent handlers, `src/subagent/{profile,tool-policy,coordinator-response}.ts`, `src/tool/handlers/respond-to-coordinator.ts`, `src/runtime/methods/{subagent,subagent-messages,turn-loop}.ts`, background tests | core child/background modules and `coordinator-response.mts`, Node owned child/command, Host watcher / `native-subagents.mjs` | Child-local Todo, coordinator progress, owned Plan delegation/wait and default child mode inheritance are integrated. Child Plan tools remain absent as in reference. Explicit permission modes, built-in Explore policy, and remaining background/cancellation/workspace/restart comparison are pending. |
| Retry / permissions | `src/runtime/methods/streaming-recovery.ts`, tool executor/permission policy | core `retry.mts`, tool error recovery, Host DSH permission pipeline | Preserve bounded retries and no blind replay of unknown effects; compare denied-call feedback and retry termination. Pending. |
| Recovery / runtime boundaries | runtime persistence, `src/runtime/methods/{session-fork,rewind-message}.ts` | core store/recovery/history, Node SQLite, `src/providers/native-conversation-{fork,cut,rewind}.mjs`, `src/runtime-contract.mjs`, Host recovery | File compensation passes packed Studio SIGKILL/cold recovery. Closed-turn and ordinary before-input/root/in-turn cuts import selected history into fresh independent Runs with cutoff-local Todo/discovery; cold continuation/fork-of-fork passes. Same-Session rewind rebuilds history/Todo/discovery with retained full Read/Write/Edit freshness. Actual in-flight model cancellation, branch commit and cold continuation pass; unknown tool effects remain blocked. Preview-bound combined rewind is integrated with the existing workspace journal and actual maintenance reservation. Remaining removed-task cleanup boundaries, range/pruned/reconciled read-state variants, full historical selection and neutral handoff remain pending. Keep engine/build pin and one executor; no cloud scheduler in this phase. |
| Artifacts / delivery / usage | tool-result persistence, turn-stop, model-step usage | core artifact/delivery/verification, Host trace and Session delivery | Compare user-visible completion, partial output, result references and complete task cost. Pending. |

## Deliberate architecture constraints

- Native owns its single model/tool loop. DSH owns product Session/UI and its
  permission pipeline; DSH Native and Codex remain separate engines.
- Keep durable intents/receipts, immutable admitted configuration, original
  budgets, lease/fence ownership and unknown-effect reconciliation.
- Same-engine compatible checkpoints can resume. Cross-engine handoff transfers
  goal, constraints, progress, diffs and artifact references, never assumes
  provider-private reasoning or checkpoints are portable.
- Engine, execution placement and model selection are separate axes. This
  phase keeps the ports for local/remote execution; it does not build a cloud
  scheduling platform.
- Browser/office/desktop product modules outside coding Harness are optional.
  No default extra planner/reviewer model or mandatory multi-agent execution.
- Reused nontrivial upstream code must retain its license and source notices.

## Reviewed audit findings and next batches

Two real Claude Code read-only audits were completed (tools/control and context).
Their conclusions are research inputs, not acceptance evidence. Main-agent
cross-checking corrected these overbroad findings:

- Native already groups compatible read-only calls in `machine.mts` and uses
  `Promise.all` in `kernel.mts`; no second scheduler is needed just because the
  gateway accepts one tool request at a time.
- ZCode's `TodoWrite` is session-state modifying and `concurrentSafe: false`.
  A todo integration must not mark concurrent writes safe.
- The builtin workspace write guard is only one layer of permission processing;
  `ctx.tools.execute` enters the outer DSH policies. Audit that whole path before
  claiming permission rules/hooks are absent.
- Existing `admitAnthropicPolicies` already enables journaled operator guidance
  and a stable tool catalog for admitted exact model names. The confirmed cache
  gap was explicit wire breakpoints, not absence of those existing policies.
- DSH's maintained `packages/context/agent-instructions` has real AGENTS/CLAUDE
  discovery and an `agent/pre-step` contribution. The maintained loop runs that
  preparation before delegating `agent/execute-turn`; Native projects non-user
  admitted messages as `dsh_context`. Therefore absence of a loader in Studio
  `src/` does not prove baseline instructions are missing. Product composition
  and actual Native admission now have local integration evidence below. The
  nested refresh gap came from the DSH loader observing `read/write/edit` with
  `file_path`, while Native uses different tool names and owns its loop.
- Generic externally bound tools can pass through Native's gateway. Plan/Todo
  are not categorically impossible, but their explicit roles, lifecycle, result
  semantics and default exposure are not yet aligned. Changes to the assembled
  prompt/tool series currently require an explicit Native rebind; Plan mode
  cannot silently change that frozen contract.

Implementation sequence after this initial batch:

1. Baseline/nested project instruction admission is locally integrated; retain
   its keyless recorded-session and actual packed Host proof during later work.
2. Integrate durable Todo/Plan behavior, mode restrictions, reminders and user
   decisions with the actual Session/UI and Native receipts.
3. General local deferred-tool discovery and compaction continuity are integrated;
   complete provider-native reference optimization and representative cost comparison.
4. Complete editing/undo, control/background/children and recovery comparisons;
   preserve stronger Native side-effect/ownership boundaries as explicit
   differences, not as excuses to omit user-facing capability.
5. Run fixed local reference/baseline/after tasks and close the full audit.

## Initial integrated changes and evidence

### Local deferred-tool discovery through Studio and child authority

The pinned reference uses `src/tool/search/{search,exposure,history}.ts`,
`src/tool/deferred-call.ts`, and handlers `tool-search.ts` / `deferred-tool-call.ts`.
Native adapts the reference ranking algorithm with Apache-2.0 attribution and a
bundled license (`THIRD_PARTY_NOTICES.md`, `third-party/ZCode-LICENSE`). Exact
selection, aliases, required terms, keyword scoring and MCP-prefix matching keep
the reference algorithm. No external service or extra planning model is needed.

New Studio Runs use `local-tool-search/v1` when their bound catalog contains
generic external/MCP tools. Builtins and the existing Skill disclosure tools stay
resident. `execution.nativeToolSearchMode: off` selects full declarations;
`auto` or absence selects discovery when applicable. A real external tool named
`ToolSearch` or `DeferredToolCall` keeps its existing meaning: auto falls back to
full declarations for that scope. Cold restore preserves an old Run's missing
policy and exact original configuration instead of adopting the new default.

The immutable configuration keeps every definition. Model declarations omit
deferred schemas and offer `ToolSearch` plus `DeferredToolCall`. A bounded list of
available names lives in the search declaration, keeping it stable across steps;
remaining names are searchable by keywords. Search returns complete schemas,
including exact integer constraints. A schema that cannot fit the governed
model-result budget is reported in `omitted_count` and does not grant discovery.
This implementation caps each search at 20 matches, while retaining Native's
existing result-byte budget; these are deliberate bounded-execution differences.

Before intent creation, valid wrappers resolve to their actual target and input.
The target owns input validation, permission/hook processing, timeout, scheduling,
budget, child authority and side-effect reconciliation. The journal stores the
actual target; a private wrapper marker reconstructs the original call in Chat,
Responses and Anthropic histories, including signed-thinking replay. The model
cannot supply that private marker. Unknown writes retain reconciliation and are
never granted safe-read recovery by the wrapper's metadata.

Search receipts and loaded names are durable. Context cleanup that retires
schemas promotes the corresponding tools to resident declarations and invalidates
the prepared request so its actual catalog is counted again. A new Session turn
inherits only currently allowed discovered names and promotes them. Child MCP
inheritance carries its own discovery policy and state; kernel controls never
become external gateway authority.

Evidence for this batch:

- `packages/agentkit-harness-core/test/tool-discovery.test.mjs`: actual Kernel,
  memory/SQLite, approvals, unknown effects, parallel reads, target validation,
  hidden-call rejection, complete-schema budgeting, cold resume, compaction and
  next-turn promotion. Eleven cases, plus two provider-projection cases in
  `packages/agentkit-harness/test/native-tool-discovery-wire.test.mjs`, pass.
- Scoped existing regressions: tool-input, microcompact, Kernel, protocol wrapper
  projection and Native gateway (96 passing); Studio Host (95 passing);
  children (72 passing). Follow-up cases verify default inherited discovery and
  real external control-name collisions without rerunning the whole suite.
- `node scripts/verify-studio-native-harness.mjs --source <built maintained DSH>
  --mount-host --mcp-schema --tool-search --keep`: actual packed Studio, maintained
  Host and SDK, controlled HTTP, two Host processes, five model requests, exact
  MCP schemas and two real effects. Checks default search, actual-target policy
  and journal identity, wrapper history, cold next-turn promotion and packaging
  of the third-party notice/license. The existing `--mcp-schema` scenario opts
  out explicitly to retain its direct-call compatibility scope.
- Core TypeScript build and Studio contract checks pass. No full repository test
  run was needed for this batch. The real Claude Code read-only audit produced
  no usable result and was stopped; it is not review/acceptance evidence.

Still pending: provider-native Anthropic tool references, fuller comparison of
deferred-selection defaults and history deduplication, and before/reference/after
task-cost measurements. Controlled HTTP usage counters prove accounting paths,
not model quality, task success rate or a Token/latency saving percentage.

### Scoped workspace instructions through the actual Host

DSH maintenance patch `054` adds the Agent-scoped
`agent-instructions/touch` event to the existing loader. Native derives absolute
paths from successful committed parent workspace-tool records immediately before
the next Host input preparation. Child/MCP records do not become parent workspace
observations. The event uses `agentEvents(ctx, agent)`, so multiple mounted
presets cannot broadcast duplicate instructions into the same Agent's inbox.
Native stores the input intent's transcript cursor and durably delivers the
previous `step/end` before preparing new input. Cold delivery preserves the
context's ordering, source and deduplication without repeating tools. Old input
intents without a cursor keep their existing delivery behavior.

The maintained source and exported bundle pin is
`a0272d447be3d951800fcb9062ea571ff1d1fede`. The maintained instruction package's
183 tests passed. Its new authored `agent-instructions-external` headless Session
passed keyless refresh and read-only replay, using an external read tool and
asserting nested guidance in the immediately following model request. The Native
gateway/Session batch passed 77 tests, including SQLite receipt observation,
multiple output retirements with input preparation, and cold Session replay.
The Host unit batch passed 91/95 initially; four real-gateway fixture cases needed
the newly required scoped dispatcher. Those four passed after fixing the fixture
and adding an assertion of the dispatched path. This is combined targeted
evidence, not a fresh all-repository test result.

Reproduce the actual packed Studio + maintained Host + SDK integration with:

```sh
node scripts/verify-studio-native-harness.mjs --source "$DSH_ROOT" --mount-host --instructions --keep
```

The controlled HTTP model sees root guidance on request 1, nested guidance on
request 2, and changed nested guidance after a second Host process starts. The
persisted Session contains one copy of each nested update. The proof writes
`instruction-session.json` and `instructions-proof.json` into its reported
temporary directory. This proves local composition and request ordering, not
live-model quality or a process kill inside the receipt-to-pre-step interval;
that latter interval currently has SQLite/gateway and delivery replay evidence.
Uncertain/failed tool results do not advertise successful filesystem observation.
Nested discovery remains driven by structured filesystem observations, as in the
existing loader; arbitrary shell commands are not parsed for paths.

### Completed generation at context capacity

`model-normalize.mjs` recognizes successful `model_context_window_exceeded` as
output truncation. A request rejected for an overlong input remains a separate
context-overflow failure. No new loop or retry budget was introduced.

Before the change, four of five new focused cases failed with a terminal model
error / failed Run; after the change all five pass. Cases cover buffered and SSE
completion, incomplete transport, a parseable but truncated tool call, and a
local HTTP→NativeKernel task continuation with only the subsequent complete call
executed. Actual adapter usage sums to the three attempts; no usage is reset.

### Earlier local tool-output cleanup

`context.compaction.pruneThresholdTokens` is an optional positive integer frozen
in the Run context policy. With `pruneToolResults: true`, it allows local cleanup
before the full summary threshold. Omitting it preserves the previous trigger;
setting it alone does not enable cleanup. Existing working-set, failed receipt,
media, planning, persistent context and minimum-savings protections remain.

The representative counter fixture now cleans old observations below the full
summary threshold without a summary request or transcript mutation. This is
estimated request-token evidence, not a measured live-provider cost saving.
New Studio admissions now derive the reference default boundary when pruning is
explicitly enabled (see the later 38/100 entry). Idle-triggered cleanup remains
open; restored legacy policies retain their original boundary.

### Anthropic cache projection

New admissions for the existing exact supported Anthropic model catalog pin
`profile.promptCachePolicy = 'anthropic-prefix/v1'`. The Host restores the
original primary-profile field set. Profiles without the field retain the old
wire shape; other protocols and unknown aliases do not acquire it implicitly.

The pure Node projection marks the first system section, the system suffix when
separate, and the latest eligible conversation block (at most three explicit
breakpoints). Mid-conversation system order stays intact. Signed thinking is
never marked or modified. Temporary compaction source chunks get no tail write
marker. Host-provided automatic caching retains its tail; replay-carried direct
markers are cleared only on disposable wire blocks, not in the stored replay or
application data. The complete request counter uses this same wire builder.

Reference: ZCode `context/builder.ts` and
`runtime/helpers/provider-request-messages.ts`; wire eligibility checked against
[Anthropic prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
No provider cache hit, billing reduction or live-model quality claim is made.
Cross-profile/cold legacy admission coverage remains part of the full audit.

### Cache usage accounting and Session totals

Anthropic cache writes now survive as optional `cacheWriteInputTokens` in Native
model receipts, additive parent/nested usage, SQLite restore and browser vision
aggregation. Native input totals remain inclusive. Session delivery converts
them to DSH's disjoint uncached/read/write buckets and supplies an authoritative
aggregate total; cache tokens are not counted twice. Inconsistent subtype counts
are retained in the Native ledger but omitted from the Session breakdown.
Cold/repeated delivery preserves the same usage without new requests.

The existing managed-runtime v2 wire schema has no cache-write field; it keeps
its inclusive aggregate input count. The full breakdown remains available in
Native receipts and Session delivery rather than extending that fixed external
schema silently. No billing-price or live cache-hit result is inferred.

The usage-focused batch passed 91 cases across nested accounting, model-input
aggregation, browser vision and cold Session delivery. The model cache/usage
and output-continuation subset also passed. These targeted checks do not
establish complete coding-Harness alignment.

Executed checks for this batch (targeted, not whole-repository acceptance):

```sh
node scripts/build-native-harness.mjs
node --test --test-name-pattern='zcode alignment|anthropic:' packages/agentkit-harness/test/native-model.test.mjs
node --test packages/agentkit-harness-core/test/output-recovery.test.mjs packages/agentkit-harness-core/test/context-planning.test.mjs packages/agentkit-harness-core/test/context-microcompact.test.mjs tests/native-context-integration.test.mjs
node --test packages/agentkit-harness/test/native-anthropic-context.test.mjs
node --test --test-name-pattern='Anthropic|recovery|restor' tests/studio-native-harness.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.contracts.json
```

Initial counts: 30 model cases, 73 context/output cases, 12 Anthropic projection
cases and 7 Host cases passed. Count each batch once; repeated runs are not new
coverage. TypeScript core build and contract compilation passed. Portability
checking also exposed pre-existing personal paths in `native-handoff.md`; those
examples now use a checkout placeholder and normal `HOME`/`PWD` expansion.

## Integrated session Todo behavior

Source audit at the pinned ZCode commit covered
`core/src/tool/handlers/todo.ts`, `contracts/src/tools/todo.ts`,
`core/src/runtime/helpers/runtime-reminders.ts` and the turn-loop call site.
A real Claude Code read-only audit of the first three files was cross-checked
against those files; its findings are audit inputs, not runtime acceptance.

Executable reference behavior accepts multiple `in_progress` items, duplicate
content and whitespace-only nonempty content. The single-active-item refinement
is commented out despite the schema description. Priority is required; unknown
item fields are stripped, unknown root fields rejected; writes replace the whole
list and return old/new lists with status counts. Native follows these behaviors.
There is no new arbitrary input-state cap: existing request/context and tool-output
governance still apply. The reference's 100,000-byte output allowance is not an
input validation limit.

New `session-todos/v1` Runs own `TodoRead`/`TodoWrite` controls and durable session
state. Execution stages pure results; the fenced atomic intent/receipt/state
commit performs the sole Todo mutation. A lost claimed Todo-only effect can be
settled against the unchanged ledger without invoking an external tool. This
does not authorize replay of external writes with unknown outcomes. Successful
writes emit immutable `todo.updated` facts, inherited state emits `todo.initialized`.
These facts publish standard `todo/write` Session events with stable Native IDs,
so append-before-flush retries and cold delivery do not duplicate UI updates.
The existing Studio todos projection displays content/status; priority remains
in Native state, tool receipts and Session events. No separate UI or model call
is introduced for tracking tasks.

State survives subsequent Native Runs in the same Session, including explicit
empty-list replacement. Other Sessions start empty. Context continuity carries
the authoritative items/revision, protected by the prepared-context source
digest; a model-written summary cannot replace them. Runs without context
planning receive an inherited state notice. Runs with context planning reuse
continuity instead of inserting that extra notice as well.

Reminder counters are persisted assistant turns, excluding failed inference and
summary requests; they survive next-turn inheritance. A reminder requires ten
assistant turns since both the latest TodoWrite and latest reminder, and is
suppressed during output continuation and delivery review. Full source comparison
of all control/reminder interactions is still pending.

Host composition enables the controls by default when the standard `todos`
projection is installed, uses existing deferred search when available, and
supports `execution.nativeTodoMode: off`. Explicit external tool-name collisions
preserve the external meaning. Old Run configurations retain policy absence and
their original digest. Unlike ZCode's session-scoped `readOnly: true` metadata,
Native marks TodoWrite non-read-only and non-concurrent: Native's read-only flag
also governs scheduling and external replay authority. Its kernel-owned receipt
mutation does not enter workspace-write approval. Plan-mode permission integration
is documented below; child-local Todo exposure and mixed
external-read recovery comparisons.

Targeted local checks:

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness-core/test/todos.test.mjs
node --test packages/agentkit-harness-core/test/recovery.test.mjs packages/agentkit-harness-core/test/tool-discovery.test.mjs tests/native-session-delivery.test.mjs
node --test packages/agentkit-harness-core/test/todos.test.mjs packages/agentkit-harness-core/test/context-planning.test.mjs packages/agentkit-harness-core/test/context-microcompact.test.mjs tests/native-session-delivery.test.mjs
node --test tests/studio-native-harness.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.contracts.json
node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --mount-host --todos --keep
```

The scoped checks passed 10 Todo cases, a 45-case recovery/discovery/delivery
regression group, a 71-case Todo/context/delivery closure group and 95 Host cases;
these groups overlap and must not be added as unique coverage. The packed Host
proof uses the shipped SDK and maintained standard DSH source, seven controlled
model HTTP requests, two actual Host processes, two Native receipt-backed updates
and three persisted Session Todo events (including next-turn initialization).
It verifies actual default discovery, priorities, standard todos projection and
cold Host inheritance. It does not prove live-model task quality or Token savings.
Full Plan exceptions and complete M4 acceptance remain pending. Whole-repository tests were
not run for these incremental changes.

## Integrated Plan mode and review

The pinned source audit also followed `core/src/tool/handlers/plan-mode.ts`,
`contracts/src/tools/plan-mode.ts`, `core/src/permission/plan-mode-policy.ts`,
`core/src/permission/service.ts` and
`core/src/runtime/helpers/plan-file-continuity.ts`. A real Claude Code read-only
audit of the permission service, handler and plan-file helper was cross-checked
with the source. The reference enters planning without approval, requires approval
before exiting, preserves the raw nonblank plan (at most 20,000 JS UTF-16 units),
and attempts an atomic `.zcode/plans/plan-<session>.md` write before mode exit.
The helper propagates cancellation but swallows other write failures. The source
has no general exemption allowing model tools to edit that file during planning;
the approved handler writes through its own filesystem port.

`session-plan/v1` now admits immutable `EnterPlanMode`/`ExitPlanMode` controls.
Entering changes durable Native mode immediately for subsequent calls, including
the rest of the same model batch. The dispatch gate checks effective calls after
schema validation and PreToolUse hooks: while active it permits read-only tools,
owned Plan controls and owned session Todo controls, and refuses workspace writes
before invoking an external tool. One-call permission grants cannot bypass this
gate. Mode changes and approved raw plans are committed atomically with their
tool receipts. Pure-control takeover preserves hook denials and never invokes an
external write. An already-admitted approved exit can finish once after process
loss; unknown external effects keep the existing reconciliation rules.

The actual Studio `userQuestions` service receives the full exact plan and the
existing `plan-review` intent, keyed to the same opaque Native tool-call ID shown
in the Session. Generic tool approval is not a substitute. Only one unambiguous
Approve answer without custom text produces a durable allow command. Rejection
returns feedback and retains mode; malformed answers deny; stale checkpoints
invalidate answers. Dismissal cancels the Native Run without another model call
and keeps planning active (DSH's own exit tool instead concludes its current turn).

Native mode facts project into the existing `plan/mode` Session state with stable
IDs, so lost flushes and cold delivery do not duplicate transitions. Accepted
Host pre-step receipts can adopt the user's `/plan` selection through a versioned
boolean control; prose cannot change mode. This invalidates and recounts prepared
context before another model call. The frozen base prompt removes only DSH's named
`plan:policy` section for newly admitted Plan-policy Runs, because that guidance
conflicts with Native's permitted Todo updates. All other sections and tools remain
frozen and checked; old Runs retain their original policy absence and full prompt.
Native context supplies the current mode/guidance and approved plan instead.
Runs without context planning receive a private durable mode notice.

The standard Host enables Plan controls by default when its Plan service/projection
is installed and external names do not collide. `execution.nativePlanMode: off`
opts out for new Runs. Explicitly disabling local tool search leaves both Plan and
Todo controls resident; it does not disable their functionality. A new Native turn
inherits the approved plan while the accepted Host mode remains authoritative,
so a user can re-enter planning after an earlier approval. Normal workspace and
tool permissions still apply after approval; `allowedPrompts` is preserved as
plan data and does not mint a blanket shell grant. The pinned core also only
returns that field from the handler; no use granting permissions was found there.

Deliberate differences and remaining comparisons:

- The approved plan is stored in Native's durable ledger and request continuity,
  rather than relying on a best-effort `.zcode` workspace write. Mode exit and plan
  persistence are atomic. Filesystem export and neutral runtime handoff remain
  part of the later artifact/runtime audit.
- Native `build` in tool results denotes its ordinary execution policy; it does
  not add ZCode's separate `auto/yolo/guarded/edit` permission-mode system.
- ZCode permits non-destructive MCP capabilities even when not read-only, and
  explicitly allowed non-destructive session controls. The MCP exception is now
  integrated as described below. Dynamic local POSIX command classification is
  also integrated below. Remote-command and other session/child exceptions remain
  gaps; Native still denies these mutating definitions in planning. These remaining
  gaps are not certified aligned.
- Full ZCode Plan reminder cadence/workflow text, child-local planning and every
  user steering/permission interaction still need comparison. Mode guidance is
  integrated now; it does not establish equivalent task quality.

Scoped checks for this batch:

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness-core/test/plan-mode.test.mjs tests/native-plan-interaction.test.mjs
node --test packages/agentkit-harness-core/test/plan-mode.test.mjs packages/agentkit-harness-core/test/turn-input.test.mjs
node --test packages/agentkit-harness-core/test/plan-mode.test.mjs packages/agentkit-harness-core/test/todos.test.mjs tests/native-plan-interaction.test.mjs tests/native-session-delivery.test.mjs
node --test packages/agentkit-harness-core/test/recovery.test.mjs packages/agentkit-harness-core/test/context-planning.test.mjs packages/agentkit-harness-core/test/hooks.test.mjs tests/native-host-child-approval.test.mjs tests/native-tool-receipt-authority.test.mjs tests/native-dsh-turn-runtime.test.mjs
node --test tests/studio-native-harness.test.mjs
node --test --test-name-pattern='session planning controls remain resident' tests/studio-native-harness.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.contracts.json
node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --mount-host --plan-mode --keep
```

The checks passed the Plan/interaction controls, 26 Plan/input cases, an overlapping
47-case Plan/Todo/interaction/delivery group, 135 focused recovery/context/hook/child/
turn cases, 95 existing Host cases and the additional search-disabled composition
case. The packed proof used eleven controlled model HTTP requests, three actual
structured plan reviews (reject, approve, approve), two real Host processes and two
approved workspace effects. Both forbidden files remain absent. It verified actual
Todo updates in planning, persisted mode projection, cold Host user re-entry and
approved-plan continuity. These groups overlap; counts are not progress weights.
There is no extra planning model, but approved-plan text can add up to 20,000 UTF-16
units to dynamic context; task-level Token/latency comparisons are still pending.
No full repository test suite or live-model performance claim was made.

## Frozen MCP permission exception during planning

Pinned source: `mcp/index.ts:createMcpToolEntry` sets destructive only when
`descriptor.annotations.destructiveHint === true`; absence defaults to false.
`permission/service.ts:checkPlanMode` admits non-destructive MCP capabilities even
when their read-only hint is false or absent. An explicit destructive hint still
blocks a tool with a read-only hint. Project deny/ask and tool always-ask rules
precede the Plan branch; this exception does not override them.

Studio now snapshots this separate `zcode-mcp-plan/v1` fact from actual MCP
descriptors into newly admitted Native binding contracts. The gateway binds only
actual MCP identities, includes the fact in its binding digest and optionally
emits it into the frozen Run tool definition. New Plan-policy Runs admit the
exception; restored Runs retain exactly their prior per-tool selection or
absence. Older binding contracts without this fact keep their existing digest
and behavior. A tool name or model-supplied argument cannot supply the exception.

This fact only changes Plan admission. MCP definitions remain non-read-only and
serialized, retain normal Host permission/pre/post execution and durable outcome
handling, and acquire no safe-read recovery authority. Cold takeover of a claimed
MCP effect with no known result interrupts for reconciliation and never replays
the action. This intentional separation is necessary because an MCP read-only
hint is not Native evidence that an external side effect can safely repeat.

Local checks for this batch:

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness-core/test/plan-mode.test.mjs tests/native-mcp-schema.test.mjs tests/native-plan-interaction.test.mjs
node --test tests/native-dsh-tools.test.mjs
node --test packages/agentkit-harness-core/test/recovery.test.mjs packages/agentkit-harness-core/test/tool-discovery.test.mjs tests/native-tool-receipt-authority.test.mjs tests/native-mcp-schema.test.mjs
node --test --test-name-pattern='restor|cold|frozen|planning controls|MCP' tests/studio-native-harness.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.contracts.json
node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --mount-host --plan-mode --plan-mcp --keep
node scripts/check-portability.mjs
```

The control group passed 21 cases, the real gateway/kernel adapter group 56,
and focused recovery/discovery/receipt tests 28 (overlapping counts), plus 13 Host
restoration/frozen configuration cases. The packed
proof uses two actual Host processes, eleven controlled model HTTP requests,
three real MCP calls, three structured plan reviews and two approved workspace
writes. It verifies default/explicit non-destructive MCP admission, a destructive
tool blocked despite its read-only hint, a permitted MCP call denied by actual
Host pre-execution policy, and resident MCP invocation after cold Host restart.
Both forbidden workspace files remain absent. The original proof's existing
discovery, Todo, plan review feedback, mode projection and approved-plan
continuity assertions remain in force. The extra permission check adds no model
call; descriptor facts occupy frozen configuration, while a short permission
sentence enters dynamic Plan guidance. No task-level savings claim is made.

Follow-up source audit: Bash dynamic permissions come from
`tool/handlers/bash.ts:resolveBashPermissionCapability`, `bash-semantics.ts`,
`bash-command-parser.ts` (the `unbash` parser), the `bash-readonly-policy-*`
modules and `bash-git-runtime-safety.ts`. Classification checks command syntax,
redirection/dynamic words, write options and workspace Git runtime context; a
simple executable-name allowlist would not reproduce it. Explicit non-destructive
session control in the pinned source includes `RespondToCoordinator`
(`tool/handlers/respond-to-coordinator.ts`). It must not be conflated with a
blanket permission to launch or steer a potentially mutating Native child.

## Dynamic local POSIX command permission during planning

Pinned source: `tool/handlers/bash.ts:resolveBashPermissionCapability` grants
read-only command capability using `bash-semantics.ts:isRuntimeReadOnlyBashCommand`.
That function parses shell syntax, rejects dynamic/unsupported words, checks
per-command options and redirection, and checks the actual Git directory context.
Native now directly reuses its evaluator with the 23 unchanged parser/policy/Git
modules in `third-party/zcode-command-plan/`. The source manifest pins original
paths and hashes; the build verifies them. Apache and parser ISC license notices
are shipped. This reuses an independent permission component, not a second loop.

The new `zcode-posix-readonly/v1` policy is frozen on the owned local `run_command`
definition for new Plan-enabled Host Runs. Original Runs keep their policy
presence or absence. Commands retain non-read-only, serialized, owned-launch
definitions: a permission classification does not establish safe replay.
Kernel seals active Plan mode into the actual request and requires a dynamic
permission port. A missing port denies execution. Ledger authority rejects a
removed/forged mode restriction. The transport checks again after normal Host
policy and the existing governed-command check, using the actual workspace cwd.
A Host-stage change from an ordinary directory to a bare Git indicator is denied
before launch. Existing authorization, cancellation, deadlines, retained output
and uncertain-effect recovery remain in the execution path.

The parser runs in a bounded Node worker (2-second classification deadline,
64-MiB old-generation limit). Cancellation/deadline returns a denial without
waiting indefinitely for worker exit. Native's explicit environment overrides
are classified using the same reference assignment rules, so locale overrides
can pass while PATH/GIT_DIR/BASH_ENV cannot. The internal `KSADK_COMMAND_CWD`
routing alias is resolved and checked as cwd rather than a shell environment
assignment. Native's existing workspace cwd and symlink boundaries still apply.
E2B/remote runtime context cannot be inferred from the Host filesystem; its
command exception remains pending the Runtime boundary audit. Child planning and
session communication exceptions remain pending as well.

Local checks for this batch:

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness-core/test/plan-mode.test.mjs tests/native-command-plan-reference.test.mjs
node --test --test-name-pattern='Plan command permissions' tests/native-dsh-tools.test.mjs
node --test tests/native-dsh-tools.test.mjs packages/agentkit-harness/test/native-local-command-policy.test.mjs packages/agentkit-harness/test/native-local-command-read.test.mjs
node --test packages/agentkit-harness-core/test/plan-mode.test.mjs packages/agentkit-harness-core/test/prepared-command.test.mjs packages/agentkit-harness-core/test/recovery.test.mjs tests/native-tool-receipt-authority.test.mjs tests/native-command-plan-reference.test.mjs
node --test --test-name-pattern='restor|cold|frozen|planning controls|MCP' tests/studio-native-harness.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.contracts.json
node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --mount-host --plan-mode --plan-commands --keep
node scripts/check-portability.mjs
```

The final control/reference group passed 16 cases and the actual command gateway
case passed. Earlier overlapping checks passed 75 command/adapter cases, 55
recovery/prepared-command/authority/control cases (before the added cold-command
case), and 13 Host restoration/frozen-configuration cases. The packed proof
completed eleven controlled model requests across two actual Host processes,
executed two real read-only POSIX commands, rejected a shell write and PATH
override, preserved a real Host policy denial, and retained all prior Plan/Todo/
approval/cold-continuity assertions. Two approved workspace writes succeeded;
all three forbidden paths remain absent. Cold SQLite claimed-command recovery
also verifies no blind replay after a lost outcome. No full repository suite ran.

The bundled classifier is 105,371 bytes and requires no external parser package
at runtime (`unbash@4.0.1` is a pinned build-only dependency). A local ten-sample
Node v26.5.0 permission micro-check of `git status --short` measured a 0.32-ms
median for the bundled reference function and 26.3 ms for a fresh bounded worker.
An admitted Plan command uses two worker checks, plus the existing execution
checks. No model call is added; this is classifier overhead only, not a task-level
speed, Token saving or ZCode quality comparison. Full task comparison stays in M6.

### Child-local Todo and coordinator progress

Reference paths at the pinned ZCode commit:

- `src/subagent/profile.ts`: Explore includes TodoWrite; the general-purpose
  profile permits the broader tool set.
- `src/subagent/tool-policy.ts`: every child forcibly excludes EnterPlanMode and
  ExitPlanMode, because children lack an independent Plan approval recovery UI.
- `../contracts/src/tools/respond-to-coordinator.ts`,
  `src/tool/handlers/respond-to-coordinator.ts`,
  `src/subagent/coordinator-response.ts`, and
  `src/runtime/methods/subagent-messages.ts`: a child-only, optionally deferred
  RespondToCoordinator enqueues progress/replies, acknowledges queueing, and
  tells the child to continue. It is not a final result or parent acceptance.
  The input is strict, with summary 1–200 and message 1–20,000 UTF-16 units.

For new Studio Runs with child roles, the frozen `session-controls/v1` parent
policy admits child-local TodoRead/TodoWrite and RespondToCoordinator. The child
uses the existing Todo ledger, reminders and session continuity; it cannot alter
the parent's Todo. Controls follow the child's existing discovery mode, and are
excluded from the external gateway authority. External tools cannot impersonate
them. Plan tools remain absent. Parent Plan-mode delegation/child permission
inheritance is still pending; this change grants no blanket child-launch or
steering exception in Plan mode.

RespondToCoordinator stages a small acknowledgement. Its deterministic response
identity and immutable queue fact are committed with the child's tool receipt.
Lost pure-control claims recompute that same receipt rather than invoking an
external publisher. Child ownership is required at Kernel start and execution.
The parent owner reads only owned child facts; collection/readiness uses frozen
per-child event cursors, and the parent atomically commits consumption and its
cursor. Foreground/control settlement also carries outstanding responses. A
repeated receipt cannot append the same response twice. Snapshot transition
validation prevents cursor rollback and foreign-child cursors.

Responses enter the parent as `child_response` data with
`parentAcceptance=not_evaluated`, rather than a human guidance command. If a
model tool batch is still open, the existing post-batch observation queue holds
the response until every tool result is sealed. Actual Studio context validation
exposed and now covers the otherwise-invalid assistant-call/user-notice/tool-
result ordering. A background response can arrive while its child is still
working, without settling its budget. Terminal delivery and usage settlement
remain separate. Canceling/retiring a parent can leave queued child facts
undelivered, rather than transferring them to a replacement parent.

Intentional differences and costs:

- Native keeps the response control serialized and non-read-only, while the
  reference marks it concurrent-safe. Native's read-only/concurrency facts also
  govern replay authority; atomic durable receipt semantics are retained.
- Queue facts and cursors replace the reference's in-memory synchronous enqueue
  and random response UUID. No second execution loop or publisher is introduced.
- Responses are private agent context. A dedicated visible Studio child-progress
  surface is not certified by this batch; existing child history/results remain.
- Three resident Native tool definitions occupy 1,980 UTF-8 JSON bytes before
  provider projection; with discovery enabled, they are deferred. Unused controls
  add no model round trip or runtime dependency. Requested Todo/report calls
  consume ordinary model/tool budgets; they are not free. Full task cost and
  quality comparison remains in M6.
- Original parent Runs retain absence of `childTaskPolicy`; child restoration
  reconstructs the original tools/policies/digest. Cold legacy and opt-in owner
  restoration both pass, rather than upgrading an old Run implicitly.

Local checks for this batch:

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness-core/test/coordinator-response.test.mjs packages/agentkit-harness-core/test/todos.test.mjs packages/agentkit-harness-core/test/plan-mode.test.mjs packages/agentkit-harness-core/test/child-budget-kernel.test.mjs packages/agentkit-harness/test/native-child-owner.test.mjs packages/agentkit-harness/test/native-coordinator-response.test.mjs tests/native-child-task-policy.test.mjs
node --test tests/studio-native-children.test.mjs
node --test --test-name-pattern='inheritSkills false|grants inherited MCP' tests/studio-native-children.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.contracts.json
pnpm pack --pack-destination /tmp/agentkit-child-task-pack
node scripts/verify-studio-native-children.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-child-task-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --task-controls --continue-child --history --keep
```

The 99-case focused core/owner/recovery group passed. The 76-case Studio child
group passed 74 cases initially; two old tool-inventory expectations were updated
for the added controls and rechecked successfully (the explicitly zero-tool
budget remains zero). The new Studio cases cover foreground, background and
deferred controls, actual gateway exclusion, parent Todo separation and SQLite
cursors. No full repository suite ran.

The final packed proof is recorded in `/tmp/agentkit-child-task-sdk-final.log`,
with evidence directory
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-lSzKe6`.
Its `task-controls-proof.json` records two actual Host PIDs, eight child model
requests, two real workspace reads, two queued/delivered reports, separate parent
acceptance, and Todo revision continuity in the same child session after a cold
Host restart. Each parent receives exactly one report and one descendant usage
settlement. PATH contains Node only and Python paths are deliberately unusable.
These controlled requests prove execution behavior, not live-model coding parity.

### Plan delegation and inherited child permissions

Reference behavior at the same pinned ZCode commit:

- `src/tool/handlers/agent.ts` marks Agent read-only/non-destructive because the
  child runtime checks its own tools. `src/runtime/methods/subagent.ts` derives
  the default custom-profile child permission mode from the parent's effective
  Plan state; `tests/subagent-effective-execution.test.ts` exercises a real child
  with inherited `planEnabled` separately from the underlying execution mode.
- `src/tool/handlers/task-output.ts` permits result waiting in Plan.
  `send-message.ts` and `task-stop.ts` are not read-only and have no explicit
  Plan exception; `src/permission/service.ts` therefore denies those model calls.
  This is distinct from trusted user cancellation.
- `src/subagent/tool-policy.ts` excludes child EnterPlanMode/ExitPlanMode. The
  built-in Explore profile is different: its default mode resolves to `yolo`
  with restricted tools/instructions. Explicit profile permission modes can
  override the default (`resolveSubagentPermissionMode` and the contracts
  `inheritPermissionMode` helper). Those cases must not be described as universal
  Plan inheritance and are not implemented by this default-role batch.

New Studio parent Runs with Plan and child roles freeze
`childPlanPolicy: inherit-plan/v1`. Native permits owned start/delegate and wait
through an actual child owner's admission port, while send/stop remain denied.
The owner validates the live parent tool intent, fence, budget and definition;
wait additionally verifies the owned reservation. A missing port fails closed.
Launch remains effectful, serialized and subject to the existing durable
reconciliation rules, unlike the reference's read-only/concurrent metadata.

The owner freezes the parent's effective mode into `childOwnerBinding.planMode`
and `planModePolicy: inherited-child-plan/v1`. The child checks every effect
using its own frozen tool/MCP/command policy, retains Todo/report controls, and
cannot call independent Plan transitions or accept an input mode override.
Denied writes tell the child to report to its coordinator rather than call an
unavailable ExitPlanMode. A continued Session gets a fresh child Run and budget
with the current parent mode; original Runs remain unchanged. Parent approval
does not retroactively rewrite a running child's admitted mode.

Acceptance and deliberate differences:

- Memory/SQLite, foreground/background, active/inactive Plan, owned controls,
  missing-port denial, and exact parent approval followed by child continuation
  pass. Cold owner reconstruction covers legacy absence, task-only controls and
  inherited Plan configurations without upgrading original digests.
- Actual Studio tests cover isolated workspace write denial/read/report and
  frozen destructive/non-destructive MCP descriptors. MCP permission does not
  grant read replay or concurrency. The Plan child still uses normal Host
  permissions for otherwise admitted tools.
- The packed SDK proof uses two real Host processes and the actual Plan
  controller at idle boundaries: first Plan, then build after cold restart.
  The original child Run stays Plan; a fresh Run in the same Session writes only
  its isolated workspace. Parent files remain unchanged, each report is delivered
  once and each child budget settles once. Controller selection is not presented
  as model-requested approval; the separate exact-approval test covers that path.
- This batch adds no model round trip, tool definition or runtime dependency for
  mode inheritance. Existing tool/model budgets charge all actual child work.
  Inherited-mode guidance adds prompt bytes; full task Token/latency comparison
  remains in M6. Native retains stronger durable ownership instead of making
  child starts replayable reads. Explicit per-profile overrides and built-in
  Explore policy remain tracked gaps, not silently omitted capabilities.

Commands and evidence:

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness/test/native-child-plan.test.mjs tests/native-child-task-policy.test.mjs
node --test --test-name-pattern='Studio Plan|Studio child Plan' tests/studio-native-children.test.mjs
node --test packages/agentkit-harness-core/test/plan-mode.test.mjs packages/agentkit-harness-core/test/child-budget-kernel.test.mjs packages/agentkit-harness-core/test/coordinator-response.test.mjs packages/agentkit-harness/test/native-child-owner.test.mjs packages/agentkit-harness/test/native-child-continuation.test.mjs packages/agentkit-harness/test/native-coordinator-response.test.mjs tests/native-host-child-approval.test.mjs tests/native-plan-interaction.test.mjs
pnpm check:contracts
node scripts/check-portability.mjs
pnpm pack --pack-destination /tmp/agentkit-child-plan-pack
node scripts/verify-studio-native-children.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-child-plan-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --task-controls --continue-child --history --child-plan --keep
```

The focused inheritance/restore group passed 14 cases, Studio Plan child group
4 cases, and affected control/recovery group 117 cases. No full repository suite
ran. Packed proof records eight parent and eight child model requests, two actual
reads, one denied Plan write and one isolated build write, with Node-only PATH
and unusable Python paths. These are controlled protocol requests, not live-model
coding-quality or performance parity.

Final archive proof: `/tmp/agentkit-child-plan-sdk-final.log`, evidence directory
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-adxhEj`
and its `task-controls-proof.json`. The final child-denial feedback refinement was
rebuilt, repacked and rechecked with 26 related Plan/inheritance/restore cases.
Contracts and portability checks also passed.

### Source-aligned file edit matching

Pinned reference paths: `src/tool/edit-matchers.ts`,
`src/tool/handlers/edit.ts`, and `tests/edit-tool-contract.test.ts`.
The standalone matcher is copied to core `edit-matchers.mts` with only an
attribution header; the original source SHA-256 is
`072ab0ff34e8444d2cb92255ece9d01b70e0e8bc43afd95999ee0cb82328aefd`.
Local byte comparison verified that the algorithm body is unchanged.
Apache-2.0 provenance is recorded in `THIRD_PARTY_NOTICES.md`.

New Studio Runs admit `workspaceEditPolicy: zcode-match/v1` on actual builtin
edit/multi-edit definitions. Frozen legacy absence is preserved during original
Run reconstruction. The old matching path remains unchanged for that absence;
children inherit the admitted tool definition rather than independently
selecting a new matching strategy. Model-facing arguments and tool names do not
change, and no tool is added to the catalog.

Matching now follows the reference's ordered exact, quote, line-number-prefix,
visible escape, Unicode escape, trimmed-line, flexible-indent and block-anchor
fallbacks. Ambiguous different fragments remain rejected, including replace-all;
replace-all does not enable broad whitespace/anchor matching. Replacement keeps
reference quote style, escape transformation and literal dollar tokens. Deleting
a matched line follows the reference's following-newline behavior. Native keeps
its explicit `expected_replacements` extension and preserves unrelated bytes,
including mixed line endings. Multi-edit computes sequential changes before any
publication, so a later failed match leaves the file unchanged.

The pure algorithm runs in a fresh Node worker with a 2-second/64-MiB old-heap
limit. It receives captured strings and edits, not a workspace tool/port or file
publication request. The main thread holds no mutation lock while awaiting it.
After completion it acquires the existing lock, revalidates the original read
state and content, then uses the existing guarded atomic publication and revision
recording. External modifications during preparation, denial, cancellation and
worker exhaustion publish nothing. This introduces no second execution loop or
new recovery authority; unknown effects after actual publication retain Native's
existing liability/reconciliation behavior.

Deliberate differences and remaining gaps:

- Native retains its 2-MiB UTF-8 file bound, confined paths and strict current
  read-state checks. ZCode's edit limit is 1 GiB and its full-read freshness
  fallback can tolerate some mtime-only drift. Full large-file/read-policy parity
  is not established by this matching batch.
- Native still requires non-empty old_text for edits; creating/filling a file
  uses the existing write tool. ZCode also supports empty-old-string creation and
  routes notebooks to NotebookEdit. These differences remain in the full audit.
- The bounded worker can refuse an expensive match and ask for a smaller exact
  snippet, while the reference matcher has no internal CPU budget. Native keeps
  the bound so pathological input cannot stall the Host event loop. Independent
  patch/undo, complete Write/read behavior and broader file-search comparison
  remain pending.
- The compiled standalone matcher is 12,566 bytes. There are no additional
  runtime dependencies or model round trips for matching. A controlled 12-sample
  local exact-edit measurement on Node v26.5.0 recorded legacy pure matching
  median 0.048 ms versus fresh worker preparation median 21.088 ms (max 25.931 ms).
  This measures worker overhead only, excludes filesystem/model/network costs,
  and proves no task-level speed or Token saving. Report:
  `/tmp/agentkit-zcode-edit-worker-cost.json`. Whole-task comparison remains M6.

Local evidence:

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness/test/native-workspace-zcode-edit.test.mjs
node --test packages/agentkit-harness/test/native-workspace*.test.mjs tests/dsh-node-workspace-tools.test.mjs
node --test --test-name-pattern='child Plan|Studio Plan|child-owned|Todo|coordinator|foreground child' tests/studio-native-children.test.mjs
pnpm check:contracts
node scripts/check-portability.mjs
pnpm pack --pack-destination /tmp/agentkit-zcode-edit-pack
node scripts/verify-studio-native-children.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-zcode-edit-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --continue-child --history --edit-matching --keep
```

The new group passes 17 cases, including real SQLite/approval/port reopen and
single-receipt publication. The affected workspace/adapter regression passed
118 cases with one optional Node-22-binary check skipped because that binary is
absent. The relevant Studio child group passed 13 cases. Contracts and portability
passed; no full repository suite ran.

Packed proof log: `/tmp/agentkit-zcode-edit-sdk.log`; evidence directory:
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-KUlBB9`.
`edit-matching-proof.json` records two actual Host PIDs, eight parent/six child
requests, two reads, actual prefix and Unicode edits in the same isolated child
workspace across cold continuation, original history and one settlement per
child. Parent workspace bytes remain unchanged. PATH contains Node only and
Python paths are deliberately unusable. Controlled requests demonstrate actual
adapter behavior, not live-model coding quality parity.

### Structured workspace patches through the bound Studio child path

Reviewed the pinned reference `src/tool/handlers/apply-patch.ts`,
`src/tool/patch-parser.ts`, `src/tool/patch-apply.ts`,
`../contracts/src/tools/apply-patch.ts`, `src/tool/compat.ts` and the actual
`tests/file-tool-port.test.ts` patch cases. Reference behavior verifies all
sections before sequential filesystem publication; a multi-file patch is not
an atomic transaction. Matching progresses through exact, trailing-whitespace,
trimmed and Unicode-normalized lines, with contextual/EOF hunks and moves.

Core parser and pure application code are copied with Apache-2.0 notices.
Comparison against the pinned source confirms identical code after removing
the two attribution lines, changing module extensions and adapting two optional
property types for Native's `exactOptionalPropertyTypes`. Upstream SHA-256:

- `patch-parser.ts`: `0e104647b152f204e45feb568aa42a80b135ec2bf267a6f01c935eedf424e924`.
- `patch-apply.ts`: `374ff78899ba1caf8f2a1c433f919020ca51ee3aaee2313848b2dc62cc6cc6a8`.

Native exposes `apply_workspace_patch` only to explicitly bound Native Builds,
using frozen `workspacePatchPolicy: zcode-patch/v1`. The legacy DSH Native
ten-tool workspace port stays unchanged. The Native Host/child binding,
isolated writable-child classification, merge eligibility and component status
recognize the new tool. Portable exports containing it use
`agentkit.portable-native-builtin/v3`; v1/v2 inventories remain unchanged and a
v2 import cannot accept a downgraded patch bundle. A committed parent patch
receipt refreshes instruction scopes for every changed path, including both
move endpoints, without re-executing a tool during notification replay.

The publication owner captures source bytes, validates every hunk in a bounded
pure worker, then rechecks every preimage/path under the existing workspace
mutation lock before publication. A patch does not require a preceding model
Read, matching the reference handler. Successful writes refresh Native read
state for subsequent edits. Authorization, Plan restrictions, cancel and fence
checks remain in the existing execution path. Actual mutation paths are retained
immediately; a failure after publication yields an uncertain effect and cannot
be blindly replayed on recovery. This does not claim cross-file atomicity or
an OS-level compare-and-swap against external editors.

Explicit differences and remaining scope:

- Native uses strict UTF-8, preserves LF/CRLF and moved-file mode, and limits
  source/output to 2 MiB per file, 16 MiB total and 64 sections. ZCode's encoding
  port also supports legacy encodings. That parity remains pending.
- Native refuses duplicate/aliased/ancestor-overlapping paths and occupied move
  destinations instead of trying to overwrite or order dependent sections.
- Pure verification has a 2-second wall limit and 128 MiB worker old-generation
  limit. No added runtime package or model round trip is needed. End-to-end
  task speed and Token savings have not been measured.
- The actual preset-bound Studio path works. The subsequent Native-local catalog
  batch below also covers ordinary Agent authoring and frozen-Build admission.
  Hook Write/Edit aliases, undo and the rest of the file-tool audit remain pending.

Local checks:

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness/test/native-workspace-patch.test.mjs
node --test packages/agentkit-harness/test/native-workspace*.test.mjs tests/portable-bundle.test.mjs tests/dsh-node-workspace-tools.test.mjs
node --test --test-name-pattern='scoped instructions|structured patch receipts' tests/native-dsh-tools.test.mjs
pnpm check:contracts
node scripts/check-portability.mjs
pnpm pack --pack-destination /tmp/agentkit-native-patch-pack
node scripts/verify-studio-native-children.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-patch-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --continue-child --history --structured-patch --keep
```

The patch group passes 15 cases, including actual SQLite cold approval,
Plan denial before execution, external changes/cancel before publication and a
real state-persistence failure after the first published file without blind
replay. Affected workspace/portable/DSH regression passed 151 cases with one
optional Node-22-binary check skipped before the additional Plan case; both
instruction-scope cases pass. No full repository suite ran.

Portability passed for 1,621 tracked files. The packed proof log is
`/tmp/agentkit-native-patch-sdk.log`, with evidence in
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-mARkVk`. Its
`structured-patch-proof.json` records two real Host processes, eight parent/six
child model requests, two actual patch calls with six verified file changes,
two real reads and the same child Session across cold continuation. The child
workspace has the final edited/moved bytes and deleted paths absent; parent
workspace bytes remain unchanged. Node-only PATH excludes Python. Controlled
model responses prove adapter behavior, not live-model coding quality parity.

### Native-owned catalog, ordinary authoring and frozen-Build admission

`src/native-tool-catalog.mjs` supplies the new patch tool from the same definition
factory used by its executor. Discovery cannot label this writer read-only or
replace its schema with an old remote catalog entry. Native Host admission
resolves this explicitly bound local name before consulting the optional legacy
catalog, and only for the selected Native engine. No additional tool is silently
added to a Build, and no execution authority comes from a catalog response.

The Agent form now sends its selected runtime with tool discovery; the
authenticated resource route and template authoring use the same merged
catalog. Native search/source/status filters and paging apply after bounded
legacy-page collection, with a separate merged-cursor namespace, deduplication
and rejection of invalid/repeated cursors. The collection stops after 20 pages
of 200 legacy entries and asks for a narrower query rather than silently omitting
tools. An unavailable optional catalog produces an explicit warning and shows
the available Native-local addition. Cancellation, authorization and malformed
responses remain errors. DSH Native, Codex and untyped requests retain their
original remote catalog/cursor behavior.

This is authoring metadata work: it adds no model calls, tool declarations to
unbound Runs, runtime dependencies or extra execution loop. Large catalogs incur
bounded metadata collection before merged pagination; actual task-level latency
and Token comparisons remain pending. The implementation deliberately does not
replace the whole existing legacy tool directory in this batch.

Targeted checks passed 33 cases across catalog routing/transport, template
authoring and structured-patch execution; the final catalog/transport group
passes eight cases. Contracts and the client/package build passed. The packed
proof extends `--structured-patch` to read the authenticated catalog, create an
ordinary Agent from its returned resource ID, create a frozen Build and admit
that exact Build on both Host processes. Both parent recovery bindings retain
the original Build ID. It then performs the same two actual child patch calls,
six file changes and cold continuation under Node-only PATH. This proves the
actual authoring/execution backend path; it does not claim an interactive browser
click-through or live-model task-quality comparison.

```sh
node --test tests/native-tool-catalog.test.mjs tests/resource-remote.test.mjs tests/mcp-probe-route.test.mjs tests/template-authoring.test.mjs packages/agentkit-harness/test/native-workspace-patch.test.mjs
pnpm check:contracts
node scripts/check-portability.mjs
pnpm pack --pack-destination /tmp/agentkit-native-catalog-final-pack
node scripts/verify-studio-native-children.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-catalog-final-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --continue-child --history --structured-patch --keep
```

Portability passed for 1,623 tracked files. Final archive log:
`/tmp/agentkit-native-catalog-final-pack.log`; packed proof log:
`/tmp/agentkit-native-catalog-final-sdk.log`; evidence:
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-dLwD7Y`.
`native-catalog-authoring-proof.json` and `structured-patch-proof.json` preserve
the discovered schema/writer permissions, created Agent, exact frozen Build,
two actual Host processes, eight parent/six child model calls and
successful isolated patch results. The verifier's previous no-Build assertion
was updated to compare the actual frozen Build ID rather than removing the
recovery check. No full repository suite ran.

### Durable file-only rewind through the actual Studio Host

Reference review covers `src/runtime/helpers/rewind.ts` and
`methods/{tools,file-rewind,workspace-checkpoint-persistence,workspace-fork,rewind}.ts`.
The file-summary path builds a reverse plan, checks hashes and compensates partial
restore errors. Legacy checkpoint restore does not have the same hash guard.
The automatic scalar `filePath/originalFile/structuredPatch` candidate does not
accept aggregate ApplyPatch output. Native's journal/ledger adapter is an
independent implementation with behavioral source attribution.

Admitted Native writers freeze `workspaceCheckpointPolicy: file-preimages/v1`.
Before publication, a private SQLite journal durably records original bytes,
absence or an empty directory, planned afterimages, canonical paths and original
execution bindings. Success verifies actual bytes/modes and returns a checkpoint
ID. Existing Runs without this policy retain their frozen absence on restore;
the legacy DSH Native workspace inventory is unchanged.

The explicitly bound Native tools `list_workspace_checkpoints`,
`preview_workspace_rewind` and `rewind_workspace_files` enter the local catalog,
authenticated Agent creation, frozen Build, child workspace and portable paths.
List returns metadata, not saved contents. Preview joins target/subsequent active
checkpoints with original Native intents and committed results at the matching
call index. A local journal or model claim alone cannot authorize restoration.
It simulates reverse changes and checks current bytes, mode and canonical paths.
Apply requires the exact preview token, passes ordinary write/delete approval
and Plan restrictions, recomputes under the existing mutation lock, and retains
cancel/fence checks around journal I/O and publication. Original tools are never
rerun. Portable bundles binding a rewind tool use v4; v1/v2/v3 inventories remain
frozen, including refusal of recomputed downgraded manifests.

Supported cases include move endpoints, deleted binary preimages, CRLF/mode
preservation and empty-directory/file transitions. A successful rewind has its
own reversible checkpoint. Prepared/uncommitted effects block rewind. Known
no-effect failures can retry; any post-publication failure remains uncertain and
retains changed paths. An external edit, including during approval, invalidates
the preview. These behaviors do not create another execution loop.

Remaining differences stay in the original objective:

- This is file-only rewind. Conversation branch cuts/fork, user-facing rewind
  controls and combined conversation/workspace restore remain pending.
  Shell/external effects and implicit parent-directory creation are not covered.
- Checkpoints accept regular files up to 2 MiB, empty directories and absence,
  at most 100 paths/16 MiB of before/after bytes per operation. Oversized outputs
  are refused before writing. Large/legacy-encoded file parity remains pending.
  List returns the latest 50 metadata rows; the initial journal still loads
  session history for admission/planning. Large-history memory/latency needs
  optimization and acceptance.
- Native does not write automatic compensation after losing execution ownership
  or cancellation authority. The next batch below implements compensation while
  authority remains valid and final-receipt lookup. Partial restoration without
  a final receipt still needs explicit recovery; uncertain-effect blocking is
  not its replacement. No cross-file atomicity or OS-level compare-and-swap
  against external editors is claimed.
- No runtime dependency, Python process or extra model call was added. An
  eight-sample local 1-KiB fresh-file writer microbenchmark on Node v26.5.0
  measured median 6.566 ms without checkpoints and 12.029 ms with checkpoints.
  This approximate local-port overhead excludes model/network and proves no
  whole-task speed or Token saving. Report: `/tmp/native-rewind-cost.json`.

The final rewind group passes eleven cases: cold committed restoration, external
conflicts, directory/file transitions and inverse, uncommitted-receipt refusal,
legacy frozen absence, real post-publication persistence failure, approval-time
conflict, Plan refusal, oversized output refusal, original-operation replay
refusal across fence transfer and mode drift before checkpoint completion. The preceding affected
workspace/DSH regression passed 141 cases with one optional Node-22-binary case
skipped because that binary is absent. After the final guard/type-transition
changes the eleven-case rewind group passed again. Portable checks passed 19 cases,
the affected Host child-read/instruction group three cases, and contracts passed.
No full repository suite ran.

```sh
node --test packages/agentkit-harness/test/native-workspace-rewind.test.mjs
node --test packages/agentkit-harness/test/native-workspace*.test.mjs tests/dsh-node-workspace-tools.test.mjs
node --test tests/portable-bundle.test.mjs tests/native-tool-catalog.test.mjs
node --test --test-name-pattern='child reads|structured patch receipts|scoped instructions' tests/native-dsh-tools.test.mjs
pnpm check:contracts
node scripts/check-portability.mjs
pnpm pack --pack-destination /tmp/agentkit-native-rewind-final-pack
node scripts/verify-studio-native-children.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-rewind-final-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --continue-child --history --structured-patch --workspace-rewind --keep
```

Final pack log: `/tmp/native-rewind-final-pack.log`; Host proof:
`/tmp/native-rewind-final-sdk.log`; evidence directory:
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-jwZhIe`.
`structured-patch-proof.json` records two real Host PIDs (58385/58421), eight
parent/seven child model requests, two patches/six file changes, two reads, one
actual rewind across two cold-Host checkpoints, original child bytes restored
and parent workspace unchanged. The authored Build survives both recovery
bindings. Preview/read run concurrently so the second child stays within the
existing four-model/four-tool budget. Node-only PATH excludes Python. Controlled
model responses prove execution behavior, not live-model coding quality parity.

A real Claude Code read-only review reached its initial invocation budget;
resuming the same session without tools produced a report with explicitly
incomplete coverage. Main-agent verification rejected its deletion-tracking
finding: `remove()` already stages and tracks each deletion. The mode-completion
finding was addressed by validating intended restore/preserved modes. Intent
keys are unique in the Native store, so a hypothetical duplicate-intent finding
does not establish a bug. The verifier now also checks the original intent's
claimed fence and frozen turn, while operation deduplication deliberately ignores
fence transfer. Prepared/orphaned effects and partial-restore recovery remain
real unfinished scope; changing their label is not recovery. Review outputs:
`/tmp/native-rewind-claude-review.json` and `/tmp/native-rewind-claude-report.json`.
This is supporting review, not a complete independent certification.

Portability passed for 1,625 tracked files (`/tmp/native-rewind-final-portability.log`).

### Guarded rewind compensation and original final-receipt observation

Reference `src/runtime/methods/file-rewind.ts:149-219,253-278` reverses its local
write journal on a restore failure. Native now compensates a failed rewind under
the existing workspace lock while the original execution authority remains valid.
The durable checkpoint enters `compensating` before inverse writes. Only paths
actually published by this invocation are restored, in reverse order, and only
when bytes, mode and canonical target still match its last publication. Each
write/chmod checks cancellation, root and ledger/fence ownership again. Full
preimage verification precedes a durable compensated/failed result; the original
target checkpoints remain active so a fresh approved preview can retry.

Cancellation, fence loss, external edits and a repointed path (even with identical
bytes) prevent compensation from overwriting someone else's state. Failed or
interrupted compensation remains unknown and blocks later workspace writes.
Unlike the reference's unconditional compensation helper, Native never obtains
new write authority from a journal or a receipt-read request. This is an explicit
ownership difference; complete cold partial-restore repair is still pending.

New admitted checkpoint writers use the existing `receipt-observation/v1`
contract. The Host records their exact final typed result and post-policy model
view only after the DSH permission/result pipeline completes. A raw filesystem
success or a post-policy rejection cannot mint that receipt. The existing
operator `reconcile_tool` command then grants a separate, current fenced read of
the original scope/Run/turn/Build/call/claimed fence and frozen definition.
`observeReceipt` only reads private state; it cannot execute or repair files.
The Kernel retains the immutable original uncertain receipt, commits a new
observation, governs its result and charges the original tool once. Both success
and a successfully compensated error can be recovered this way. Rewind admission
also recognizes that actual committed observation rather than requiring the
original uncertain receipt to be rewritten.

Host reconstruction now explicitly preserves checkpoint/recovery policy
presence and absence from the original configuration. Pre-checkpoint Runs do
not acquire snapshots, and pre-receipt Runs do not silently gain reconciliation
authority. The new defaults remain unchanged for other Sessions. The existing
authenticated recovery status/reconcile route and client remain the operator
entry; no new model-facing tool, runtime dependency or execution loop was added.

Local evidence:

- The rewind group covers actual state-file failure/compensation and fresh retry,
  a lost compensated-error receipt across cold reopen, cancel/fence/external/path
  conflicts, raw-versus-final receipt distinction, original receipt preservation
  and rewind after a committed successful observation. Earlier file-only cases
  remain covered. Original unknown writes now hold the Session in
  `awaiting_reconciliation`; a new Run/model cannot bypass them.
- `tests/native-workspace-receipt-process.test.mjs` runs the production Host
  gateway, SQLite and Node workspace in separate PIDs. Accepted case:
  62136 SIGKILL → 62138 cold query; rejected post-policy case:
  62147 SIGKILL → 62158 cold query. Each publishes once, preserves the original
  config/intent/fence/uncertain receipt and charges one tool call. Accepted output
  resumes with the original filtered model view; rejected output stays unknown
  with no new model or tool dispatch. The DSH dispatcher/display policy is
  controlled in this test, not a full mounted Studio/UI recovery proof.
- The first affected workspace/receipt/authority group passed 28 cases. The
  affected Host/turn/portable/catalog group passed 140 cases, and the
  reconstruction/recovery-service group passed 24 cases. Contracts passed.
  The final affected group passed 31 cases
  (`/tmp/native-rewind-recovery-final.log`). The subsequent path-escape case and
  four related conflict cases passed (`/tmp/native-rewind-compensation-path.log`).
  The path-escape fix ensures a failure after publication stays uncertain rather
  than being mislabeled as a known pre-execution path error.
- `/tmp/native-rewind-compensation-sdk-final.log` proves the final packed actual
  `mountStudioHost`, authenticated authored Build and cold child rewind remain
  integrated. Evidence:
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-WG33Od`;
  PIDs 66533/66831, eight parent/seven child model requests, one real rewind,
  original child bytes restored and parent workspace unchanged, Node-only PATH.
  This is the normal cold-continuation flow, not an injected partial-repair UI
  proof or a live-model quality comparison. Pack log:
  `/tmp/native-rewind-compensation-pack.log`.
- A small eight-sample fresh 1-KiB writer measurement including final-receipt
  persistence observed median 15.244 ms without checkpoints and 31.990 ms with
  checkpoints on Node v26.5.0. Build/check activity overlapped this measurement;
  it is noisy local-port overhead, excludes actual DSH policy/Kernel/model/network
  and establishes no task-level speed or Token improvement. Report:
  `/tmp/native-rewind-recovery-cost.json`.

```sh
node --test packages/agentkit-harness/test/native-workspace-rewind.test.mjs tests/native-workspace-receipt-process.test.mjs tests/native-workspace-publication.test.mjs tests/native-tool-receipt-authority.test.mjs
node --test tests/native-dsh-tools.test.mjs tests/native-dsh-turn-runtime.test.mjs tests/portable-bundle.test.mjs tests/native-tool-catalog.test.mjs
node --test tests/studio-native-recovery.test.mjs tests/native-workspace-publication.test.mjs
pnpm check:contracts
node scripts/check-portability.mjs
pnpm pack --pack-destination /tmp/agentkit-native-compensation-pack
node scripts/verify-studio-native-children.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-compensation-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --continue-child --history --structured-patch --workspace-rewind --keep
```

No full repository suite ran. At this batch boundary prepared/compensating
checkpoints without a final receipt were still pending; the next batch adds an
explicit compensation path for newly admitted Runs. Legacy Runs without the
required policy, conversation branching and full runtime handoff remain pending.
Never infer a successful original operation merely from current bytes or clear
uncertainty by age/fence expiry.

The real Claude Code architecture audit completed in four turns
(`/tmp/native-rewind-recovery-claude.json`). Main-agent cross-checking also read
`tool-receipt.mts` and confirmed the separately fenced query contract and ordinary
non-A2A operator entry. Its general statement that all automatic reconciliation
is absent is too broad: A2A has its own explicit waiter path; this local workspace
batch does not add an automatic write/repair path. A second read-only code review
reached its invocation budget without a final report
(`/tmp/native-rewind-compensation-review.json`). Its tools-disabled continuation
also ended at its budget without a final report
(`/tmp/native-rewind-compensation-review-final.json`). Neither is a passed
independent review. The main-agent source review and runtime evidence above
remain the completed checks.

### Explicit cold compensation of an unconfirmed workspace operation

The same pinned ZCode `runtime/methods/file-rewind.ts:149-219,253-278` journals
and compensates writes in the active process. Native now extends its existing
single loop with a separately persisted `workspace_repair` effect for an explicit
operator request after process loss. It is deliberately distinct from the
read-only `tool_receipt` effect. No receipt observer can gain write authority.

New writer definitions admit `workspaceRepairPolicy: preimage-compensation/v1`.
The original frozen definition, call, scope, Run/turn/Build, claimed fence and
uncertain receipt must all match. The new effect requires its own live lease and
fence. Configuration validation rejects attaching the policy to a non-checkpoint
tool; reconstruction preserves old policy absence. A changed preset/root/session,
lost authority or cancellation blocks inverse writes.

Under the existing cross-process workspace lock, the journal verifies all paths
before compensation. Each file must still equal its original preimage, planned
postimage, or a specifically recorded intermediate state. Canonical targets,
bytes and modes are checked; unrelated external edits are refused. Intermediate
publication/chmod states and the responsibility to restore a completed rewind's
checkpoint chain are persisted before inverse writes. A second crash therefore
retains enough state for a new authorized attempt. Journal state candidates are
deduplicated; file bytes are not duplicated for these metadata records.

Completion verifies all restored preimages and atomically marks the original
journal compensated/failed. If the unconfirmed operation was a completed rewind,
only the checkpoints marked undone by that operation are reactivated. The exact
original uncertain Kernel receipt stays immutable. A repair result is always
`error / workspace_operation_compensated`, never a claim that the original tool
succeeded. The model receives that failure through existing governance/post-hooks
and the original tool attempt remains charged once. A lost repair claim is
classified as unknown, not automatically replayed; the next compensation requires
another explicit operator command after normal lease acquisition.

The Host dispatches the operator-only internal tool through the actual DSH
permission and result pipeline. It is absent from the model catalog and rejects
unbound registry calls. A changed/rejected final model view cannot certify the
compensation result. The journal stores the final repair receipt separately from
the original tool's final receipt. Delivery loss can recover that same repair
outcome, while raw compensation without approved output remains unknown.

Product entry: `sessions/native-workspace-repair`, exposed on both local RPC and
HTTP control clients. The recovery service checks the original live turn and
frozen preset/Build before enqueuing `repair_workspace`, then wakes its existing
driver or resumes the original Run. The request contains only original identity
and an idempotent command ID, never file bytes, result claims or a permission
grant. In the recovery panel, an eligible Run offers “撤销未确认文件修改并继续”
inside an explanation that recommends checking the original receipt first.
Refresh never writes; an unconfirmed client response retries the same command.

Evidence and limits:

- `/tmp/native-cold-repair-final.log`: 98 targeted cases passed across the original
  receipt contract, workspace rewind/publication, separate read/repair authority,
  product recovery service/client and actual gateway process tests. The late
  journal metadata deduplication passed all seven process cases in
  `/tmp/native-cold-repair-final-paths.log`.
- Seven Node-only process scenarios use the production gateway, SQLite and real
  files: partial publication then SIGKILL; external edit; denied permission;
  Session replacement after admission; rejected post-policy result followed by a
  fresh approved request; lost final repair delivery; and a second SIGKILL after
  an inverse publication but before completion. The last case waits for the real
  recorded lease expiry, classifies the lost claim without tool dispatch, then
  submits a new operator command. Original intent/config/receipt are preserved.
- The Host/turn/portable/catalog group passed 139 of 140 initially: its remaining
  assertion expected the old exact registry inventory. The updated case now
  explicitly proves the internal registration is hidden from the model and an
  unbound direct invocation fails; it passed separately
  (`/tmp/native-cold-repair-catalog-final.log`). Contracts passed; portability
  passed for 1,630 tracked files (`/tmp/native-cold-repair-portability-final.log`).
- The final packed Studio normal cold-child/rewind flow passed
  (`/tmp/native-cold-repair-sdk-final.log`), evidence directory
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-Kn4Ccr`.
  This proves actual SDK/mount/Build compatibility, not fault injection through
  the mounted Studio repair UI. The gateway process scenarios use controlled DSH
  policies and model replies; the service test uses an Agent double.
- No new runtime dependency, second execution loop or default extra model call
  was introduced. These local cases do not establish whole-task Token savings
  or latency improvement; the fixed before/reference/after comparison is pending.
- A real Claude Code read-only journal review ended at its budget without a
  usable final report (`/tmp/native-cold-repair-claude.json`); it is not passed
  independent review. Do not keep waiting on that terminated invocation.

Remaining limits: only recorded bounded file operations and empty-directory
states are compensable, not arbitrary Shell/MCP effects or recursive parent
directory creation. Private journal/preimages must be intact. External conflicts
require operator resolution, not forced overwrite. Non-cooperating filesystem
races remain possible between checks and OS writes; this is not an OS transaction
or CAS. Legacy Runs without the frozen repair policy are not upgraded. Managed
server control and child-specific product repair flows, full mounted fault/UI
acceptance, conversation branches, neutral engine handoff and large-history
journal performance remain pending. No full repository suite was run.

## Mounted Studio partial-write compensation acceptance

The explicit-compensation item above now has a production mounted-Host proof,
in addition to its controlled gateway process cases. Reproduce with:

```sh
pnpm pack --pack-destination /tmp/agentkit-native-mounted-repair-pack
node scripts/verify-studio-native-harness.mjs \
  --source .artifacts/dsh-native-zcode \
  --archive /tmp/agentkit-native-mounted-repair-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz \
  --mount-host --workspace-repair --frozen --keep
```

`scripts/native-workspace-repair-proof.mjs` drives the public maintained SDK and
the actual packed Studio. The fixture only makes the original read-state
persistence target a directory: the first real ApplyPatch file publication then
succeeds and read-state publication fails before the second file. The production
Kernel journals the uncertain original operation. After a real Session flush,
the fixture stops the actual Host; the parent confirms its PID is live and sends
SIGKILL. The cold Host uses its real SessionController/preset restoration and the
authenticated `sessions/native-workspace-repair` operation. No replacement
prompt, forged original result or substitute model/tool loop is installed.

Final evidence: `/tmp/native-mounted-repair-proof.log`, directory
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-y8hmc5`,
including `accepted-evidence.json` (archive SHA-256/dependency provenance) and
`workspace-repair-proof.json`. The original frozen Build remains admitted while
the fixture's latest Agent instructions differ. Assertions cover actual partial
bytes before death, missing second file, unauthenticated 401, read-only status,
rejection of caller-supplied result data, unchanged original configuration,
config digest, intent and uncertain receipt, one tool attempt, one separate repair
intent, compensated files before the second model request, exact final assistant
text, unchanged durable Session prefix, one turn/start/owner/end, and idempotent
operator command retry. Two controlled model calls and one charged original tool
attempt complete the original Run. Provider billing remains unknown; the usage
summary correctly does not claim complete cost accounting.

This closes the mounted **local root Session** fault/recovery acceptance gap;
it does not certify the browser button, managed-server/child-specific repair,
Shell/MCP compensation, full conversation undo, or performance. No full suite was
run. Progress remains **29/100**: this strengthens the already credited explicit
compensation item rather than counting the same feature twice.

## Conversation fork/rewind source audit and next implementation

Pinned ZCode source and tests establish these behaviors:

- `runtime/methods/session-fork.ts:1061` selects the active transcript, validates
  an exact contiguous stable segment ending at a successful assistant message,
  and preserves only its prefix (`stableForkHistoryMessages`, line 1143).
  Tests `session-fork.test.ts:1322` and `:1374` cover no boundary expansion and
  missing/out-of-order/duplicate/invalid boundaries; these tests were read, not
  executed in this checkout.
- `commitAtomicConversationFork` (line 585) preallocates child-local message,
  part, turn, tool and goal/verifier identities, then calls `commitForkBundle`
  once (line 748), including historical model selection and execution state.
  This ordinary conversation fork returns no restored files. A fork operation
  must not silently restore workspace files or adopt source execution authority.
- `rewind-message.ts:440` resolves the active branch independently of compact
  visibility. `applyConversationRewindPlan` (line 542) cancels removed-branch
  background work, persists kept IDs/cut/generation, and rebuilds history and
  read-state (line 675). `session-history-rewind.test.ts:277` demonstrates that
  repeated edits must not revive an abandoned original branch.

At the audit checkpoint preceding the implementation below, maintained DSH's
`packages/api/session-controller/src/commands.ts:226` and
`packages/core/session/src/fork.ts` already create an event-prefix fork and
synthetic closers for an open tail. Native's new-Run path in
`packages/agentkit-harness/src/native/dsh-turn-runtime.mjs:186` resolves only the
new Session's own store head; `core/src/kernel.mts:100` and `history.mts` import
history only from that ledger parent. A copied visible DSH transcript alone is
therefore not evidence of an imported Native model history. There is currently
no Native fork history-seeding bridge in that path at that checkpoint. The new
adapter below adds the closed-turn bridge. Forked model selection also
needs an explicit comparison: generic DSH fork uses current defaults, whereas
ZCode resolves historical normal selection.

The implementation must import the selected conversation into a fresh admitted
Native Run, bind its exact source/boundary/digest, preserve protocol pairing and
appropriate Todo/Plan/context state, and verify cold first-use and fork-of-fork.
It must leave source Run, lease/fence, budgets, pending operations, private file
checkpoints and command ownership with the source. In-place rewind additionally
needs a persisted active-branch cursor and derived-state rebuild; simply hiding
UI events or reusing a different Run head is insufficient. Open cuts, compact
boundaries and combined file/conversation rollback remain explicit acceptance
cases, not exclusions from the original goal.

Real Claude Code completed a bounded read-only audit in four turns
(`/tmp/native-conversation-fork-review.json`). Its missing-executor and
memory-based assertions are not accepted as findings: the main agent checked
the actual executor/kernel/history, the DSH fork seed and synthetic closers.
In particular, copied ownership records are not by themselves proof that a
closed inherited turn becomes active in the child, nor that private checkpoints
are copied. Only the evidenced history-adapter/model-selection gaps above guide
the next change. No full fork/rewind alignment point is earned by this audit.

## Integrated Native closed-turn conversation forks

`src/providers/native-conversation-fork.mjs` now bridges the existing production
DSH SessionController fork to Native's single execution loop. On a fresh fork's
first admission it:

1. Locates this Session's own inherited-prefix boundary and compares that exact
   prefix with a read-only observation of its actual parent Session. Cancellation,
   Session replacement, parent/prefix changes and a different Native scope are
   rejected before importing any checkpoint data; observations are always released.
2. Resolves the selected closed turn's original Native ownership, not the source
   Session's latest head. The admitted configuration and every identity field must
   match the private ledger's terminal checkpoint. Its revision, configuration,
   snapshot and transcript digests become frozen provenance.
3. Projects the existing Native history into a new Session-specific tool-ID
   namespace, retaining call/result pairing and original observation provenance.
   Existing historical IDs are remapped again on fork-of-fork, then stay stable
   across ordinary subsequent turns. Source tool calls remain observations.
4. Admits `native-conversation-fork/v1` data in the new configuration. The core
   validates protocol pairing and rejects system authority/current input IDs and
   private provider protocol bytes. Todo items/priorities and currently admitted
   discovered tools are initialized in the child's own state. Budgets, pending
   effects/interactions, leases, children, background commands, workspace mutation
   state and execution-owned artifact references are initialized fresh.
5. Uses the existing session-head CAS to create an independent Run. Its
   `parentRunId` is null, rather than adopting the source execution chain. The
   source is unchanged. Same-turn redelivery uses frozen seed bytes; recovery
   retains the original optional field, and later ordinary child turns inherit
   from their own ledger parent without re-querying/re-importing the source.

Native deliberately keeps provider-private reasoning, signatures and protocol
replay in the original private ledger. They are excluded from this seed because
the seed is also serialized in the durable DSH ownership event. Model-visible
text, media and paired tool facts still travel by value. This is a documented
fork boundary difference from retaining every private protocol part in a ZCode
fork bundle; its cache/cost/quality impact remains to be measured. The ordinary
same-Session Native replay behavior is unchanged. No new service, model summary,
planning model or execution loop was added; initial work/storage is proportional
to the selected history, which still needs large-history measurement.

Reproduce the actual integration proof:

```sh
pnpm pack --pack-destination /tmp/agentkit-native-conversation-fork-pack
node scripts/verify-studio-native-harness.mjs \
  --source .artifacts/dsh-native-zcode \
  --archive /tmp/agentkit-native-conversation-fork-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz \
  --mount-host --conversation-fork --frozen --keep
```

Final proof passed in `/tmp/native-conversation-fork-proof-final.log`, evidence
directory `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-ssStDN`.
`accepted-evidence.json` records package SHA-256
`b7b6f781db465f1e0429fc5ae123f160b6c108b8da6d0a39e137dbe55c80571f` and maintained
Host provenance; `conversation-fork-proof.json` records four distinct Host PIDs
(81999, 82021, 82024, 82035) and eight controlled model HTTP calls. It uses the
actual SessionController fork entrypoint with a test-only command transport,
the public SDK for prompts, real SQLite and the packed Studio/standard Host.
Controller and SDK Agent handles are separated by real process shutdown, proving
durable publication and cold first use rather than opening duplicate writers.

Assertions cover a selected earlier turn after the source advanced, exclusion of
later source text, historical file call/result pairing without another file
effect, Todo priority and discovered-schema continuity, fresh independent Run
budgets/state, cold ordinary child continuation, an earlier child boundary after
that child advanced, fork-of-fork ID remapping, unchanged source/child ledgers
and file bytes, and the frozen Build while latest Agent instructions differ.
The controlled model establishes request behavior, not general coding quality.

Related checks:

- `/tmp/native-conversation-fork-targeted.log`: 185 relevant history, turn,
  Host and recovery cases passed (including four new core seed cases).
- `/tmp/native-conversation-fork-final-units.log`: 15 seed/adapter/boundary cases
  passed, including the four core cases above. The other eleven cover exact
  source selection, altered prefix/scope, canceled/replaced Sessions, redelivery,
  private replay exclusion and open boundaries. A fork of an open fork's
  synthetic `forked` closer cannot authorize import of the source's later full
  checkpoint.
- Harness compilation and final contract checks passed. No full repository
  suite was run. Claude Code completed its isolated test contribution in eight
  turns (`/tmp/native-conversation-fork-tests-review.json`); the main agent fixed
  its input fixture, replaced a vacuous private-data assertion with a real
  private-replay source, reviewed the file and ran the tests. This contribution
  is not an independent implementation-review pass.

At this earlier closed-turn checkpoint, earned progress was **30/100**, M5 **6/15**. One new point covered the integrated
closed-turn Native fork behavior above. It does not certify full conversation
branching or the whole recovery milestone. At that checkpoint Native refused arbitrary
open cuts and synthetic closed tails rather than importing a later checkpoint;
fresh managed-server fork admission is explicitly unsupported. Background-owned
source boundaries still need their own capsule/history adaptation. In-place rewind,
before-input/root cuts, full historical model/permission/Plan selection, large or
compacted history and media/artifact-reference fork acceptance, combined file and
conversation rollback, managed/child-specific flows and neutral cross-engine
handoff remain in the original implementation/acceptance scope. No token savings
or speedup is claimed.

## Exact ordinary Native conversation cuts (31/100)

The next batch extends the same production fork admission rather than adding
another execution loop or a separate branch runtime. The pinned ZCode
`session-fork.ts:1091` copies the active prefix **before** the selected real user
input, including the empty/root case; `conversationHistoryBeforeInput:1119`
does not widen the cut to the source's later turn. The stable segment resolver
at line 1143 likewise requires the exact contiguous selected IDs. Native now
resolves ordinary DSH event-level cuts to the corresponding Native transcript
instead of treating every open turn as unavailable.

The DSH API exposes event-level cuts, including a pending tool call; ZCode's
stable fork API validates an assistant-ended segment. Native keeps the existing
DSH granularity with explicit unknown historical tool closure instead of
treating a pending call as completed or adopting its execution state.

Implemented behavior:

- `native-conversation-cut.mjs` selects only the admitted input or published
  model/tool message at the inherited boundary. A source may already have
  finished or still be executing its tool. Neither its latest message cursor,
  queued guidance nor final answer can widen that selected prefix.
- Before-input/root cuts retain only earlier history. A cut before the first
  owner can authenticate the later observed Native scope but imports no history
  or later state. A new turn before its ownership event preserves the preceding
  completed conversation. These pre-owner variants have adapter tests; the
  packed root proof cuts after ownership and before the first admitted input.
- DSH synthetic `forked` closers no longer imply that the original source Run
  was complete at that point. A fork of such a prefix selects the same partial
  history with new child-local protocol IDs. This variant has adapter coverage;
  the packed nested-fork scenario remains the earlier closed-turn variant.
- A selected call without its selected result is closed as an explicitly
  unknown historical observation. It is not a child pending tool. Its later
  source success is not copied, and no source effect is dispatched by admission.
  Actual external state may have changed after the selected conversation cut;
  this operation does not rewind workspace files.
- Todo state comes from the selected public prefix. Discovered schemas come
  from the initial inherited discovery and selected committed tool observations,
  rather than the source's later TodoWrite/ToolSearch results.
- `delivery-timeline.mjs` shares deterministic publication IDs, output-retirement
  position reconstruction and terminal receipt closures between Session delivery
  and cut selection. Targeted tests cover cuts before/after output retirements
  and a committed uncertain receipt without leaking private receipt content.
- The core's new data-only `projectConversationHistory` permits an authenticated
  cut from an active source. Ordinary `projectSessionHistory` still requires a
  terminal parent. The source Run, lease, pending effects and immutable admission
  are unchanged; existing cold recovery uses the child's frozen seed bytes.

Reproduce the integration proof:

```sh
pnpm pack --pack-destination /tmp/agentkit-native-open-fork-pack-final
node scripts/verify-studio-native-harness.mjs \
  --source .artifacts/dsh-native-zcode \
  --archive /tmp/agentkit-native-open-fork-pack-final/kingsoftcloud-agentkit-studio-0.0.2.tgz \
  --mount-host --conversation-fork --frozen --keep
```

`/tmp/native-open-fork-proof-final.log` passed. Evidence is in
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-TmYkSL`;
archive SHA-256 is
`e2e66e92239048a3b8bbd1cb3c3e5b9ceaa718cdd9b3c2e13000bdc5346d5b28`.
The extended verifier retains the earlier closed-turn/cold continuation/nested
fork assertions and adds four cold first uses after the source advanced:
before-input/root at seq 9, input at seq 10, pending call at seq 14, and settled
write result at seq 18. Eight actual Host processes (87454, 87471, 87477, 87485,
87497, 87505, 87510, 87520) made twelve controlled HTTP model calls. All four new
Runs have fresh budgets, no tool effect, no source future answer/Todo, and only
the settled-search cut promotes TodoRead. Source ledger/file bytes remain
unchanged. This uses the actual production SessionController fork via the
existing test command transport, SDK prompts, SQLite and packed Studio/standard
Host; it is not a browser-click test or a real-model quality comparison.

Related checks passed:

- `/tmp/native-open-fork-regression-final.log`: 141 relevant delivery, ordinary
  turn, history, output recovery and seed cases at the shared-helper checkpoint.
- `/tmp/native-open-fork-cuts-final.log`: 20 core cut/adapter/boundary cases,
  including live source tool execution, pre-owner roots, later pre-owner turns,
  synthetic closer nesting and private replay exclusion.
- `/tmp/native-open-fork-timeline-final.log`: 30 delivery/core cut cases including
  the added output-retirement and uncertain-closure assertions. These check sets
  overlap; their counts are not additive progress evidence.
- Harness compilation, contract TypeScript and portability checks passed
  (1,642 tracked files after staging the new modules/tests). No
  full repository suite was run for this batch.

Real Claude Code contributed only
`core/test/conversation-history-cut.test.mjs` (under the Harness core package).
Its initial invocation reached the seven-turn limit without a file; the same
session resumed and completed in four turns. The main agent reviewed and ran
all six contributed cases. Logs:
`/tmp/native-open-fork-claude-tests{,-resumed}.json`. This is a test contribution,
not independent review approval or an ongoing parallel task.

Earned progress is **31/100**, M5 **7/15**. The new point is the integrated cut
behavior above, not full conversation parity. Remaining original scope includes
in-place conversation rewind and derived read-state reconstruction, combined
file/conversation rollback, full historical model/permission/Plan selection,
managed/background-owned source capsules and child-specific flows, complete
large/compacted history and media/artifact-reference acceptance, neutral engine
handoff, other M1–M4 gaps and the M6 before/reference/after comparison. The cut
adds no model summary/request or duplicate Agent loop, but large-history CPU,
storage, Token, latency and coding-quality comparisons remain unmeasured.

## Local evidence and comparison protocol

The initial file-rewind audit used a real Claude Code read-only invocation that reached
its six-turn limit; resuming it with tools disabled produced a report explicitly
marking incomplete Native coverage. The main-agent cross-check read
`runtime/helpers/rewind.ts`, `methods/{tools,file-rewind,workspace-fork,rewind,workspace-checkpoints}.ts`
and Native's write/edit/delete/read-state/publication paths. Corrections to the
report matter: the legacy `restoreWorkspaceCheckpointFiles` writes/removes its
saved state directly; hash conflict checking and compensation belong to the
file-summary rewind path, not every reference restore path. An originally
absent file has a null preimage, while undoing a deletion needs its saved bytes.
The reviewed automatic checkpoint candidate accepts a scalar `filePath`,
`originalFile` and `structuredPatch`; the aggregate ApplyPatch output does not
meet that shape. Full reference undo coverage must not be inferred from an
interface or handler name. Native's read-state hashes and child publication
receipts alone do not establish a parent file-undo feature. The integrated batch
above joins durable preimages, preview/conflict checks, authorized apply and cold
recovery. Full rewind parity remains unfinished; an unused snapshot module alone
would not certify it.
Audit logs: `/tmp/agentkit-native-zcode-undo-claude.json` and
`/tmp/agentkit-native-zcode-undo-claude-report.json`. This research adds no earned
milestone point and is not runtime acceptance evidence.

Representative tasks must cover code navigation, a bug fix, a cross-file edit,
tool failure, truncated tool output, active-turn guidance/cancel, long context,
cold recovery and unknown side effects. Use matching model, permissions,
workspace and budgets where possible; disclose every mismatch. Protocol fixture
tests prove adapter/state behavior, not real-model coding quality.

Record per task: success criteria/result, total input/output tokens, cache usage
when reported, cost when available, model/tool/child/retry/summary calls and total
elapsed time. Include all descendant and recovery costs. Missing provider billing
data stays unknown. No savings percentage or ZCode quality parity is established
yet. Baseline/reference/after live comparison remains pending.

Run targeted checks per integrated change; perform broader necessary checks at
milestone closure. Local-only acceptance does not require cloud credentials.
Final completion requires every original requirement, the matrix, comparison
evidence and all intentional differences to be accounted for.

## Idle same-Session conversation rewind (32/100)

Pinned ZCode `src/runtime/methods/rewind-message.ts:440` builds a cut before
an active user input; `:542` commits the branch and cancels removed tasks;
`:675` resets and hydrates provider history, read-file state and context prefix.
This batch implements the ordinary **idle conversation-only** branch operation.
It does not claim the active-task or combined file/conversation behavior.

Native uses the existing append-only DSH Session surface replacement as the
branch authority. The authenticated `sessions/native-conversation-{status,rewind}`
Host routes resolve the live Agent and frozen Native preset, validate the current
head/generation and select a real active human input. They freeze a data-only
prefix seed before that input and append one replacement notice. A successful
response requires Session persistence. Retrying the same command/payload reuses
that marker; changing its payload conflicts. Existing Runs are never rewritten.

The next Run remains a child of the actual execution head for audit purposes,
but rebuilds its model history/Todo/discovery from the selected seed. A branch
identity is immutable within a Run and inherited by ordinary follow-up Runs.
Cold restore and same-turn redelivery keep their admitted configuration. An
inherited parent Session marker cannot issue a rewind in a fork child.

Workspace files and checkpoints remain at their current state. Branch adoption
clears removed-branch read authority **before** an editor snapshots its read
preconditions. This order matters: the first packed attempt exposed an edit
capturing the old read state before the later publication guard. The gateway
now adopts before both reads and edits; adapter regressions cover both first
operations. Fresh reads survive a cold ordinary continuation in the same
branch. Hydrating still-valid reads from the retained prefix is pending, so
this conservative implementation can require an extra reread compared to ZCode.

The Studio panel selects active inputs and describes the file-preserving
operation. Unknown responses retain the exact original request for retry;
known pre-append conflicts refresh and allow a new selection. Older in-flight
status responses cannot resurrect a removed branch in the panel. This is
state/build verification, not an actual browser-click acceptance claim.

Acceptance:

- Final packed command:
  `node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-conversation-rewind-pack-final/kingsoftcloud-agentkit-studio-0.0.2.tgz --mount-host --conversation-rewind --frozen --keep`.
- Archive SHA-256: `202ad20847118b1f08286b403ddc143012b3ef278fb87d6bd00fecce3efccc11`.
  Evidence: `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-UwUbu3`,
  Host PIDs 97429/97454/97466/97478; log
  `/tmp/native-conversation-rewind-proof-final.log`.
- Actual SDK Session, authenticated HTTP controls, SessionController and SQLite:
  first cut/replacement, duplicate/conflicting commands, removed target refusal,
  repeated cut to the original first input, cold root and ordinary follow-up;
  old text/Todo/discovery does not return, file bytes persist, stale reads fail,
  fresh cold reads authorize editing, and original Run records remain identical.
  Thirteen controlled HTTP model calls; no original write replay or model summary.
- Related regression remainder: 164 pass
  (`/tmp/native-rewind-regression-rest.log`). Host/gateway/legacy-route group:
  327 pass, two unrelated fixed legacy `resources/list` recordings fail
  (`/tmp/native-rewind-regression-repair.log`). The original HEAD resource route
  independently reproduces `INVALID_RESOURCE_SOURCE` for both recordings;
  its source, resource catalog and recording are unchanged. The fixed operation
  inventory excludes the new Native controls and the previously omitted separate
  workspace-repair control; legacy response recordings are not rewritten.
- Final UI/Host guard group: 26 pass (`/tmp/native-rewind-ui-final.log`), including
  live-Agent replacement, request mutation, lease/running refusal, uncertain
  per-tool effects, failed flush retry and the two UI races. Marker admission:
  ten pass (`/tmp/native-rewind-markers.log`). Counts overlap earlier runs.
- Core/client/MCP builds and contracts compilation pass. No full suite was run.
  Actual Claude Code contributed the initial panel/state tests and the marker
  admission test file; the main agent reviewed and corrected the contribution,
  implemented core/Host/gateway integration and performed packed acceptance.

No Token saving or speed parity is claimed. The operation avoids an extra model
summary; Session snapshots, branch validation and read-state persistence have
unmeasured local cost. M6 remains **0/15**. Earned progress is **32/100**,
M5 **8/15**, with the same denominator. Active cancellation and removed tasks,
retained-read hydration, combined rewind, historical/media/compaction variants,
managed/background/child semantics, neutral handoff, remaining M1–M4 gaps and
the fixed before/reference/after comparison still require work.

## Retained read observation hydration (33/100)

Reference: pinned ZCode `src/agent/read-file-state-hydrator.ts:29` selects active
messages, `:101` restores full Read observations, and `:127` restores successful
Write/Edit metadata. Its comment at `:136` explicitly forbids reading current
disk to fill in historical write/edit knowledge. Native now follows that rule
for ordinary idle same-Session conversation rewind.

`workspace-tools.mjs:85` captures serialized revision observations at the actual
read/publication point, including post-edit merged bytes, through the existing
`refreshReadState` path. Successful complete Read/Write/Edit, batch writes and
patches can carry `metadata.nativeWorkspaceReads` in the existing private tool
receipt. The observation stores relative/canonical path, exact string-encoded
mtime, byte size, line coverage and content SHA-256; it does not duplicate file
content. Failed/partial observations are not promoted to full observations.
The DSH gateway removes Read metadata when the post-policy observation differs
from the original authorized Read output. The kernel's unread-source result
also prevents restoration. No tool-definition or model request field is added.

`native-conversation-reads.mjs:8` walks only the selected seed's historical tool
results. Original Run/index/name/content provenance must match, and the original
private receipt must be committed with an `ok` result and valid full metadata.
Result contexts must match the selected observation. Missing legacy evidence,
unmatched/unknown closures, failed/uncertain/uncommitted/unread results and
foreign scopes cannot manufacture read authority. Source records are loaded and
indexed once per original Run during adoption, rather than searching the entire
ledger for each result. No new execution loop or second operation journal exists.

Each new branch generation hydrates from **its own** selected prefix before its
first workspace operation. Same-generation continuation does not rehydrate and
therefore retains fresh reads/edits across restart. A later root cut supplies an
empty prefix and clears everything again. Failed state publication rolls back
the in-memory adoption so retry cannot mistake an unpersisted branch for an
accepted one. Canonical workspace checks and Native's existing mtime/size/hash
stale guards remain; current disk bytes never replace the historical revision.

Evidence:

- Actual packed command:
  `node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-retained-read-pack-final/kingsoftcloud-agentkit-studio-0.0.2.tgz --mount-host --conversation-rewind --frozen --keep`.
  SHA-256 `8b5e16d4b924a0f9f8745745cb93f01234d8fdb300290919e4bd9c3cb9356497`.
- PASS log `/tmp/native-retained-read-proof-final.log`; actual Host/SQLite/Session
  evidence `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-ljCewz`;
  four Host PIDs 1104/1128/1147/1157 and thirteen controlled model calls.
  Retained full Read and Write both authorize editing after cold rewind without
  another Read. A removed branch's newer Read cannot certify an externally
  changed file; a removed-only file observation cannot authorize editing.
  Repeated root rewind, ordinary cold continuation and immutable source Runs
  still pass. The model request assertions and saved public Session log contain
  no private read metadata (`retained-read-audit.json`).
- Real-kernel selection/hydration group: 17 pass
  (`/tmp/native-retained-read-selection-final.log`), including successful Edit
  post-image, partial/external changes, missing evidence, uncertain/uncommitted
  receipts, foreign workspace/scope, repeated root and failed publication retry.
- Gateway/post-policy and selection checkpoint: 74 pass
  (`/tmp/native-retained-read-observation.log`). Final workspace/Session/Host
  guard group: 63 pass (`/tmp/native-retained-read-final-checks.log`). These
  checkpoints overlap; they are not an additive test count. Contracts and the
  packed core/client/MCP builds pass. No full suite was run.
- Actual Claude Code performed a read-only review of the reference and planned
  integration risks; it made no edits and ran no tests. The main agent reviewed
  its findings. Its suggested first-generation-only hydration flag is not used:
  later rewinds have their own fresh seeds and must hydrate those, while a root
  seed stays empty. Selected-message provenance bounds the receipt lookup.

The local proof persisted eleven observation capsules totaling 4,664 bytes,
420–431 bytes each. This is private receipt storage in this fixture, not a Token
saving or speed benchmark. There is no additional model summary. Native keeps
its strict original mtime/size/hash checks; output-altering Read policies can
require a fresh Read. Legacy observations without metadata likewise need a
fresh Read rather than retroactively reading current files.

Earned progress is **33/100**, M5 **9/15**, denominator unchanged; M6 remains
**0/15**. Active cancellation/removed task cleanup, combined rewind, complete
historical/retirement/compaction/reconciled-state variants, fork/isolated-child
read hydration and neutral runtime handoff remain unaccepted, alongside the
other matrix gaps and the fixed before/reference/after comparison.

## Active model stop before conversation rewind (34/100)

Reference: pinned ZCode `src/runtime/methods/rewind-message.ts:542-572`
commits conversation replacement only after removed-branch task cancellation;
`:628-650` filters running tasks by branch generation and removed turn IDs and
fails closed if stop cannot be confirmed. This increment implements the Native
active-turn stop boundary; full branch-selective background/child cleanup is
still required to align that complete reference behavior.

`src/host/services/native-conversation.mjs` now receives a read-only lookup into
the actual installed Native executor controls. A request validates the exact
head/generation/active input and freezes the retained data-only seed before any
cancel. The original kernel persists a request-bound cancel command, wakes its
own idle wait, and the original Agent is canceled with user cause. The service
does not install another driver or acquire another lease. It awaits the actual
Agent's `whenIdle()` with a 30-second bound, then authenticates the binding again
and checks Agent identity, head, retained prefix, input identities and generation
before the Session surface replacement. A terminal kernel still delivering or
cleaning up is awaited without a new cancel command.

Concurrent identical requests share the in-flight result. Conflicting requests
cannot race the branch commit; a durable cancel also binds the original request
digest across timeout/retry. Accepted marker retries only flush the same marker.
The Studio panel labels active requests as stop-and-rewind and explains when
execution stopped but unresolved work prevented the branch commit.

A canceled model request can have unknown provider usage without having executed
any tool. Its original uncertain receipt and usage diagnostics remain immutable;
the selected history omits the removed response. This is not permission to discard
unknown side effects. Unknown tools, uncertain members of a committed tool batch,
unsettled child states/budget reservations and outstanding background notifications
still prevent commit. No canceled write is replayed to make the rewind succeed.

Local evidence:

- `node --test tests/studio-native-conversation.test.mjs tests/native-conversation-state.test.mjs tests/native-conversation-rewind.test.mjs tests/native-dsh-ownership.test.mjs`:
  **72 passed**, `/tmp/native-active-rewind-final-checks.log`. Includes a real
  Native kernel canceled during a claimed write, no second write, bounded Host
  wait/retry, request conflicts, changed prefix, foreign control, aborted caller,
  pending children/usage/background and terminal-kernel cleanup. The final
  cleanup assertion was independently re-run: **1 passed**,
  `/tmp/native-active-rewind-terminal-boundary.log`.
- Existing core cancellation/approval selection: **4 passed**,
  `/tmp/native-active-rewind-kernel.log`. Contract compilation and pack-time
  core/client/MCP builds/portability checks passed. No full test suite was run.
- Actual packed proof:
  `node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-active-rewind-pack-final/kingsoftcloud-agentkit-studio-0.0.2.tgz --mount-host --conversation-rewind --conversation-active-rewind --frozen --keep`.
  PASS in `/tmp/native-active-rewind-proof-final.log`; evidence directory
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-qHZPZi`.
  Archive SHA-256 `338735e268d94b35846403825448af3ab3cbe2dafc7441318a463e81ce82bf2e`.
  Five actual Host processes (7322/7357/7371/7384/7399), **15 controlled HTTP
  model requests**, seven Runs. Request 14 remains open until canceled through
  the authenticated Studio rewind route; the SDK observes an aborted turn,
  generation 3 commits once, and a fifth Host cold-continues without removed
  input or replaying source writes. SQLite retains the canceled model receipt
  as uncertain and the old Run remains unchanged by continuation.
- Actual Claude Code performed read-only initial and final source reviews in
  session `6968300d-2a56-47fd-a260-99b211968675`; final report
  `/tmp/native-active-rewind-claude-final-review.json`. These are review opinions,
  not execution evidence. The initial report read the pre-edit wiring. The final
  report incorrectly explained terminal-kernel cleanup as `safe()` passing while
  Agent status is running; the real code explicitly skips cancel for a terminal
  kernel **and still awaits Host idle**, covered by the final assertion above.

Earned progress is **34/100**, M5 **10/15**, denominator unchanged. This point
covers active model stop, authoritative branch commit and cold continuation.
Full removed-child/background cleanup, combined rewind, complete historical /
retirement / compaction / reconciled read variants, fork/isolated-child read
hydration, neutral runtime handoff, other matrix gaps and the M6 before/reference/
after comparison remain incomplete. No real-model quality, Token savings,
latency parity, browser-click acceptance or cloud execution claim is made.

## Selective local command cleanup across conversation rewind (35/100)

Reference: pinned ZCode `src/runtime/methods/rewind-message.ts:542-572`
waits for removed-branch task cancellation before persisting the cut;
`:628-650` selects running tasks by branch generation and removed turn IDs.
Native preserves its own committed launch receipts, supervisor ownership and
immutable Run ledgers rather than importing a second runtime task registry.

`src/providers/native-conversation-tasks.mjs` proves each command's original
launch receipt and actual Session turn owner. Kept, closed turns retain their
commands even if model history has been pruned; partial turns require an
original accepted launch call/result in the selected history. Removed turns
cannot retain authority merely because a task ID appears in user text.

The Host-only `conversation-command-control.mjs` verifies the exact current
StoredRun, local owner-derived task IDs and launch backend before stopping any
command. It pins physical paths, including the macOS `/var` alias used by the
existing launcher. Removed commands use their existing fsynced cancel file and
bounded supervisor wait. Unknown outcomes, head/input drift, aborts, changed
authority and unsupported backends reject settlement. Retained rows remain
exactly the original rows; source Run receipts and notification flags are not
rewritten. This adds no model-visible cleanup tool or alternate executor.

The installed Host performs cleanup under actual `Agent.runMaintenance` to
exclude ordinary turns and notification admission during asynchronous stops.
Both an in-flight rewind and a durable cut not yet consumed by a new Run fence
background notifications. The persisted Session marker records the confirmed
partition, and the first rebased Run admits only exact already-owned retained
rows. Later ordinary turns inherit those rows. A failed Session flush can retry
the same marker without repeating stops. The cleanup timeout propagates into
the backend operation, preventing a timed-out request from later publishing a
cut. Studio identifies the action as stopping related tasks before rewind.

Acceptance:

- Native build/pack succeeded. Focused controller, retention, admission fence,
  marker, Host, client-state and core rewind checks: **70 passed** in
  `/tmp/native-command-cut-related-final.log`. Three additional Host failure
  cases then passed in the **18-case** Host group
  `/tmp/native-command-cut-host-edges.log` (the groups overlap): maintenance
  ownership/failed-flush retry, unknown stop outcome and backend timeout.
- Actual packed Studio proof: `--mount-host --conversation-rewind
  --conversation-command-rewind --frozen --keep`, log
  `/tmp/native-command-cut-proof-final.log`, evidence root
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-4x1yCw`.
  Two actual Hosts (15612/15641), eight controlled HTTP model calls and two real
  local background processes. Authenticated rewind keeps the first command
  running, confirms the removed command canceled, and retries without another
  cut. A cold Host reads, stops and observes the kept command using its original
  locator. Removed input/output/task ID are absent from model context; original
  source ledgers remain identical. Accepted evidence and
  `conversation-command-rewind-proof.json` are saved in that root.
- Archive: `/tmp/agentkit-native-command-cut-pack-final/kingsoftcloud-agentkit-studio-0.0.2.tgz`,
  SHA-256 `0e509b3e82c77d345bd876f73ee4c9ab0aa7b7e00ef783d93efc0803a9a28496`.
- Actual Claude Code session `1cb6c5e2-40e6-441e-9d6b-d82236dbd1c7`
  implemented the bounded backend and initial real-process tests. Its turn ended
  at the turn limit. Main integration corrected diagnostic supervisor access,
  paused-head test setup, physical-path normalization and full-record/drift
  guards, then ran the final proofs. No Claude task remains live for this batch.

Earned progress is **35/100**, M5 **11/15**, denominator unchanged. This point
covers selective **local command** settlement and retained command continuity.
Full child-task cleanup and historical-selection variants, combined rewind,
remaining read hydration cases, neutral runtime handoff and other matrix gaps
remain incomplete. Other backends remain fail-closed where settlement cannot
be proved. M6 remains **0/15**; controlled-model correctness evidence is not a
real-model quality, Token savings, latency parity or cloud execution benchmark.

## Active owned-child settlement at conversation commit (35/100, stronger evidence)

The same pinned ZCode removed-branch cancellation boundary also applies to
Native-owned child tasks. Actual source tracing confirms that parent cancel
uses the existing `owned-background/v2` lifecycle: `kernel.mts:293` reconciles
the interrupted parent effect; `transitions.mts` enters deferred finalization;
`child-runtime.mts:42` prepares the original owner's cancel/collect operation;
`reduceChildLifecycle` settles reservations before parent terminal state.
The Host rewind gate requires terminal children and settled reservation digests.
No second child cancellation driver was added.

`scripts/verify-studio-native-children.mjs --conversation-rewind` now runs a
separate scenario with `native-child-rewind-proof.mjs`. The actual packed Host
starts one background reader child, while the controlled HTTP model holds both
the child's first request and the parent's next request open. Before rewind,
the real child is `requesting_model` and its reservation is unsettled. The
authenticated rewind cancels both original executors and returns applied.
A **synchronous `session/event` observer at the actual branch marker commit**
reads SQLite and proves that both parent and child were already canceled and
the original child reservation had a settlement digest at that exact boundary.
One lifecycle result settles that child; unknown canceled model usage stays in
its receipt. The child executes no tool. A second Host consumes the new branch,
with empty child ownership/reservations, no removed prompt/task in model context,
and no replay or mutation of either original canceled Run.

Final local acceptance:

- `/tmp/native-child-rewind-proof-final.log`: PASS; evidence root
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-children-sdk-ThLJNZ`.
  Hosts 17589/17601; four controlled model HTTP requests, one child; Node-only
  PATH and unavailable Python. `child-rewind-proof.json` records the actual
  commit observation and both Host identities.
- Pack `/tmp/agentkit-native-child-cut-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz`,
  SHA-256 `1597c8bb9d6f6cba4ce13d71f54b368b5d562976bc48ccbf23510e3f1fbf1367`.
  Contract build/pack, script syntax and diff whitespace checks passed. No full
  suite rerun was needed for the new isolated proof/fixture path.
- Actual Claude Code read-only audit session
  `60488173-cfc9-400c-85d5-a35979c2d5cd` returned source-backed findings in
  `/tmp/native-rewind-child-audit-final.json`. It found no demonstrated bypass
  of the settlement gate and correctly identified the missing real parent-cancel
  proof, now covered above. Its initial run hit the turn limit; the final resumed
  report and both command handles are terminal. Audit opinions are distinct from
  runtime evidence. Receipt-wait/A2A interruption, settlement exceeding the Host
  timeout and other child failure boundaries remain unaccepted.

Progress remains **35/100**, M5 **11/15**. This strengthens the existing active
stop milestone rather than assigning another point for a related test. It does
not complete the entire child/background group, historical selection, combined
rewind or cross-engine handoff. Performance and real-model comparisons remain
pending, with M6 **0/15**.

## Combined workspace/conversation rewind (36/100)

The pinned official `src/runtime/methods/rewind-message.ts:59-69` applies
workspace rewind first and advances the conversation only for an active-chain
result. Its cascade path at lines 88-116 first builds a conversation plan, then
rewinds files and applies that plan. Native now exposes this combined behavior
through authenticated `sessions/native-conversation-workspace-preview` and the
existing rewind operation with `scope: both` and the exact preview token.

Studio shows concrete restore/delete paths and refuses unsafe previews. Preview
does not publish files or a conversation cut; for an active task its explicitly
labeled stop-and-preview action first settles the existing executor. Confirm
applies files before committing the Session replacement marker. New file bytes,
head, input, source record, selection or configuration drift invalidate the
authorization. Source Native Runs remain immutable; original model usage,
including uncertain usage after cancellation, is preserved.

`native-conversation-workspace.mjs` selects the earliest removed mutation using
original turn ownership, retained history and committed writer receipts. Missing
legacy journals, unknown effects, foreign ownership and missing source records
fail closed. A recovered original `tool_receipt` observation is also examined:
losing the direct result must not silently turn a successful file mutation into
a files-preserved combined cut. Closed retained turns do not depend on pruned
model messages remaining available.

The implementation adds an explicit Host administrative intent/result in the
existing private checkpoint journal. It reuses the publisher, physical-root
guards, workspace mutation lock, preimages and compensation; it does not forge
a Native tool claim or introduce another executor. `Agent.runMaintenance`
reserves the actual Agent during the operation. Pending administrative controls
fence new ordinary Native turns and background admission; Studio recovers the
exact original request for verification or compensation after reopening.

The checkpoint SQLite and Session log are **not one atomic transaction**. A
durably completed file operation can be observed again before committing its
missing Session marker, without rewriting files. Prepared/compensating controls
instead restore their known original state and reject reexecution under that
command ID. External changes to unknown partial states remain conflicts.
Already completed control retries preserve subsequent user edits. Preview
budgets bound files and aggregate current/desired bytes before publication.

Nested undo is itself a file publication. The rewind suffix now includes an
already-undone original when that original's inverse is also in the suffix;
otherwise an earlier rewind could resurrect removed files. Compensation
restores the exact prior undone status/owner, rather than marking every original
completed. These fixes also cover ordinary file rewind.

Local evidence:

- `/tmp/native-combined-final-tests.log`: **87 passed**, focused workspace,
  Host, client-state, branch-marker and background-fence tests. This includes
  failed marker flush/retry, no marker after failed files, stale preview,
  nested undo, cold compensation and an actual SIGKILL immediately after a
  file publication. The cold workspace controller compensates that killed
  operation without changing the original Native Run.
- After strengthening recovered-writer selection,
  `/tmp/native-combined-selection-final.log`: **4 passed**. These overlap the
  earlier group; their count is not additional milestone credit.
- Latest archive `/tmp/agentkit-native-combined-cut-pack-final/kingsoftcloud-agentkit-studio-0.0.2.tgz`,
  SHA-256 `74b513d624eb5047d9542138eaede5d054e2e4264954847968416d90739f4244`.
  `/tmp/native-combined-proof-final.log`: PASS using
  `--mount-host --conversation-rewind --conversation-workspace-rewind
  --conversation-active-rewind --frozen --keep`.
  Evidence root
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-NYepDU`;
  `conversation-workspace-rewind-proof.json` records seven controlled HTTP model
  calls and `activeStop: true`. Three real Host instances cover an active model
  stop, read-only preview, external-edit refusal, exact same-ID retry, immutable
  source ledgers, cold retained read and an earlier root cut with no file
  resurrection. The earlier idle variant passed separately in
  `/tmp/native-combined-proof.log`.
- Build/pack and whitespace checks passed. A related route/client group had
  **177 passed and two legacy `resources/list` failures**. Running those two
  cases against an isolated unchanged `c61dee2` checkout reproduced both
  `INVALID_RESOURCE_SOURCE` failures in
  `/tmp/native-combined-baseline-route-failures.log`. No unrelated resource
  behavior was changed; no repository-wide suite was run for each edit.
- Actual Claude Code read-only session
  `70102327-e5d6-4735-afd9-a545aeb5f110` completed its source-ordering audit.
  Session `cd478b05-3922-4add-80a2-fc2e430d9ad0` wrote the bounded selector and
  initial tests before reaching its turn limit. Main integration reviewed and
  strengthened missing-checkpoint and recovered-receipt handling. Both tasks
  are terminal. The audit suggestion to invoke a raw terminal tool request was
  not adopted; the Host uses its own explicit administrative authority.

This earns one M5 behavior item: **36/100**, M5 **12/15**, denominator unchanged.
The restored files are recorded Native workspace mutations, not arbitrary shell,
MCP, database or child-workspace side effects. A whole-Host crash with queued
input at the cross-store commit boundary is not yet accepted by the workspace
port SIGKILL proof alone. Historical/retired selection variants, remaining read
hydration and child settlement boundaries, neutral runtime handoff and other
matrix gaps remain. No new dependency or model round trip was added for preview
or file restoration; local hashing, SQLite and file I/O costs are unbenchmarked.
M6 remains **0/15**: real-model quality, Token/latency comparison and the final
requirement audit have not been completed.

## Versioned creation through Edit (37/100)

Official pinned `src/tool/handlers/edit.ts:125-141` creates a missing file when
`old_string` is empty. Lines 168-193 permit replacing existing whitespace-only
content after a valid read; `writeEditResult` preserves revision/encoding/newline
information and updates full read authority. The actual reference
`tests/edit-tool-contract.test.ts:110-137` covers missing-file creation and
filling an already-read empty file. Native previously rejected every empty
`old_text` request, even when its ordinary Write path could create the file.

New Studio Native admissions now bind `workspaceEditPolicy: zcode-match/v2`.
Its single-file Edit creates a missing file using the existing race-safe
create-only publisher, records an absent preimage, publishes a normal committed
tool result and establishes the same full read observation used by subsequent
edits and cold continuation. Existing whitespace-only files require a full,
fresh read; nonblank content is never overwritten by empty-old-text Edit.
No-change input and incompatible replacement counts reject before publication.
Missing-file creation normalizes CRLF input to LF, as ZCode's real filesystem
adapter does; existing-file replacement uses dominant CRLF/LF, with LF on ties.
The nonblank refusal also precedes read-state validation as in the reference.

The execution path retains ordinary Host permission checks, cancellation,
physical-root/path checks, mutation exclusion, checkpoint intent/result and
post-publication unknown-effect handling. A creator that appears after absence
was observed cannot be overwritten: both a locked recheck and the final
create-only hard-link publication protect that boundary. Multi-edit retains its
nonempty-match rule; ZCode's single Edit creation does not imply inventing new
multi-edit semantics.

The policy is explicit in the core tool contract and configuration validator.
Original v1 and legacy-absence Runs retain their admitted behavior. Host recovery
rebinds the original policy version instead of mapping every stored policy to
v1 or upgrading old Runs. Only v2 tool descriptions advertise the new behavior.
This reuses the current loop and workspace publisher; no dependency, alternate
executor or extra model step is added for creation. Normal nonempty matching
continues to use the existing bounded worker. Local I/O costs are unbenchmarked.

Acceptance:

- `/tmp/native-edit-create-tests-final.log`: **23 passed**, focused existing
  matchers and new empty-old-text behavior, newline handling, stale/partial
  reads, nonblank refusal, incompatible count, denial, abort, path escape and
  two external-creation windows. The existing v1 SQLite approval/cold-reopen
  scenario still commits its original matcher once.
- `/tmp/native-edit-create-integration-tests.log`: **186 passed**, related
  workspace rewind, real Native gateway and Studio Host groups. The added
  SQLite/kernel case proves a committed v2 creation has an absent preimage,
  survives cold reopen, and can be removed by ordinary ledger-authorized file
  rewind without changing its source Run. No full repository suite was run.
  After the final newline/error-ordering adjustment, the 23-case edit group
  passed again, as did that targeted creation/preimage case in
  `/tmp/native-edit-create-preimage-final.log`; the 186-case group was not
  repeated for those isolated empty-old-text changes.
- Final archive
  `/tmp/agentkit-native-edit-create-pack-final/kingsoftcloud-agentkit-studio-0.0.2.tgz`,
  SHA-256 `4edf22c1d776f2139afc531c9eb50a93d1dda2d985453f633e6453a95872bc8c`.
  Build/pack, syntax and whitespace checks passed.
- `/tmp/native-edit-create-proof-final.log`: PASS with
  `--mount-host --edit-create --frozen --keep`; evidence root
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-y3rwfQ`.
  `edit-creation-proof.json` records eight controlled HTTP model requests and
  the original creation checkpoint. Two actual Host instances prove admitted
  v2 creation in a Frozen Build, CRLF-input-to-LF normalization, immediate next edit without another
  read, nonblank refusal, actual outer Host policy denial and cold editing.
  The prior Run remains identical after the second Host executes.

Real Claude Code read-only audit session
`4dd1fe62-90ee-4780-aeb4-6a696f32ee30` completed its separate source/authority
audit in `/tmp/native-edit-create-audit.json` (terminal success). Main review
confirmed its newline findings against the real
`../adapters/src/fs/index.ts:291-295` and `fs/text-metadata.ts:213-242`, then
aligned creation, mixed-EOL majority/tie behavior and nonblank error precedence.
The report's admission warning used an older read of the file: current Host
admission and the packed proof already bind new v2 and recover the original
stored version. Its suggestion to reject whitespace-only nonempty match text
was not adopted: a nonempty whitespace snippet remains a valid exact edit.
The audit did not read reference tests; main review read the contract cases
cited above. No Claude task remains live for this batch.

Earned progress: **37/100**, M3 **6/20**, unchanged denominator. Native retains
the existing bounded UTF-8 file path (2 MiB source reads); ZCode's much larger
and legacy-encoding paths remain an explicit unaccepted difference. Full
read/write policy comparison, other matrix gaps and M6 comparisons remain.

## Earlier default local cleanup through Studio (38/100)

Pinned official `src/compact/microcompact.ts:77-81` derives a token boundary as
`max(0, min(floor(fullCompactThreshold * 0.9), fullCompactThreshold - 2000))`.
The actual runtime `src/runtime/methods/microcompact.ts` resolves that default
only inside its explicitly enabled local microcompact configuration. Despite
its name, `positiveInt` accepts zero, which immediately triggers token cleanup.
Native's
previous optional pruning path defaulted to its full-summary boundary whenever
the operator omitted `pruneThresholdTokens`.

New Studio admissions with explicitly enabled `pruneToolResults` and no explicit
threshold now pin `contextPolicy.pruneThresholdPolicy: zcode-local/v1`. The core
derives the reference earlier boundary from the admitted Native full-summary
budget. This preserves Native's existing complete wire-request counter and
reserved output budget rather than replacing them with a reference estimate.
An explicit positive `pruneThresholdTokens` still wins. Small derived zero
boundaries immediately trigger eligible cleanup. Omitted/disabled pruning does not become
enabled. Original legacy Runs retain their previous absent policy and timing;
recovered new Runs and child model bindings retain the admitted selection.

The implementation reuses the current deterministic projection, protected
working sets, recent batches, trustworthy-success filtering, media/planning
protection and minimum-savings check. It adds no model, dependency or alternate
context loop. The original transcript and receipts remain intact; the normal
context effect journals the admitted pruned request and token-count fact.
One existing post-projection counter call verifies savings; no model summary is
needed when that request is already below the full-summary boundary. CPU and
wall-clock overhead have not been benchmarked.

Acceptance:

- `/tmp/native-pruning-default-tests.log`: **7 passed**, including default
  formula and zero edge, actual planner early-boundary behavior, explicit
  override, disabled/legacy binding, unchanged original messages and existing
  SQLite sealed-view recovery. `/tmp/native-pruning-default-related.log`:
  **33 passed**, related planning and actual HTTP/context-counter integration.
  Build/pack, syntax and whitespace checks pass; no full repository suite.
- Actual packed Studio command:
  `--mount-host --context-pruning --frozen --keep`, log
  `/tmp/native-pruning-default-proof-final.log`, evidence root
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-7dQOL8`.
  `context-pruning-proof.json` records **3 real local foreground commands**,
  five controlled HTTP task requests across two Host instances and the first
  cleared request at step 4. The normal Node counter measured **8195 -> 4728**
  input tokens (3467 fewer estimated tokens in that request), before the full
  threshold **8455.68**. Old results 1 and 2 were cleared, recent result 3 was
  retained. There was no summary call or compaction. Cold ordinary continuation
  executes no command and leaves the original source Run identical.
- Archive `/tmp/agentkit-native-pruning-default-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz`,
  SHA-256 `dd6343ae0397fbbd8383aa49f5b38149fc124541c94a7841b5bb3a236658eae3`.
  Counts above are Native wire estimates with a controlled peer reporting fixed
  usage, not actual provider billing, successful-task cost or quality evidence.

The first larger-output fixture, evidence root
`/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-ATcp7X`,
also confirmed a separate existing gap: after two ~20 KiB results, projected
cleanup was still above the full-summary boundary, so the current planner
discarded it and entered summary using original history. That fixture's peer
deliberately rejects summaries, ending in `context_summary_retry_exhausted`.
The final smaller-batch task isolates the earlier-default behavior; it does
**not** establish that cleanup is applied before a still-required summary.
Idle-triggered cleanup, result-count/batch-recency comparison and that summary
integration remain unaccepted, alongside other matrix items. M6 remains 0/15.

Real Claude Code read-only audit session
`6a59b2f4-e25e-4ef7-9afd-4c4949bb5cce` completed its formula, gating and
recovery-selection review in `/tmp/native-pruning-default-audit.json` (terminal
success). It correctly found that reference `positiveInt(0)` is zero rather
than undefined; main review checked lines 288-291 and the token trigger at
195-197, fixed the initial zero suppression, and added the real planner edge
case. Its claim that explicit negative Native inputs merely disable cleanup
was not adopted: existing configuration validation rejects those values.
Its numeric-recency-default comparison does not prove semantic parity: Native
keeps batches and ZCode counts results, a difference still open above. No Claude
task remains live for this batch. Exact reference model-context-budget strategy
matching remains unaccepted; this implementation explicitly retains Native's
admitted input/output budget and counts the whole wire request.

Earned progress: **38/100**, M2 **7/15**, denominator unchanged. This point is
the default reference timing/admission and its actual Studio evidence; it does
not certify full context/microcompact alignment or task-level savings.

## Cleaned-source summary integration (39/100)

Source audit confirms `runtime/methods/turn-loop.ts:83-108` calls microcompact
before auto-compact in the same model step. `microcompact.ts:74-80` updates both
history and turn entries; `compact.ts:201-209,277` and
`compact-active.ts:192-211` select summary input from those cleaned entries.
The reference minimum-savings check does not require post-cleanup input to fall
below the full-summary threshold.

New Studio Runs with explicit `pruneToolResults: true` now admit
`pruneSummaryPolicy: zcode-local/v1`, independently of explicit/default cleanup
threshold selection. Recovery and child binding preserve the original policy's
presence or absence. Direct bindings and previously admitted Runs retain their
existing behavior. No additional dependency or execution loop is introduced.

When worthwhile cleanup still leaves too much input, the same planner uses the
cleaned view for retention and summary selection. Cleared groups enter the
summary together with their call frames, so retained groups cannot later hydrate
cleared text from the original transcript. Persisted `prunedToolResultRefs`
reconstruct eligible successful-result placeholders during source validation and
fragment/media offset calculation. Prefix/ref/payload digests still authenticate
original immutable messages. Unknown/duplicate/ineligible refs, changed receipts,
partial cleared groups or a mismatching source manifest are rejected. PreCompact
subjects explicitly identify the cleaned projection; original receipts remain
available for execution recovery and ordinary conversation history.

Local acceptance:

- `/tmp/native-pruning-summary-tests.log`: 10 passed, including still-over-window
  cleaned sources, legacy unchanged sources, invalid manifests and two SQLite
  reopen boundaries (before summary execution and after a committed summary
  receipt). Commands and completed summary fragments execute once. Additional
  original-ref/payload assertions pass in
  `/tmp/native-pruning-summary-manifest.log` (one selected test).
- `/tmp/native-pruning-summary-related.log`: 32 passed (context planning and
  actual request/token counters). `/tmp/native-pruning-summary-hooks.log`:
  35 passed (hooks and context contributions). Build/pack and whitespace checks
  pass; no full repository suite ran.
- Actual packed Frozen Studio Host:
  `node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-pruning-summary-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --mount-host --context-pruning-summary --frozen --keep`.
  `/tmp/native-pruning-summary-proof-final.log` passes; root
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-C0jcqk`.
  Two real foreground Node commands produce 600/900 evidence lines. The ordinary
  whole-request counter measures **19395 -> 12740** input tokens after cleanup,
  still above the 12000-token context window, and the summary sources contain
  placeholders instead of old result lines. Original call arguments are retained.
  Both the first turn and cold follow-up complete; no command is repeated and
  the original Run remains identical. Across both turns the controlled peer
  observes 10 HTTP model requests, including **6 summary fragments**. The cold
  follow-up starts a new Run and may summarize imported history again; this proof
  does not claim reuse of the previous Run's summary or zero extra model cost.
- The separate `--context-pruning --frozen` scenario also passes:
  `/tmp/native-pruning-summary-early-proof.log`, root
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-Nz2lfB`:
  three commands, five task requests across cold continuation, zero summaries.
- Runtime archive SHA-256:
  `380d47602c63c242129dfd78c7da3c79bded1061af129eaed4bfde9c642c4f2f`.
  These are deterministic local wire estimates with controlled model responses,
  not task-quality, billed-token, latency or successful-task cost comparisons.

The first 600/600-line fixture showed an intentional existing Native difference:
cleanup produced 9459 input tokens, above the 8455.68 trigger but below the hard
window, so fresh complete tool results were admitted before summary. The final
600/900 fixture crosses the hard window and verifies the required summary path.
A subsequent assertion incorrectly matched the old marker inside original
command arguments; the verifier now checks concrete old result lines instead.
Neither issue was fixed by weakening the actual over-window summary requirement.

Real Claude Code read-only audit session
`a0ed47eb-a12a-45f5-8095-54e8b0c87682` completed successfully in
`/tmp/native-pruning-summary-source-audit.json`. Its source call-chain and
original-transcript/summary-binding findings were checked against the official
source and this worktree; its reading of tests alone was not treated as execution
proof. It ran no tests and modified no files. No audit process remains live.

Earned progress: **39/100**, M2 **8/15**, unchanged denominator. This point covers
cleaned-source summary integration and its recovery/Host evidence. Idle-triggered
cleanup, result-count versus batch recency, complete context/protocol/interaction
alignment and M6's before/reference/after task/performance comparison remain open.

## Idle-triggered local cleanup (40/100)

The pinned ZCode source uses a strict elapsed comparison, not a timer job:
`compact/microcompact.ts:15,177-200` defaults to 60 minutes and triggers when
`now - lastAssistantCompletedAtMs > minutes * 60000`. Zero is valid. Idle takes
precedence over token pressure. `runtime/methods/turn-model-step.ts:695` updates
the last completion after a main model response, and `resume.ts:187-195` restores
the latest assistant completion from active history.

New Studio bindings with explicit `pruneToolResults: true` now admit
`pruneIdleThresholdMinutes: 60`; explicit nonnegative integer values, including
zero, win. Restored configurations preserve original absence/value. Pruning is
still opt-in, and disabled compaction/pruning does not become enabled. Each child
model binding receives the same admission selection while using its own model.

Successful admitted task assistant messages carry Kernel-owned `completedAtMs`.
Imported ordinary/fork history keeps that metadata; historical final-message
projection carries an available original completion rather than inventing a new
one. Provider errors, summary responses and old Runs do not acquire a fabricated
completion clock. The planner uses only the latest assistant frame and one clock
observation captured for the journaled context effect. An unknown/latest missing
clock or a clock in the future cannot trigger idle cleanup. Strict equality at
60 minutes does not trigger it. No scheduler, background poll or extra model call
is added. Completion metadata is validated as assistant-only and remains separate
from provider protocol fields and execution/permission authority.

The existing cleanup eligibility, complete protocol groups, protected working
sets, minimum savings, context counting and cleaned-summary binding remain in
force. New cleanup facts distinguish `idle` from `token_pressure` and record the
observed elapsed interval. Old policies retain their prior absent trigger fields.

Acceptance:

- `/tmp/native-pruning-idle-tests.log`: 5 passed: strict/default/zero boundary,
  missing/future/backward clocks, below-pressure planner admission, disabled and
  legacy policies, successful-response stamping, and SQLite reopen followed by
  an ordinary same-Session follow-up Run with inherited completion time. The test
  clock advances only after a settled tool receipt, under an explicitly long
  test lease; it does not discard tool completion by jumping across its deadline.
- `/tmp/native-pruning-idle-related.log`: 31 passed (microcompact, history and
  context view). `/tmp/native-pruning-idle-conversation.log`: 16 passed (conversation
  seed/cut/rewind and actual model HTTP integration). Build/pack and whitespace
  checks pass. No full repository suite ran.
- Actual Frozen packed Studio:
  `node scripts/verify-studio-native-harness.mjs --source .artifacts/dsh-native-zcode --archive /tmp/agentkit-native-pruning-idle-pack/kingsoftcloud-agentkit-studio-0.0.2.tgz --mount-host --context-pruning-idle --frozen --keep`.
  `/tmp/native-pruning-idle-proof-final.log` passes; root
  `/var/folders/rq/sljhp4n11lz8y3y4dvc9xhbh0000gn/T/studio-native-host-14BIeV`.
  This uses explicit zero minutes and a 100000-token pressure threshold to
  exercise real idle admission without waiting an hour. Two real Node commands,
  four controlled model requests across two Host instances, zero summaries and
  no command replay. Initial idle fact: **944 ms**, estimated request **6270 ->
  4537** tokens; cold ordinary follow-up: **2881 ms**, **6300 -> 4567**, with
  inherited completion clocks and the original zero-minute policy. Original Run
  remains unchanged. First-turn wire requests contain no `completedAtMs` fields.
  The default 60-minute boundary is established by controlled-clock core tests,
  not by claiming this short Host test waited an hour.
- Runtime archive SHA-256:
  `fb57096fa505f466e8092a0c5f1c66e2f225f5b9cd08ca2654a1f6241fab890b`.
  Token figures are normal Native wire estimates, not provider billing or
  successful-task performance/quality comparisons.

Source-review follow-up for the next conversation/display batch:

Real Claude Code read-only session `e9fcad46-bbdb-4616-8d99-ba3982e23a93`
reached its bounded 25-turn inspection limit, then completed the same session's
report in `/tmp/native-conversation-reasoning-audit-final.json`. No files were
changed and no tests were run by that audit. No audit process remains live.
Its Native thinking -> `assistant-stream.mjs` -> Session stream trace is useful,
but its claim that Studio has no live reasoning consumer is **not accepted**:
it inspected the cloud-only Assistant view and did not inspect the local DSH
Session consumer. Main review verified maintained
`packages/api/session-controller/src/history.ts:54-61` accumulates
`agent/assistant-stream`; `client/sessions/session.ts:653-677` consumes frames
and durable entries, and the conversation contract supports reasoning blocks.
The cloud adapter deliberately strips streams and its renderer filters reasoning;
those observations do not establish the local main-view behavior.

The directly verified local admission gap to audit next is
`src/host/services/native-harness.mjs:426-438`: `providerThinkingDisplay` defaults
to false, independently of private replay. Source ZCode
`runtime/methods/model.ts:278-330` handles reasoning start/delta/end as streaming
Session events. Full local rendered acceptance, display configuration, persisted
stream settlement, cancellation/reconnect and protocol-specific reasoning remain
pending. Cloud Assistant features are not substituted for this local task.

Earned progress: **40/100**, M2 **9/15**, unchanged denominator. This point covers
idle cleanup admission, completion-clock persistence and the actual Studio path.
It does not certify full context alignment or the conversation display group;
result versus batch recency, the remaining capability matrix and M6 are open.
