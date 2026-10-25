# Native Skill diagnostics

Reference: `ksadk/skills/events.py`, `skills/runtime/loader.py`,
`skills/runtime/executor.py`, `skills/runtime/backends/{local,e2b}.py`, and
`skills/tool_defs.py` at `355059d78e47ed764bbdb3606304cdf34e9838a3`.
These are optional typed observations, not tool permissions or Kernel state
transitions. Historical Python event serialization is not a compatibility target.

## Production path

`packages/agentkit-harness/src/native/skill-events.mjs` supplies schema version 1
facts and the additive result contract `agentkit.native-skill-events/v1`.
Both independently owned Node workflow runtimes persist `skillEvents` in the
original private invocation record. Their result contains `skill_event_contract`
and `skill_events`; the existing ToolRegistry/rendering path carries those facts
with the workflow result. Unknown/in-progress results retain the original facts.
Finished cold replay returns the original result and IDs without loading packages,
creating a sandbox or executing a command. Old records without events stay unchanged.

The shared Host package loader records actual remote load, download, checksum
verification when an expected checksum exists, extraction and manifest parsing.
Workflow admission records candidates and selection; the evaluator records the
chosen Skill's execution, including instruction-only and failed workflows. Artifact
facts follow actual publication. Workflow completion follows confirmed E2B cleanup.
Unconfirmed cleanup produces an uncertain failure observation, never successful
completion. Local process lifecycle facts describe supervised process groups,
not OS isolation or removal of retained private working directories. DSH-owned
workflows keep their actual DSH runtime identity and an empty Native run ID.

Facts are fsynced with the original private record at the observed boundary. Their
IDs and per-Skill invocation IDs are scoped to the outer runtime and binding;
start/end facts share that identity and include measured lifecycle timestamps.
They do not replace the existing pre-effect intents, command receipts, lease
fences or canonical Native Run terminal state. A completed execution fact does
not establish successful delivery, confirmed cleanup or Agent consumption.

## Script sidecars

An admitted script receives `KSADK_SKILL_EVENT_FILE`,
`KSADK_SKILL_INVOCATION_ID`, and `KSADK_SKILL_REF_JSON` from the Host evaluator.
The first points to a private JSONL sidecar in that original invocation's workdir.
Local reading uses the existing bounded, no-follow artifact reader. E2B reading
uses the original authorized remote file port, without downloading it as a user
artifact. JSONL bytes are bounded to 256 KiB, 512 lines and 16 KiB per line.

Each child event must match an outer planned invocation and its exact admitted
SkillRef/version/checksum (or null for a local package). Outer run, trace,
decision and binding correlation overwrite child claims. Child frames can carry
load/package/manifest/execution/artifact diagnostics; Host workflow, session,
selection and result-consumption facts cannot be claimed by a sidecar.
Repeated IDs are deduplicated, conflicting duplicates and malformed frames
produce a bounded `sandbox.envelope.rejected` fact without copying the bad text.
Only known attribute keys and bounded scalar/string-list values survive; common
credential/URL/path forms are redacted. Child observations are explicitly marked
`source: sandbox` and never decide execution success or authorize another effect.
Overall diagnostics are bounded to 1,024 facts / 1 MiB with an explicit truncation
fact. This does not bound or replace the actual workflow's receipt/artifact data.

`recordNativeSkillResultConsumption` is the equivalent explicit Host helper for
an already committed Agent-step receipt. It requires the matching Run, runtime,
binding and a Host-produced completed execution. A workflow alone emits no
`skill.result.consumed`; child assertions cannot satisfy that helper. Callers
remain responsible for supplying a real committed receipt, not model input.

## Studio and evidence

Studio's observability read model expands recognized `execute_skills` tool facts
into deduplicated Skill spans for trace detail and OTLP, preserving correlation,
status and measured timestamps. This is a consumer of recorded tool facts, not
a new live event transport. The complete mounted Host/UI trace-delivery path is
still part of final product acceptance; component projection alone does not prove
every runtime produces or forwards such a trace.

The shared Native Host now produces this trace from its original durable Run
ledger, wired through the production bootstrap for ordinary and Managed turns.
Projection preserves event identity and measured snapshot usage, serializes
updates by scope and Run, and rejects stale revisions. Native events do not
carry wall-clock timestamps: trace events explicitly use their first projection
observation time, retained on replay. Exact diagnostic numbers that JSON cannot
represent are decimal strings. Trace-cache failure cannot drive the Kernel or
repeat model/tool effects. Nine directed checks passed in
`.artifacts/native-migration/native-trace-projection.log`, including actual Host
service execution, cold SQLite projection, stale projection and cache failure.
This closes the producer wiring gap; full mounted Host/browser UI acceptance
remains a final integration step.

Directed Node 26 checks passed in
`.artifacts/native-migration/skill-events-targeted.log` (15 cases) and
`skill-events-boundaries.log` (10 cases, 5 additional unique cases). They cover
real supervised local scripts and sidecars, remote package HTTP and SQLite,
production E2B lifecycle/command/file adapters with a local SDK peer, DSH-owned
workflow replay, cancellation, timeout, local/remote-effect SIGKILL, uncertain
cleanup, redaction/correlation/budget guards, explicit consumption checks and
persisted Studio trace/OTLP projection. No full suite, cloud E2B service,
complete mounted Host/UI or Node 22 rerun is claimed for this change.
The final `skill-events-consumers.log` contains 3 focused consumer checks,
including 2 additional cases for uncertain-result evidence and cancellation
locators: 22 distinct directed cases in total, not 28 unique tests.
