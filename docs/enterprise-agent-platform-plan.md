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
2. **Memory policy in general core (work in progress).** The uncommitted
   `memory-extraction-run.mts` currently includes concrete extraction prompts,
   tool names and default policy limits. Put those in a capability module while
   retaining NativeKernel execution, leases, budgets, receipts and source checks.
3. **Vertical product evidence is incomplete.** Existing mounted Host proofs
   already authenticate HTTP and call `agents/local-get` and
   `agents/ensure-preset`. Their initial record is created directly through the
   store. Add complete route-driven create/edit/Build/admit/run scenarios for
   both a business and a coding Agent. Do not label the existing evidence absent
   merely because its setup bypasses the create route.
4. **Do not infer missing UI features from a single verifier.** Prior thinking,
   reconnect and history evidence exists in the coding-alignment record. Audit
   its actual scope and rerun relevant product paths under the new verticals.
5. **Local/server-client coupling needs investigation, not an assumption.**
   Agent route/dispatcher eagerly await server-client initialization. Prove an
   actual local failure before changing this boundary; absence of cloud
   credentials does not itself prove constructor failure.

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
| P1: responsibility and baseline audit | 15 | Four-layer source/ownership map (5); reproduced defects and coupling findings (3); reproducible local baseline (2); complete reference/duplication/license audit (5) | 10 |
| P2: lifecycle, resources and governance | 20 | Client/Host revision and late-cancel safety (3); immutable revision/engine binding regression evidence (2); full create/configure/Build/admission lifecycle (5); trusted extension/resource authority (5); user-facing version/conflict and management behavior (5) | 5 |
| P3: business and coding verticals | 25 | Business Agent effect/result through real product routes and NativeKernel (10); coding Agent effect/result through same engine (10); frozen bindings and cold continuation across both (5) | 0 |
| P4: capability and task interaction | 20 | Automatic Memory ownership/trigger/persistence/usage (5); context and shared retry budget (5); background and child lifecycle (5); approval/cancel/error/public reasoning/history/reconnect product flow (5) | 0 |
| P5: measurements and final acceptance | 20 | Representative actual-model result/token/latency comparison (6); failure/cancel/recovery/no-blind-replay experiments (6); runtime differences/local management and deployment boundary audit (3); final integrated checks, licenses and requirement-by-requirement audit (5) | 0 |

Current assessed progress: **15/100**, approximately 15%. P4 zero means its
existing capabilities are not yet re-certified as a group for this objective;
it does not mean Memory/context/children/UI are unimplemented. The earlier
43/100 is a different checklist and cannot be carried over.

No full milestone is certified solely by a related unit test or source filename.
If scope/evidence changes, record it explicitly rather than silently changing
the definition of completion. 100 means every row is achieved with no required
work outstanding.

## Evidence and reproducible commands

Baseline commit before new platform fixes: `22a47d8`. Reference ZCode checkout
was revalidated at `3c5b227649371507ddc4eb46ac5133afe6db1cab`. The previous
coding-alignment record contains pinned pi/OpenCode inputs and source findings;
new platform claims still require their own relevant source audit.

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

## Next delivery order

1. Complete actual route-driven business/coding local verticals. Actual Claude
   Code owns their independent verifier/fixture; main agent reviews and fixes
   product behavior if the integration exposes a gap.
2. Separate pending automatic Memory policy from generic execution and finish
   trusted source/job/cursor/lifetime integration. Do not report it complete
   merely because the scheduler or isolated model runner builds.
3. Audit and close shared-budget/context/background/children/governance gaps
   against both verticals, preserving old invariants and existing evidence.
4. Verify product interaction and management, collect honest actual-model
   measurements separately from deterministic protocol fixtures, then perform
   final integrated acceptance and explicit requirement audit.

Each batch runs targeted checks; broad checks happen at final/stage integration
or when new evidence warrants them. No full-suite rerun after every merge.
