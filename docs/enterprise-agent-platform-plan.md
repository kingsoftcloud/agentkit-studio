# Enterprise Agent Studio implementation and local acceptance

Status: active, 2026-10-26. This is the current thread objective. The earlier
Python-to-TypeScript migration and ZCode coding-alignment evidence remain useful
inputs; neither establishes completion of this broader platform objective.

## Objective and boundaries

Finish the existing TypeScript Studio as an enterprise Agent workbench for
creation, configuration, debugging, running and management. Native is the
default general, embeddable execution engine for both business and coding
Agents. Preserve DSH and Codex as separate Harness adapters with explicit
capability differences. Harness selection and local/cloud execution environment
selection are different axes; in-flight state is not presumed portable.

Use AgentCore / Volcano AgentKit for platform lifecycle and resource boundaries,
pi for engine/module composition, ZCode for required tool/I/O behavior and
governance, and OpenCode for API/events/multiple-client separation. These are
design references, not instructions to transplant a framework or expand the
tool inventory. Verify source behavior and preserve applicable licenses.

This phase is local only, TypeScript/Node, no Python, no new cloud scheduler.
Preserve existing reliability and future endpoint/cloud seams. Continue automatic
memory, context management, bounded retries, background/children and task
interaction. Optional activation changes policy and cost, never mandatory
permission, audit or resource enforcement.

## Responsibility audit: authoritative source locations

| Layer | Existing owners | Responsibility and current finding |
| --- | --- | --- |
| Core mechanisms | `packages/agentkit-harness-core/src/{contracts,machine,kernel,configuration}.mts`, store/intents/receipts/leases | Model/tool protocol, state transitions, execution budgets, cancellation, ordering, durable ownership and unknown-effect reconciliation. Preserve one execution authority. |
| Capability policy | Core `todos.mts`, `plan-mode.mts`, browser/coordinator modules; `src/providers/native-memory*.mjs`, `native-subagents.mjs` | Separate business policy, prompts, enablement and tool selection from mandatory transitions. Some capabilities currently participate directly in kernel branches; extract incrementally only where ownership/atomic state remain clear. Automatic Memory work in progress must not hard-code its business prompt into the general core. |
| Infrastructure adapters | `packages/agentkit-harness/src/native/` model, SQLite, workspace, process and Memory adapters; `src/host/bootstrap.mjs` | Trusted Host composes credentials/resources and owns lifetimes. Modules use existing ports, shared governance and durable receipts, not independent loops or unguarded I/O. |
| Product interaction | `src/client/`, `src/remote/`, `src/host/routes/`, `src/agent-store.mjs`, `src/studio-build.mjs` | Agent revisions/Builds/resources, configuration and task UI. DSH owns product Session transport/history/projections; Native owns execution ledger. API adapters must retain revision, binding, cancellation and error authority end to end. |
| Runtime boundaries | `src/runtime-contract.mjs`, `src/providers/{dsh-runtime,codex-runtime}.mjs`, `src/build-engine.mjs` | Runtime types are `harness` (Studio Native), `dsh-native` (DSH engine), `codex`. Freeze Agent/revision/Build/Session/Run identity; do not equate different engine capabilities. |
| Headless transport | `src/host/routes/http.mjs`, `dispatcher.mjs`, contracts, client remotes | HTTP admission is `connection.admit` before body/dispatch. Dispatcher validates operations and composes request/Host cancellation. Sessions and other clients reuse Host services; no browser-owned credentials or execution state. |

### Confirmed defects and coupling to address

1. **Fixed in `a1520e3`: local edit lost expected revision.** The UI supplied its
   loaded revision, but local client methods and the Host route dropped it.
   Old windows could replace later edits/resources despite storage-level CAS.
   Both first-party mutation paths now forward `expectedRevision`; Host passes a
   synchronous live cancellation guard into the storage publication lock.
   Legacy callers omitting a revision retain their existing semantics; this is
   not a claim that every external caller now requires CAS.
