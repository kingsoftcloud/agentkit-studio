# Enterprise Agent Studio: bounded reference and responsibility audit

Reviewed 2026-10-26 against the enterprise platform objective. Actual Claude
Code supplied a draft and independently checked the declared ports; main review
checked the pinned checkout, corrected the two missing port notices and removed
conclusions unsupported by the bounded search. This is an engineering
source/provenance inventory, not a complete license or architecture acceptance
gate.

## Reference inputs and limits

| Reference | Evidence inspected | Scope |
| --- | --- | --- |
| ZCode | `/tmp/agentkit-zcode-reference`, HEAD `3c5b227649371507ddc4eb46ac5133afe6db1cab`; its `LICENSE`, `NOTICE.md`, named source files and command-plan manifest | Pinned source and attributed code below. Final license/dependency review remains open. |
| pi-durable | `/tmp/agentkit-pi-durable-reference-d5b3de22` holds the pinned README, specification, tool, submission, scheduler, Session and CLI sources at `d5b3de22d0e24a3e9c38a9410d3329b099717283` | The bounded [pi-durable assessment](native-pi-durable-reference.md) checks specific recovery, submission, ownership and host boundaries. It is not a complete conformance or license audit. |
| OpenCode | Earlier conversation records `f669c46c9604ea3d70b8a7ed1f0c10f3a5ac1f61` | This audit did not inspect its source. Absence from one local document does not establish absence of a pin or checkout everywhere. |
| AgentCore / Volcano AgentKit | Current plan's platform lifecycle/resource analogy | Current official product docs were not inspected. No claim of feature equivalence or imported implementation is established here. |

Searches were bounded to relevant local paths, not all disks. Not locating a
checkout does not prove none exists. Product names alone do not establish a
license, dependency, deployment architecture or current capability.

## Existing source provenance

`THIRD_PARTY_NOTICES.md` names the retained core source modules, the Anthropic
cache projection, and one command-plan package from the pinned ZCode source.
`third-party/ZCode-LICENSE` preserves the upstream Apache-2.0 license. Headers
identify the upstream paths and local adaptations:

- `patch-parser.mts` and `patch-apply.mts`: structured patch parsing/application.
- `edit-matchers.mts`: standalone matching algorithm.
- `tool-search-ranking.mts`: ranking and MCP-name normalization.
- `memory-extraction-scheduler.mts`: eligibility and coalesced scheduling,
  extended with a Host-persisted cursor callback.
- `model-anthropic-cache.mjs`: provider-wire cache breakpoint projection.
- `third-party/zcode-command-plan/`: parser, read-only argument policies and Git
  checks; `source.json` records per-file original digests. All 23 recorded
  SHA-256 hashes match both the pinned upstream files and the retained local
  source. `index.ts` is the documented local entry adaptation.

The explicit port of `memory/extraction.ts` and adaptation of
`context/builder.ts` plus `provider-request-messages.ts` are now attributed in
the notice inventory. The local scheduler retains reference algorithm and
control flow but adds Host-owned durable cursor commit; the Anthropic adapter
projects cache breakpoints only onto provider wire messages. Other comments
that call an implementation a behavioral reference still require source/diff
review before the final attribution inventory is certified.

Upstream `NOTICE.md` contains product/security/privacy statements rather than
an attribution list for these retained files. Do not present upstream product
policy as Studio policy. The local package dry-run includes the root LICENSE,
this notice, ZCode's license, the command-plan bundled license, and both newly
attributed source files. Dependency and bundled-license coverage remains a final
gate; this inventory is not proof that the project has no other third-party code.

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
  They do not install a second execution loop. Host
  `native-memory-extraction.mjs`, SQLite job/cursor storage and the mounted
  Native service now schedule, recover and report extraction. See
  `enterprise-agent-memory-recovery.md` for the tested crash boundaries.
- Local Agent CAS belongs to `src/agent-store.mjs`; client and Host routes must
  preserve expected revision and live cancellation authority. HTTP
  authentication is `connection.admit` in `routes/http.mjs` before dispatch;
  dispatcher operation validation does not replace admission.
- Harness identities remain `harness` (Studio Native), `dsh-native` (separate DSH
  engine), and `codex`. Published Build identity, live revision digest, Session
  identity and execution environment are separate concepts.

## Remaining audit work

Inspect pinned OpenCode implementation for the specific boundaries used;
identify the intended AgentCore reference and verify relevant official docs;
complete source/diff/notice and bundled dependency review; and examine kernel
branches for actual duplicated state or bypasses before restructuring.

Route-driven business/coding and retry evidence is recorded separately in
`enterprise-agent-platform-plan.md` and
`enterprise-agent-platform-local-evidence.json`. This document does not certify
UI, automatic Memory, real-model performance or final platform completion.
