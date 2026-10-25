# Native / ZCode coding Harness alignment

Status: in progress. This is a new source-alignment task, not a reopening or a
replacement of the earlier Python-to-TypeScript migration acceptance.

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

Current earned progress: **18/100**: M1 4/15 (inputs, initial matrix and reviewed
source findings), M2 6/15 (explicit earlier cleanup, admitted Anthropic cache
projection, actual Host baseline/nested instruction refresh, and integrated local
deferred-tool discovery with durable cleanup/Session continuity), M3 2/20
(successful context-window truncation and durable cache usage accounting), M4 6/20
(durable session Todo controls, compaction continuity and actual Studio projection
across cold Host turns, plus receipt-backed Plan transitions, tool restrictions and
actual Studio plan review, frozen non-destructive MCP Plan access and dynamic
local POSIX command Plan permission through the actual Host execution path).
M5–M6 have no earned points yet. The denominator is unchanged; session/child Plan
exceptions and the remaining M4 controls are not
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
| Context / microcompact | `src/compact/microcompact.ts`, `src/runtime/methods/{microcompact,turn-loop}.ts`, `tests/microcompact.test.ts` | core `context-{planning,microcompact,view}.mts`, source working set, Node context counter | Both have old-output projection; reference runtime explicitly enables microcompact only when configured. Explicit `pruneThresholdTokens` now enables earlier cleanup, preserving legacy absence. Default derivation, idle trigger and cleanup that still requires summary remain pending. |
| Tool discovery / Skills / MCP | `src/tool/search/{exposure,history,search}.ts`, `src/tool/deferred-call.ts`, `tests/tool-search-*.test.ts` | core `tool-{discovery,search-ranking}.mts`, Node wire projections and `skill-disclosure.mjs`, Host `native-dsh-tools.mjs` / `native-subagents.mjs` | Local search/wrapper path now enters actual packed Host, real MCP, child authority, SQLite and cleanup. Skills retain existing progressive disclosure. Native Anthropic tool-reference optimization, complete deferred-selection comparison and task-cost benchmarking remain pending. |
| File search/read/edit and undo | `src/tool/handlers/`, `patch-{parser,apply}.ts`, `edit-matchers.ts` | Node `workspace-{tools,editing}.mjs`, Host source/directory projections and mutation lock | Audit actual registration, edit preconditions, result bounds and reversible changes; do not substitute broad Git reset for undo. Pending. |
| Tool validation / execution | `src/tool/{executor,scheduler,input-normalization,model-contract}.ts` | core `tool-input.mts`, `machine.mts`, Host tool authority and DSH pipeline | Native has ledger-bound tools and read-only concurrency. Compare coercion, rejection feedback, ordering and resource conflicts. Pending. |
| Plan / Todo | `src/tool/handlers/{todo,plan-mode,plan-mode-prompts}.ts`, `../contracts/src/tools/{todo,plan-mode}.ts`, `src/permission/{service,plan-mode-policy}.ts`, `src/runtime/helpers/{runtime-reminders,plan-file-continuity}.ts`, `src/runtime/methods/turn-loop.ts` | core `todos.mts`, `plan-mode.mts`, `kernel.mts`, Node `session-delivery.mjs`, Host Native composition/interaction | Todo/Plan controls, Studio projections, detailed review, cold-turn continuity, MCP and local POSIX command exceptions are integrated. Session-control exceptions, child planning and full reminder/control comparisons remain pending. |
| Steering / cancellation | `src/runtime/methods/{turn-guide-drain,runtime-command-active-loop}.ts`, `tests/runtime-command-queue.test.ts` | core `guidance.mts`, `kernel.mts`, Host interaction bridge | Compare interruption timing, queued input ownership, priority and restored commands. Pending. |
| Background / children | subagent handlers, `src/runtime/methods/turn-loop.ts`, background tests | core child/background modules, Node owned child/command, Host watcher | Native implementations exist. Audit completed-batch delivery, budgets, cancellation, workspaces and restart behavior. Pending. |
| Retry / permissions | `src/runtime/methods/streaming-recovery.ts`, tool executor/permission policy | core `retry.mts`, tool error recovery, Host DSH permission pipeline | Preserve bounded retries and no blind replay of unknown effects; compare denied-call feedback and retry termination. Pending. |
| Recovery / runtime boundaries | runtime persistence and session fork implementation | core store/recovery, Node SQLite, `src/runtime-contract.mjs`, Host recovery | Keep engine/build pin, single effective executor, private checkpoint boundaries. Audit neutral handoff and execution placement separately; no cloud scheduler in this phase. Pending. |
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
Idle-triggered/default-reference threshold alignment remains open.

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

## Local evidence and comparison protocol

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
