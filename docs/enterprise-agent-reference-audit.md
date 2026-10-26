# Enterprise Agent Studio: bounded reference and responsibility audit

Reviewed 2026-10-26 against the enterprise platform objective. Actual Claude
Code supplied a draft and independently checked the declared ports; main review
checked the pinned checkout, corrected the two missing port notices and removed
conclusions unsupported by the bounded search. This is the source/provenance
and license inventory for the Native migration scope. The final archive must
still be checked after all implementation changes.

## Reference inputs and limits

| Reference | Evidence inspected | Scope |
| --- | --- | --- |
| ZCode | `/tmp/agentkit-zcode-reference`, HEAD `3c5b227649371507ddc4eb46ac5133afe6db1cab`; its `LICENSE`, `NOTICE.md`, named source files and command-plan manifest | Pinned source and attributed code below. |
| KsADK Python | `ksadk-python` branch `feat-ksadk-harness-2` at `355059d78e47ed764bbdb3606304cdf34e9838a3`; root `LICENSE` | Original Apache-2.0 migration source for named Native browser, web, workspace, A2A, model and Studio metadata ports. It is source lineage, not a Python runtime dependency. |
| pi-durable | `/tmp/agentkit-pi-durable-reference-d5b3de22` holds the pinned README, specification, tool, submission, scheduler, Session and CLI sources at `d5b3de22d0e24a3e9c38a9410d3329b099717283` | The bounded [pi-durable assessment](native-pi-durable-reference.md) checks specific recovery, submission, ownership and host boundaries. It is not a complete conformance or license audit. |
| OpenCode | `/tmp/agentkit-opencode-reference-f669c46`, HEAD `f669c46c9604ea3d70b8a7ed1f0c10f3a5ac1f61`; `packages/server/src/{handlers/event.ts,event-feed.ts,handlers/session.ts,handlers/message.ts,auth.ts}` | Bounded review of headless server, session APIs, event feed and authentication. It is an architecture reference, not imported code. |
| AgentCore / Volcano AgentKit | [AWS AgentCore overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/), [AWS observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html), [Volcano AgentKit overview](https://docs.volcengine.com/docs/agentkit/What_is_AgentKit?lang=zh), [Volcano Runtime overview](https://docs.volcengine.com/docs/agentkit/Agent_runtime_overview?lang=en), reviewed 2026-10-26 | Official product boundary reference only. Current Studio local implementation is not certified to offer the cloud services described there. |

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
- `todos.mts` and `coordinator-response.mts`: adapted ZCode tool shapes and
  result behavior with Native-owned receipt and child authority.
- `third-party/zcode-command-plan/`: parser, read-only argument policies and Git
  checks; `source.json` records per-file original digests. All 23 recorded
  SHA-256 hashes match both the pinned upstream files and the retained local
  source. `index.ts` is the documented local entry adaptation.

The explicit port of `memory/extraction.ts` and adaptation of
`context/builder.ts` plus `provider-request-messages.ts` are now attributed in
the notice inventory. The local scheduler retains reference algorithm and
control flow but adds Host-owned durable cursor commit; the Anthropic adapter
projects cache breakpoints only onto provider wire messages. Remaining ZCode
citations under `src/` and `packages/` were classified against the pinned
sources: plan mode, destructive MCP hints, EOL choice, context-pruning
thresholds, model continuation and workspace rewind use policy facts or
behavior, with Native-owned state, ports and receipts. No second copied
implementation was found in that bounded search.

A separate Claude Code read-only license review identified `todos.mts` and
`coordinator-response.mts` as uncategorized ZCode citations. Primary review
compared both to the pinned upstream contracts and handlers, confirmed their
adapted tool shapes/results, added their notice entries and in-file Apache-2.0
pointers, and checked that both source files are required in the packed archive.
The archive integrity check passed for 1,845 files. This resolves those two
specific attribution gaps; it does not certify every asset or future dependency.

Upstream `NOTICE.md` contains product/security/privacy statements rather than
an attribution list for these retained files. Do not present upstream product
policy as Studio policy. The local package dry-run includes the root LICENSE,
this notice, ZCode's license, the command-plan bundled license, and both newly
attributed source files. The command-plan bundle records 23 pinned original
file hashes and `unbash@4.0.1` ISC text. The MCP bundle records 18 dependencies;
all 18 names and versions were checked against its bundled notice text. The
four local-process launchers passed source-binding and musl/GCC redistribution
license checks. Both archived DSH maintenance bundles have MIT licenses and
verified patch manifests. The browser client bundle's esbuild input manifest
rejects `node_modules` and backend imports. These checks cover the identified
bundled external code, not future third-party additions. The final built
archive check belongs to P5.

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
- Product, managed and child entry points instantiate the same `NativeKernel`;
  `auxiliary-run.mts` delegates to it instead of implementing another
  model/tool loop. Tool and context capability modules stage effects through
  original intents and receipts. This source scan found no duplicate Native
  execution-state authority; P2 separately checks authority through external
  I/O and asynchronous waits.

## OpenCode headless boundary comparison

At the pinned OpenCode commit, `packages/server/src/handlers/session.ts`
exposes session lifecycle and prompt operations; `handlers/message.ts` reads
durable messages with a paginated cursor. `handlers/event.ts` streams events
through `event-feed.ts`, whose subscribers use a bounded in-memory queue and
receive a connection event plus heartbeats. This event stream does not itself
replay events missed while disconnected; a client needs a durable session read
to rebuild its view. `auth.ts` supports an optional server password and signed
session cookies. These are source observations, not claims about every
deployment's defaults.

Studio already presents session snapshot/command, Build-bound conversation
stream and recovery operations through `src/host-remote.mjs`. The Host's HTTP
entry applies `connection.admit` before its registered routes. Native state and
recovery remain owned by the Host plus NativeKernel; moving them into a second
OpenCode-style server would duplicate authority. The useful pattern to retain
is independent clients over authenticated APIs plus event delivery and durable
readback. A future second client should be checked against the same Host
identity, cursor and idempotency contract, not a separate runtime state store.

The pinned OpenCode root `LICENSE` is MIT. No OpenCode source is copied into
this project by the comparison above; if code is imported later, its copyright
and license notice must accompany that source.

## Platform reference boundary

AWS's AgentCore overview describes a framework-agnostic Runtime combined with
separate Memory, Gateway, Identity and Observability resources. Its
observability documentation includes session, latency, token and error metrics.
Volcano AgentKit's overview describes build/configuration, deployment,
invocation/testing, observability and evaluation, while its Runtime overview
distinguishes the hosted execution environment from Gateway, Knowledge, Memory
and A2A resources. These official sources support the four-layer Studio
responsibility map and the decision to keep Native a replaceable execution
engine. They do not prove that Studio already supplies managed cloud scaling,
isolation, network or identity services. This phase verifies local Host
boundaries and leaves cloud deployment as an explicit later implementation.

## Final artifact boundary

Re-run archive integrity/license checks after all edits, then examine the
actual diff against the acceptance checklist before pushing. This P5 release
gate is separate from the source inventory above.

Route-driven business/coding and retry evidence is recorded separately in
`enterprise-agent-platform-plan.md` and
`enterprise-agent-platform-local-evidence.json`. This document does not certify
UI, automatic Memory, real-model performance or final platform completion.
