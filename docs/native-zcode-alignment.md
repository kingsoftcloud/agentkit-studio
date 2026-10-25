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

Current earned progress: **8/100**: M1 4/15 (inputs, initial matrix and reviewed
source findings), M2 2/15 (explicit earlier cleanup and admitted Anthropic cache
projection), M3 2/20 (successful context-window truncation and durable cache usage accounting). M4–M6 have no earned
points yet. This does not imply any whole capability group is complete.

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
| Tool discovery / Skills / MCP | `src/tool/search/{exposure,history,search}.ts`, `tests/tool-search-*.test.ts` | Node `skill-disclosure.mjs`, Host `native-dsh-tools.mjs`, MCP schema adapter | Skills already have progressive disclosure. Audit general deferred tool discovery and compaction continuity. Pending. |
| File search/read/edit and undo | `src/tool/handlers/`, `patch-{parser,apply}.ts`, `edit-matchers.ts` | Node `workspace-{tools,editing}.mjs`, Host source/directory projections and mutation lock | Audit actual registration, edit preconditions, result bounds and reversible changes; do not substitute broad Git reset for undo. Pending. |
| Tool validation / execution | `src/tool/{executor,scheduler,input-normalization,model-contract}.ts` | core `tool-input.mts`, `machine.mts`, Host tool authority and DSH pipeline | Native has ledger-bound tools and read-only concurrency. Compare coercion, rejection feedback, ordering and resource conflicts. Pending. |
| Plan / Todo | `src/tool/handlers/{todo,plan-mode-prompts}.ts`, `src/runtime/methods/turn-loop.ts` | Host builtin registry and Native `contextRole: task_planning` | Presence in DSH Native does not establish AgentKit Native exposure. Trace registration, persistence, plan mode restrictions and reminders. Pending. |
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
  and actual Native admission still need integration evidence. Nested refresh
  needs special attention: the DSH loader watches `read/write/edit` with
  `file_path`, whereas Native tools use different names/argument shapes.
- Generic externally bound tools can pass through Native's gateway. Plan/Todo
  are not categorically impossible, but their explicit roles, lifecycle, result
  semantics and default exposure are not yet aligned. Changes to the assembled
  prompt/tool series currently require an explicit Native rebind; Plan mode
  cannot silently change that frozen contract.

Implementation sequence after this initial batch:

1. Verify baseline and nested project instruction admission in the actual
   maintained Host; integrate missing scope refresh without a duplicate loader.
2. Integrate durable Todo/Plan behavior, mode restrictions, reminders and user
   decisions with the actual Session/UI and Native receipts.
3. Implement general deferred-tool discovery and compaction continuity while
   keeping the complete admitted tool bundle immutable.
4. Complete editing/undo, control/background/children and recovery comparisons;
   preserve stronger Native side-effect/ownership boundaries as explicit
   differences, not as excuses to omit user-facing capability.
5. Run fixed local reference/baseline/after tasks and close the full audit.

## Initial integrated changes and evidence

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