2. **Memory policy separated from general execution.** Memory extraction
   prompts, allowed tool names and default limits now live in Node's
   `memory-extraction-run.mjs` capability module. The TypeScript
   `auxiliary-run.mts` only invokes NativeKernel with the admitted configuration
   and exact-call/receipt guards. Host scheduling, independent resource lifetime,
   persisted jobs/cursors and scoped usage are now implemented and have focused
   production-Host evidence. Mounted-product usage/status, source lineage and
   selected process-crash boundaries now have evidence; actual-model quality and
   broader fault acceptance remain.
3. **Route-driven local vertical evidence now passes.** Existing mounted Host proofs
   already authenticate HTTP and call `agents/local-get` and
   `agents/ensure-preset`. Their initial record is created directly through the
   store. The new verifier creates/edits/builds/admits both Agents through real
   authenticated HTTP routes, executes real MCP/workspace effects and cold
   continuation through SDK/controller. Model output is controlled fixture data;
   real-model task quality and UI acceptance remain separate requirements.
4. **Do not infer missing UI features from a single verifier.** Prior thinking,
   reconnect and history evidence exists in the coding-alignment record. Audit
   its actual scope and rerun relevant product paths under the new verticals.
5. **Local/server-client coupling needs investigation, not an assumption.**
   Agent route/dispatcher eagerly await server-client initialization. Prove an
   actual local failure before changing this boundary; absence of cloud
   credentials does not itself prove constructor failure.

6. **Governance follow-up remains partial.** Parent MCP calls receive the same
   current-intent guard as child calls. New Native Revisions now bind a versioned
   strict/loose/custom permission contract through the admitted ToolRegistry,
   Build and cold recovery; one packed Host vertical proved four exact approvals
   under permissive Sessions. Packed Host negative runs now prove rejected and
   cancelled approvals cannot perform a workspace write. Historical display-only
   labels remain inert until an explicit save creates a versioned policy. The
   complete extension/resource authority audit remains open. See
   [governance evidence](enterprise-agent-governance-audit.md).

The actual Claude Code read-only audit was reviewed. Its useful finding was
route-driven creation/Build coverage; its incorrect `Native=dsh-native` label,
authentication placement and claims of absent preset HTTP coverage were rejected
against the sources above. Audit output is research input, not acceptance.

## Fixed acceptance denominator

This new denominator replaces the old coding-alignment percentage. It does not
mean existing code was removed or prior reliability evidence became invalid.
Credit below reflects reviewed evidence for this objective, not implementation
line counts or test totals. Do not increment for producing another plan.

| Milestone | Weight | Required evidence | Earned |
| --- | ---: | --- | ---: |
| P1: responsibility and baseline audit | 15 | Four-layer source/ownership map (5); reproduced defects and coupling findings (3); reproducible local baseline (2); complete Native-migration reference/duplication/license inventory (5, earned) | 15 |
| P2: lifecycle, resources and governance | 20 | Client/Host revision and late-cancel safety (3); immutable revision/engine binding regression evidence (2); full create/configure/Build/admission lifecycle (5); trusted extension/resource authority (5, four currently earned); user-facing version/conflict and management behavior (5) | 19 |
| P3: business and coding verticals | 25 | Business Agent effect/result through real product routes and NativeKernel (10); coding Agent effect/result through same engine (10); frozen bindings and cold continuation across both (5) | 25 |
| P4: capability and task interaction | 20 | Automatic Memory module and trusted-source foundation (1), durable job/cursor (2), Host trigger/lifetime (1), usage/status (1); shared retry budget through actual HTTP/cold reopen (1), remaining context/budget integration (4; compaction budget/usage, failed-summary bounds, cancellation and combined Host sources earned 3); background and child lifecycle (5, now earned); approval/cancel/error/public reasoning/history/reconnect product flow (5, now earned) | 19 |
| P5: measurements and final acceptance | 20 | Representative actual-model result/token/latency comparison (6; bounded Native smoke, paired direct-model comparison and paired tool task 4 earned); failure/cancel/recovery/no-blind-replay experiments (6; Memory crash boundaries, frozen background Host SIGKILL, bound-policy approval cancellation, Skill shell lease loss, workspace receipt SIGKILL and remote A2A control SIGKILL all earned); runtime differences/local management and deployment boundary audit (3, earned); final integrated checks, licenses and requirement-by-requirement audit (5) | 13 |

