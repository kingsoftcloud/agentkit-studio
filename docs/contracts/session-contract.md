# Studio Session contract (`p1-session-contract-v0.1`)

The contract is owned by `agentkit-studio`; the durable session source remains the existing
AgentEngine/KsADK runtime. The DSH Session Controller remains the only browser session owner.

## Boundaries

- `KsADKSessionPort`: canonical snapshot, watermark tail, idempotent commands.
- `DshSessionProvider`: official DSH Session Controller baseline and live event source.
- `StudioSessionAdapter`: identity-aware conversion only; no transcript, runner, or second store.
- `AgentCatalogPort`: list/create/update/build Agent revisions.
- `DeploymentPort`: deploy/update/stop/delete/rollback operations.
- `SessionPort`: create/get/list/send/cancel/resume and history paging.
- `ResourceBindingPort`: versioned resource references and capability checks.

## Invariants

`session_id`, `run_id`, `event_id`, `interaction_id`, and physical `seq` remain distinct. A
replayed event with the same ID and different content fails. Different IDs on one physical
sequence fail. Reconnect loads the DSH baseline and resumes from a verified watermark; it never
re-sends a user command. Interaction answers carry a positive expected revision.

The current implementation promotes user messages, run boundaries, assistant text/reasoning, and
tool call/result lifecycles into the official DSH wire and preserves canonical identity in the
`_ksadk` carrier. Goal, approval/interaction, artifact/data, retry, and A2UI families remain
lossless `ignorable` events until an official DSH node contract is proven. Watermark coverage,
duplicate replay, sequence collision, and late-after-cancel behavior are covered by the adapter
tests; live Session Controller reconnect and historical paging still need an end-to-end gate.
