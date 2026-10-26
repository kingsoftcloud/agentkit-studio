# Enterprise Agent Studio: bounded reference and responsibility audit

Reviewed 2026-10-26 against the enterprise platform objective. Actual Claude
Code supplied a draft; main review removed conclusions unsupported by the
bounded search. This is an engineering source/provenance inventory, not a
complete license or architecture acceptance gate.

## Reference inputs and limits

| Reference | Evidence inspected | Scope |
| --- | --- | --- |
| ZCode | `/tmp/agentkit-zcode-reference`, HEAD `3c5b227649371507ddc4eb46ac5133afe6db1cab`; its `LICENSE`, `NOTICE.md` opening and named source files | Pinned source and existing attributed code below. Full NOTICE applicability still requires review. |
| pi | `native-zcode-alignment.md` records `d5b3de22d0e24a3e9c38a9410d3329b099717283` | This audit did not locate/inspect that source. Composition claims remain to be revalidated for this platform objective. |
| OpenCode | Earlier conversation records `f669c46c9604ea3d70b8a7ed1f0c10f3a5ac1f61` | This audit did not inspect its source. Absence from one local document does not establish absence of a pin or checkout everywhere. |
| AgentCore / Volcano AgentKit | Current plan's platform lifecycle/resource analogy | Current official product docs were not inspected. No claim of feature equivalence or imported implementation is established here. |

Searches were bounded to relevant local paths, not all disks. Not locating a
checkout does not prove none exists. Product names alone do not establish a
license, dependency, deployment architecture or current capability.

## Existing source provenance

`THIRD_PARTY_NOTICES.md` names four core modules and one command-plan package
from the pinned ZCode source. `third-party/ZCode-LICENSE` preserves the upstream
Apache-2.0 license. Headers identify the upstream paths and local adaptations:

- `patch-parser.mts` and `patch-apply.mts`: structured patch parsing/application.
- `edit-matchers.mts`: standalone matching algorithm.
- `tool-search-ranking.mts`: ranking and MCP-name normalization.
- `third-party/zcode-command-plan/`: parser, read-only argument policies and Git
  checks; `source.json` records per-file original digests. The inspected
  `bash-command-parser.ts` upstream digest matches its recorded original hash.

Two additional modules explicitly describe a ZCode port/adaptation but are not
listed in the current notice inventory: core `memory-extraction-scheduler.mts`
(`memory/extraction.ts`) and Node `model-anthropic-cache.mjs`
(`context/builder.ts`, `provider-request-messages.ts`). Their relevant upstream
sources and complete attribution inventory need review before final delivery.
A comment alone cannot establish whether implementation was copied or whether
notice obligations apply. The same limit applies to comments calling an
implementation a behavioral reference.

Upstream `NOTICE.md` contains product/security/privacy statements. Its full
contents and applicability to retained code have not been audited here. Do not
present upstream product policy as Studio policy. Current dependency and bundled
license coverage also remains a final gate; the inventory above is not proof
that the project has no other third-party code.

## Responsibility findings in current sources

- `NativeKernel` plus `machine.mts`, `transitions.mts` and `store.mts` is the
  authoritative driver for protocol, budgets, ordering, cancellation, ownership
  and receipts. Node adapters and Host composition provide resources and I/O.
- The kernel imports todo, plan-mode, tool-discovery, coordinator-response,
  artifact, browser, source-read and background helpers. This proves coupling
  to capability-specific behavior, not by itself duplicate execution or a
  permission bypass. Inventory each branch before extracting it. Atomic state,
  tool admission and enabled-capability lifecycle guarantees must remain intact.
- Provider-specific `anthropic-context.mts` is imported by the kernel. Separate
  codec/policy choices from mandatory message legality; do not remove replay
  correctness merely to reduce imports.
- `auxiliary-run.mts` invokes the same NativeKernel. Memory prompts, allowed
  tools and extraction limits live in Node
  `packages/agentkit-harness/src/native/memory-extraction-run.mjs`; trusted source
  projection lives in `src/providers/native-memory-extraction-source.mjs`.
  They do not install a second execution loop. Host job/cursor/lifetime wiring
  remains incomplete.
- Local Agent CAS belongs to `src/agent-store.mjs`; client and Host routes must
  preserve expected revision and live cancellation authority. HTTP
  authentication is `connection.admit` in `routes/http.mjs` before dispatch;
  dispatcher operation validation does not replace admission.
- Harness identities remain `harness` (Studio Native), `dsh-native` (separate DSH
  engine), and `codex`. Published Build identity, live revision digest, Session
  identity and execution environment are separate concepts.

## Remaining audit work

Inspect pinned pi/OpenCode implementation for the specific boundaries used;
identify the intended AgentCore reference and verify relevant official docs;
complete source/diff/notice and bundled dependency review; and examine kernel
branches for actual duplicated state or bypasses before restructuring.

Route-driven business/coding and retry evidence is recorded separately in
`enterprise-agent-platform-plan.md` and
`enterprise-agent-platform-local-evidence.json`. This document does not certify
UI, automatic Memory, real-model performance or final platform completion.