Current assessed progress: **91/100**, approximately 91%. P4's remaining credit
means existing capabilities are not yet re-certified as a group for this objective;
it does not mean Memory/context/children/UI are unimplemented. The earlier
43/100 is a different checklist and cannot be carried over.

No full milestone is certified solely by a related unit test or source filename.
If scope/evidence changes, record it explicitly rather than silently changing
the definition of completion. 100 means every row is achieved with no required
work outstanding.

## Evidence and reproducible commands

The pinned [pi-durable assessment](native-pi-durable-reference.md) prioritizes its
durable-task and public-host-library boundaries without replacing NativeKernel,
removing Native's leases/receipts, or adding cloud deployment to this phase.

### Durable automatic Memory integration

Opt-in `memory.extraction = { enabled: true, minUserCharacters: 64 }` uses the
frozen Agent/Build policy, candidate mode, after-turn flush and shadow/enabled
rollout. Default is off. Short multilingual user windows accumulate without
model calls or cursor advancement. Original explicit-user extraction remains;
the legacy automatic strategy is suppressed when model extraction is active.
Consumed source markers and verified direct-write receipts prevent duplicate
automatic consumption. Auxiliary runs have separate Sessions, identities and
usage; main-turn resources may close while Host-owned extraction continues.

SQLite jobs persist the original prepared configuration, public source window
and Memory manifest before dispatch. Exact duplicates reuse them; queued windows
coalesce. Job leases/fences and current original-source checks gate tools and
the Memory owner's actual commit. A successful/no-op finish atomically advances
the stream cursor; failures/aborts do not. Reopening resumes queued/expired jobs.
The authenticated recovery response includes scoped job usage; Agent form and
task panel expose activation, status and extra model calls/tokens.

Focused integration command (137 passing; no full suite):

```sh
node --test --test-timeout=15000 tests/native-memory-extraction-host.test.mjs tests/native-memory-extraction-store.test.mjs tests/native-memory-extraction-source.test.mjs tests/studio-native-memory-host.test.mjs tests/studio-native-memory-host-guard.test.mjs tests/studio-native-memory-turn.test.mjs tests/studio-native-recovery.test.mjs tests/agent-memory-form.test.mjs packages/agentkit-harness/test/native-memory.test.mjs packages/agentkit-harness/test/native-memory-extraction.test.mjs
```

Production Host completion triggers actual Native auxiliary execution against
SQLite Memory and a controlled streaming model response; the main usage remains
separate. Service tests use actual localhost HTTP, source-ledger NativeKernel,
file SQLite, cold reopen, failed/short/shadow windows, stale head rejection and
frozen-manifest recovery. Job-store tests use two real SQLite handles and expired
owner fencing. Form creation persists the setting and the recovery client
rejects foreign/malformed job usage. Claude Code produced the store draft and
its focused tests; primary reviewed and integrated it. Its first invocation hit
its turn limit; the follow-up completed with 10 passing store tests.

Client bundle and TypeScript contracts pass. After strengthening the owner
commit guard, the affected Host/service tests were rerun separately. Transient
logs: `/tmp/enterprise-agent-memory-final-integration.log`,
`/tmp/enterprise-agent-memory-commit-guard-validation.log`.

P4 earned +3 (durable jobs/cursor 2, production Host trigger/lifetime 1). The
usage/status point was subsequently earned through full mounted-product/UI
acceptance (see below); an isolated component alone was not that evidence. The completed-parent/enqueue
gap and Memory process-kill boundaries now have focused evidence in the
[Memory recovery record](enterprise-agent-memory-recovery.md), earning 1 of
P5's 6 fault-acceptance points. Compaction/rewind cursor lineage is now verified
and the rewind cursor defect fixed; broader failure/cancel/recovery acceptance
remains open.
Controlled model usage is not evidence of real-model quality or token savings.

