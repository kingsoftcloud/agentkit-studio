# pi-durable reference assessment

Reviewed 2026-10-26 at upstream commit
`d5b3de22d0e24a3e9c38a9410d3329b099717283` (the observed remote HEAD).
Read the README, normative specification and selected tool, submission,
scheduler, Session, CLI SessionManager and child-task example sources. This is
a bounded design assessment, not a full implementation/conformance audit, code
size measurement, license audit or benchmark.

## Decision

Prioritize pi-durable for Native's durable task and host-library boundaries.
Continue using pi coding-agent for useful context/tool/interaction techniques,
ZCode for selected I/O/tool governance and the existing Studio platform owners.
Do not replace NativeKernel or add a second scheduler just to match upstream.
Do not depend on the experimental package for this implementation batch.

## Verified semantics and limits

| Claim | Source evidence and implication |
| --- | --- |
| Durable tasks and submissions | README Persist and Resume, specification sections 5/6 and `src/harness/submissions.ts`: a request ID identifies a submission within a conversation. The implementation returns the previous submission and rejects a different submission type; it does not compare every input byte. Keep Native's own exact payload/configuration guards. |
| Tool replay | `src/harness/tool.ts` commits final arguments and replay policy before execution. Recovery reruns only if both stored and current policies say safe; otherwise it returns interrupted and explicitly says the effect may have partially run. This is not exactly-once execution of an external system. Keep Native's original owner receipts, unknown-effect state and reconciliation. |
| Cancellation and compensation | Ownership orders descendant cancellation before the owner's abort handler. `test/examples/23-child-tasks.ts` implements payment reversal itself with a process-local fake bank Set. It does not prove automatic or transactional external refunds. Real compensation needs its own durable identities, authorization, receipts and failure handling. |
| Storage owner | README Storage requires one process per storage and supplies no cross-process lock. Cloudflare's owner/alarm infrastructure makes that deployment possible. On a generic multi-instance service, routing, exclusivity, failover and stale-owner rejection remain Host responsibilities. Preserve Native leases/fences. |
| Tenant security | Specification ownership is explicitly not an access-control capability. Environment factories can select directories/containers but do not themselves supply tenant authentication, sandbox enforcement or isolation. Keep enterprise policy and resource checks in trusted Host/execution boundaries. |
| Publication | Ordinary entries/task states commit before publication. The pinned specification also permits explicitly deferred changes to certain existing latest/initial-fork documents; a crash can lose that progress window. Do not restate the README as an unconditional guarantee about every displayed progress update. |
| Registry and settings changes | Upstream deliberately resolves some code/configuration at later task/request boundaries. For enterprise frozen Builds, pin the resolved implementation/configuration version; make upgrades an explicit operation rather than inheriting live registry changes. |
| CLI | CLI SessionManager persists messages in JSONL and manages multiple sessions. It lacks pi-durable's task recovery contract; describing it as one machine/one session or no persistence is inaccurate. CLI also supports SDK/RPC composition. |

## Apply to Native incrementally

1. Public library ports and lifecycle first: storage, model, execution environment,
   tool/extension registry, trusted authorization/audit, and committed event reads.
   Studio remains the composition root; package consumers cannot require Studio
   source imports. Four upstream ports are a useful simplification, not a reason
   to remove enterprise authority or observability contracts.
2. Reuse the existing Native durable intent/receipt/lease mechanism for optional
   capabilities. Automatic Memory now uses a separate persisted job/cursor and
   Native auxiliary Run, not an in-memory callback loop. Pending jobs preserve
   their original configuration, source window and manifest across reopening.
3. Keep a single active owner per execution boundary and design an owner/wakeup
   adapter for future cloud scheduling. Current work remains local-only. A
   routing hash alone is not exclusive ownership or a failover protocol.
4. Measure task quality, tokens, latency and recovery on the same workloads.
   Durability/code size alone proves no token saving or faster execution.

Sources (all paths under the pinned upstream commit):

- [README](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/durable/README.md)
- [Specification](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/durable/docs/spec.md)
- [Tool execution/recovery](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/durable/src/harness/tool.ts)
- [Submission admission](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/durable/src/harness/submissions.ts)
- [Child-task payment example](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/durable/test/examples/23-child-tasks.ts)
- [CLI SessionManager](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/session-manager.ts)