Baseline commit before new platform fixes: `22a47d8`. Reference ZCode checkout
was revalidated at `3c5b227649371507ddc4eb46ac5133afe6db1cab`. The previous
coding-alignment record contains pinned pi/OpenCode inputs and source findings;
new platform claims still require their own relevant source audit.

The [reference and provenance audit](enterprise-agent-reference-audit.md) now
accounts for each identified retained ZCode source, the original Apache-2.0
KsADK Python ports, DSH MIT maintenance bundles, two separately licensed Node
bundles and local-process redistribution texts. It compared the pinned source
shapes, classified behavior-only references, verified 23 vendored original
hashes, 18 MCP bundle dependency notices and both DSH patch manifests, and
found one NativeKernel shared by product, managed, child and auxiliary paths.
The separate Claude Code license review found the two task-tool attribution
gaps, which were corrected and included in the previously checked archive.
This closes P1's five-point audit inventory for this migration scope. The
final post-change archive and requirement check remain P5 work.

Local initial baseline, completed with **66 passing** assertions (not full suite):

```sh
node --test --test-timeout=20000 tests/agent-store.test.mjs tests/runtime-contract.test.mjs tests/native-build-engine.test.mjs tests/studio-native-memory-host-guard.test.mjs packages/agentkit-harness/test/native-memory.test.mjs packages/agentkit-harness/test/native-memory-tools.test.mjs
```

Coverage inspected: real filesystem immutable revisions, actual separate-process
CAS and lock recovery; runtime identities; real archive/engine pin validation;
Memory ledger/fence/source/call authority, cancellation and parallel/session
isolation. This does not prove new automatic model extraction or full product UI.

Local revision publication fix, **186 passing**, no full suite:

```sh
node --test --test-timeout=10000 tests/local-agent-edit-conflicts.test.mjs tests/agent-store.test.mjs tests/resource-remote.test.mjs tests/host-dispatcher.test.mjs tests/client-compatibility.test.mjs tests/host-route-contracts.test.mjs tests/native-tool-catalog.test.mjs
```

New cases use the actual product client, dispatcher, local route and filesystem
store: two editor views, stale spec/bindings, refresh and successful save,
simultaneous saves, malformed expected revisions and cancellation while a real
SQLite publication lock is held. They failed before the production fix.

Two stale legacy resource-route recordings had accidentally selected `harness`
through the shared fixture payload, invoking the newer merged catalog with an
invalid source. They now explicitly select `dsh-native` for their original
server-only contract; production source validation was not weakened. The merged
Native catalog retains its separate source/binding assertions.

Transient full outputs are in `/tmp/enterprise-agent-platform-initial-baseline.log`
and `/tmp/enterprise-agent-local-edit-validation.log`; commands and inspected
coverage above remain the reproducible record after temporary files disappear.

### Memory module and shared execution foundation

The core's generic auxiliary runner is tested against actual MemoryRunStore and
SQLite NativeKernel execution: independent Session/Run and usage, unchanged
parent ledger, exact call/definition/fence checks, context budget admission,
cancellation and cold lookup of an original effect's owner receipt without
executing it twice. The capability module composes restricted Memory tools and
the existing SQLite Memory owner; model-derived profile/fact/episode records
carry `native-model-memory/v1` provenance, distinct from explicit user profiles.
Manual/locked records retain their existing consent requirement. Shadow mode
never writes. This does not install a second model/tool loop.

Trusted source projection uses the actual Host capsule, configuration digest,
original user ledger messages and kernel history projection. Its message cursor
survives continuation, including the kernel's virtual final-answer source index.
Assistant/system/tool/media/private replay data never becomes a human citation.
Direct writes require both the actual scoped ledger result and the original
Memory owner's matching receipt; unconfirmed attempts fail closed. Tests use
real NativeKernel, MemoryRunStore/SQLite and Memory tools/owner receipts, not
invented intents attached to a product record.

Focused module/recovery/legacy Memory checks: **106 passed**:

```sh
node --test --test-timeout=10000 packages/agentkit-harness-core/test/auxiliary-run.test.mjs packages/agentkit-harness-core/test/memory-extraction-scheduler.test.mjs packages/agentkit-harness-core/test/tool-receipt.test.mjs packages/agentkit-harness/test/native-memory-extraction.test.mjs packages/agentkit-harness/test/native-memory.test.mjs packages/agentkit-harness/test/native-memory-tools.test.mjs
```

Source capture's focused checks: **8 passed** (`node --test --test-timeout=10000
tests/native-memory-extraction-source.test.mjs`). Actual Claude Code's initial
source implementation reached its turn limit and did not establish acceptance;
main review replaced its product-record receipt fabrication and corrected its
history cursor, trusted-source checks and synchronous authority contract before
running these checks. Source and memory policy tests remain controlled-model
mechanism evidence, not an actual-model quality or performance benchmark.

Core TypeScript build, contract TypeScript check and client bundle build passed.
No full test suite was run in this batch.

The prepared identity/configuration, original manifest, cursor, independent
Host resources and automatic trigger are now integrated as described above.
Memory lineage and mounted-product usage now have the follow-up evidence below;
controlled model fixtures do not establish extraction quality or token savings.

### Memory lineage, mounted Studio and context budget follow-up

See [reviewed evidence and reproduction](enterprise-agent-memory-lineage-context.md)
and [mounted browser report](enterprise-agent-memory-ui-evidence.json).
Rewind now reuses successful extraction history only as a set of considered
original message identities, never as resurrected prose. Current branch
generation and the persisted successful cursor owner must agree. Multiple
rewinds do not re-extract earlier no-op sources; retained unprocessed short
windows still accumulate. A real compaction run proves original human sources
and the previous cursor survive even when absent from the model request view;
summary text never becomes citation authority.

The fresh packed production Host and full maintained DSH Web UI create a Native
Agent through the real form, enable model extraction, bind and run a real
Session, inspect separate main/auxiliary usage, and reload both successful and
budget-exhausted outcomes. Actual SQLite retains two main Runs (one model call
each), two auxiliary Runs, the original revision and one version-1 fact. Model
responses/tokens are controlled fixtures. This earns P4's remaining Memory
usage/status point (+1).

Actual Claude Code delivered three independent context/HTTP/SQLite checks;
primary reviewed and strengthened usage/count and cleanup assertions. Together
with the revalidated existing successful compaction/cold-continuation case,
they prove shared compaction model-call budget and separate token events,
bounded malformed summaries, cancellation, original-source retention and no
extra HTTP work after a terminal exhausted-budget reopen. This earns 2 of P4's
4 remaining context/budget points. The actual Host/SQLite combined source check
then earned one more point: a saved user fact and a registered Host source are
read in the same context effect; an oversized optional source item is excluded,
the smaller source item and original user input reach the model, and the
production wire counter keeps input plus reserved output inside the frozen
6,000-token window. Its focused test passes with one model call. Cross-capability
budget acceptance remains unearned. Background/child lifecycle now has the
separate evidence below; broader task interaction remains unearned.

Focused affected files: **47 passed**, plus **1 existing actual-HTTP compaction
and cold-continuation check** passed separately. No full suite was run. The
pre-fix rewind failure was reproduced against HEAD before the production patch.

### Native role authoring, mounted child controls and background cold recovery

See [reviewed lifecycle evidence](enterprise-agent-child-lifecycle.md) and the
[durable report](enterprise-agent-child-lifecycle-evidence.json). Native role
creation/configuration is now available through the real Agent form. The mounted
browser proof reproduced and fixed missing base workspace tools when the optional
legacy catalog is absent. The local catalog now shares actual execution definitions.
The Host's authority, isolated-write checks and child tool allowlist are retained.

Actual Chrome on a fresh packed production Host creates the role, submits real
turns, exercises strict approvals, guides/promotes the original child, reads its
settled result, cancels a second active child before a late write response, and
reloads both histories. SQLite proves original parent/revision/engine binding,
one-time usage settlement, an actual read receipt and no canceled tool intent or
file effect. Actual Claude Code's 25 focused Host cases independently cover
original controls, late A2A answers, authority loss and foreground/background
settlement. These together earn P4's background/child lifecycle 5 points.

A separate real packed-Host/SDK proof SIGKILLs the Host while its background
command runs and starts a new Host. Cold discovery delivers the completion with
no new prompt; the real command starts exactly once. Original frozen Build
instructions survive live edits. This earns 1 further P5 fault point. The
verifier's stale one-tool expectation was updated to the current exact six-tool
Build contract; no production authority was weakened.

Primary's affected form/catalog/Build cases (38) and three named workspace cases
pass, along with contract TypeScript and client build. Claude Code reviewed the
production changes; primary fixed its concurrent-safety authoring finding and
removed repeated catalog-definition allocation. No full suite was run. Controlled
model fixtures do not establish quality, token savings or performance; broader
task interaction, fault coverage and final acceptance remain open.

### Route-driven local business and coding verticals

Verified by `scripts/verify-enterprise-agent-platform.mjs` and the production-Host
instrumentation fixture `tests/fixtures/studio-enterprise-agent-platform.mjs`.
The maintained DSH CLI/SDK loads the packed Studio production modules. A sentinel
DSH adapter throws if the legacy model loop is entered. Agents are created and
edited through authenticated `/agentkit` RPC; Builds are submitted/listed and
observed `succeeded`; presets are admitted through the real route. Session/turn
creation is through the SDK/controller, never a fabricated ledger record.

The business Agent reads a real scratch CRM record and appends one approval via
local MCP. The coding Agent reads a seed and writes a real workspace file.
Editing the business Agent after Build changes both its instruction and MCP
endpoint binding. The immutable Build still calls its original endpoint with
its original instruction. SQLite records confirm the same `agentkit.native/v1`
engine, distinct Agent/Session/Run identities and frozen revision/Build bindings.
Live admissions pin a `revision-<digest>` identity; they do not have a published
Build ID in their Host capsule.

After closing/reopening the actual Host, both histories continue with original
parent Run references. Tool admission count remains five (two business, two
coding, one frozen-resource read), and the single CRM mutation is not repeated.
The verifier fails if required restart evidence fails; it cannot silently pass
with a best-effort recovery gap. Original runs observe 3/3/2 model requests;
including two continuations gives 10. Token values and measured latency are
explicitly **controlled fixture/local measurements**, not real-model quality,
savings or performance claims. No UI or abrupt-crash acceptance is implied.

Reproducible package and focused verification:

```sh
npm pack --ignore-scripts --pack-destination /tmp --json
node scripts/verify-enterprise-agent-platform.mjs --source .artifacts/dsh-native-zcode --archive /tmp/kingsoftcloud-agentkit-studio-0.0.2.tgz --keep
```

Reviewed metadata, source/archive/fixture/verifier hashes, observed usage and
limitations are retained in `enterprise-agent-platform-local-evidence.json`.
The verifier uses a reused symlinked dependency graph, not a fresh install.
Actual Claude Code produced an unrun draft and reached its turn limit; main
review fixed bootstrap configuration, real operation status and retry polling,
revision-digest identity expectations and Session source names. Main review
also made restart mandatory and added changed-resource/frozen-Build evidence
before running acceptance. No production authority was bypassed to make it pass.

### Shared retry budget through real HTTP and cold SQLite reopen

`packages/agentkit-harness/test/native-retry-budget.test.mjs` drives the actual
model adapter, NativeKernel and SQLite with localhost HTTP responses. Provider
rate limits and empty responses share one three-call task cap even though their
error counters differ. A cold worker honors the persisted next-attempt time and
consumption; the adapter issues one HTTP attempt at a time. During an active
retry wait, wall-budget exhaustion prevents another request; cancelling a
persisted wait also prevents another request. Worker downtime is not claimed as
active execution time. These are mechanism tests, not latency benchmarks.

Seven focused cases passed (retry integration plus existing protocol integration
and pure retry policy), without a full suite:

```sh
node --test --test-timeout=10000 packages/agentkit-harness/test/native-retry-budget.test.mjs packages/agentkit-harness/test/native-model-integration.test.mjs packages/agentkit-harness-core/test/retry.test.mjs
```

An independent Claude Code review found that compaction mixed provider retry
errors with invalid-summary errors while selecting two different ceilings from
the latest error kind. Core now persists separate provider and summary counters;
old combined-counter compactions resume conservatively. Memory and SQLite
NativeKernel runs with a provider failure followed by an invalid summary now
complete within each category's own limit. The focused context suite passed
34/34 after rebuilding the core. The review's claim that summaries evade the
shared model-call limit was rejected: `store.mts` charges every model attempt
atomically at claim time, and the summary reducer adds only reported token/cost
usage to avoid double counting. Existing context tests assert total model calls
include every summary. Deadline delivery's larger summary output allowance is
an explicit policy with a regression test; the token counter remains an
estimate and provider overflow recovery is still a separate limit. This fix
alone does not close the remaining cross-capability budget acceptance points.

```sh
node scripts/build-native-harness.mjs
node --test --test-timeout=15000 packages/agentkit-harness-core/test/context-planning.test.mjs
```

### Native defaults and mounted Agent management

See [management behavior and reproduction](enterprise-agent-management.md) and
[the mounted report](enterprise-agent-management-evidence.json). New local manual
and conversational authoring now default to Native through a browser-safe shared
constant; explicit runtimes and persisted records retain their existing meaning.
A stale edit remains visible after rejection; explicit refresh fetches and
remounts the latest revision before reapplying changes.

Actual Chrome creates/searches the Agent, builds r1, opens two editors, rejects
the stale write, refreshes and saves r3. It then runs both the historical Build
and current Agent through ordinary product actions. SQLite and actual local
model requests retain revisions 1/3 with one Native call each; both histories
survive page reload. This earns P2's user-facing management 5 points. It does not
claim real-model quality. The extended verifier now holds a third model response
while Chrome reloads during the active revision-3 turn; the user message remains
visible after reload, the released answer appears in the same Session, and its
continuation Run is linked to the earlier Run with one model call. A further
turn completes durably while Chrome is offline, then the answer appears when
Chrome reconnects with no duplicate model call. These earn two P4 interaction
points. A further held model request is stopped from the actual conversation UI;
the canceled Native Run and stopped history survive reload, and a late answer is
not shown. This earns one more P4 interaction point. Host-crash recovery remains
a separate gate. Actual Claude Code audited
explicit runtime preservation and ran 66 focused checks; primary's affected
Host/form checks (204), contract TypeScript and client build pass. No full suite
was run.

A further real Chrome turn against the fresh packed Host received a deliberate
provider 401. The Native ledger stored one failed Run and one model call; the
Run panel displayed a fixed public error before and after page reload, without
showing the private response body. The canonical failure event uses the same
safe mapping. This earns one more P4 interaction point. The updated
[mounted report](enterprise-agent-management-evidence.json) records the six
requests and all terminal phases; focused affected tests passed. A subsequent
fresh packed Host and actual Chrome run added a strict coding Agent: the pending
approval survived reload, one UI “allow once” answer caused one workspace
effect, and history recorded one asked/decided pair. Explicit provider thought
appeared after reload, while a second profile with display disabled kept its
private reasoning out of the UI and inspected Session history. This earns P4's
last interaction point; the [mounted report](enterprise-agent-management-evidence.json)
now records nine fixture model requests. Real-model measurements and wider
Host-crash/side-effect fault acceptance remain open.

## Next delivery order

The first bounded actual-model Native check used
`node scripts/verify-native-real-model.mjs deepseek-v4.1-flash` and the saved
local model credential without printing or persisting it. Each task ran through
the current NativeKernel, production HTTP adapter and temporary SQLite store.
The business travel prompt completed in one model call with 44 input/94 output
tokens and 1,216 ms; the TypeScript repair prompt completed in one call with 45
input/44 output tokens and 778 ms. Both matched their task-specific text checks.
These are provider-reported tokens and local wall times, not billed cost (the
provider did not report a price). The kernel reported `unverified` because no
external result verifier was installed. This is a two-task smoke check, not a
statistical quality or baseline/reference comparison; P5 earns only one of its
six measurement points.

The local config had a legacy API key but no explicit model name. The settings
view advertised `deepseek-v4.1-flash`, while `modelService.profile('')`
previously returned an empty model name. The service fallback now matches
settings, with a focused regression (5/5). A compiled bundle Host attempt was
not counted as evidence: the checkout is not an installed runtime containing
DSH packages, so startup failed with `ENOENT`. This does not establish a model
or Native runtime failure. The context/budget SQLite integration check passed
3/3 after the compaction retry correction; its existing scope remains the two
points already earned in P4.

The [runtime boundary audit](enterprise-agent-runtime-audit.md) records the
three engine choices, local/cloud route separation, product Session ownership,
frozen Build/portable deployment boundary and the mounted local management
evidence. Focused runtime, Build and portable checks passed 28/28. This earns
P5's three audit points; it does not claim cloud Native deployment or
cross-engine in-flight state migration.

The [paired actual-model report](enterprise-agent-real-model-comparison.json)
uses the same configured `deepseek-v4.1-flash` and production model adapter for
direct inference and NativeKernel with SQLite. Two fixed prompts (business and
coding) ran three rounds per variant, alternating execution order (12 actual
model attempts). Median reported input tokens were 45 for both, output tokens
66 direct versus 72 Native, and local elapsed time 953 ms direct versus
1,098 ms Native. The simple task checks passed 4/6 direct and 3/6 Native;
coding was 3/3 for both, while the business check was 1/3 direct and 0/3
Native. The script records no response body or credential. This small,
sample does **not** establish Native
quality, speed or token savings; it exposes a business prompt needing better
instruction/result evaluation. P5 adds two measurement points for actual
side-by-side data; tool-using and reference-Harness comparisons remain open.

The [paired tool-task report](enterprise-agent-real-model-tool-comparison.json)
uses a fixed read-only travel-policy tool with the same model for a minimal
direct two-call loop and NativeKernel/SQLite. Two rounds per variant, with
alternating order, each called the tool once and calculated 860 against a
900-unit cap. Provider-reported token counts and local elapsed times are
recorded per sample. The first streamed attempt exposed a real OpenAI-compatible
SSE variation: a later tool fragment carries `id: null` and `name: null`
after an earlier fragment supplied both. Native's parser incorrectly marked the
whole batch malformed. It now ignores null *continuation* fields while still
rejecting a different non-null identity. The focused adapter suite passed
123/123 before the final negative identity check; that check then passed with
the new null-fragment case (2/2). A buffered two-round run and a streamed
two-round run after the fix both passed their arithmetic and exact-tool checks.
This earns one more P5 measurement point for a real tool-using task. The
samples are too small to establish latency or token advantage, and the direct
baseline has a different system context; a comparable reference-Harness or
broader task-quality benchmark remains open.

Two additional existing fault fixtures were re-run for this objective, rather
than inferred from their filenames. `tests/native-workspace-receipt-process.test.mjs`
passed 2/2: a real SIGKILL after one workspace publication is followed by a
different Host process, which reads the original fenced receipt without a
second write; a rejected post-policy output cannot launder the raw write into
success. `tests/native-a2a-control-process.test.mjs` passed 4/4: SIGKILL while
remote continue/cancel responses are held, both when the remote effect applied
and when it did not, leaves one original send and no cold resend. Read-only
observation reports the unknown outcome and preserves the original intent.
These are local controlled-model/HTTP fault experiments, not proof of exactly
once execution by every external service. They earn P5's two remaining fault
points; the six-point fault category is now complete.

1. Finish the bound-policy extension/resource matrix, then close remaining
   context/source and cross-capability budget integration while preserving
   Memory and child lifecycle invariants. The Skill shell lease-loss check and
   default strict policy for newly saved Native Revisions are complete.
2. Expand the bounded actual-model smoke into a representative result/token/
   latency comparison with a fixed baseline and explicit task-quality checks.
3. Perform final integrated acceptance and explicit requirement/license audit.

Each batch runs targeted checks; broad checks happen at final/stage integration
or when new evidence warrants them. No full-suite rerun after every merge.
