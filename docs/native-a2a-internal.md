# Optional internal A2A control plane

Reference: `ksadk/a2a/control_plane.py` and `space_client.py`, read-only
`ksadk-python` revision `355059d78e47ed764bbdb3606304cdf34e9838a3`.
This is the outgoing registry/permit/credential/task-binding adapter used by
the existing Native and independent DSH A2A Host. It is not completion of the
inbound server, automatic waiters, subscriptions or full canonical content mapping.

## Configuration

Keep the pinned Agent `bindings.a2a` specs and existing AgentKit Harness entry.
Set trusted Host environment `KSADK_A2A_CONTROL_PLANE_URL` to enable internal
Actions. `KSADK_A2A_TOKEN_DIR` defaults to `/var/run/secrets/agentengine/a2a`.
Files are `a2a-registry.jwt`, `a2a-task-sink.jwt`, `credential-broker.jwt` and
`a2a-gateway.jwt`, as needed by the selected operation. No Python or JWT SDK
is installed or spawned. Configured internal service failures do not fall back
to public AgentCard discovery or service credentials.

`KSADK_A2A_ENABLE_PUBLIC_EGRESS=true` explicitly permits `external_public`
routes. `external_vpc` does not require that flag. All peer routes retain the
Host's connection-time DNS/address guard and redirect rejection;
`KSADK_A2A_ALLOW_PRIVATE=true` is a trusted deployment exception for private
routes. Tool arguments cannot set these options or supply a URL or credential.

Internal IDs retain their exact spelling: `as-<12 lower-case hex>` Spaces,
UUID4 compact Agent/version IDs (with the reference's optional prefixes), and
`a2a-task-<compact UUID4>` platform tasks. Public discovery retains its prior
ID handling. Discovery follows bounded cursor pages and filters non-callable
agents; the discovered version and card digest are pinned into the original
request. The fresh prepared target/version/card must match. The prepared
route and streaming capability govern the actual peer transport.

## Credentials and message digests

Every Action rereads its audience token; hosted gateways use a separate fresh
gateway token and the call permit. External routes receive only the broker's
header/query/cookie injection, with protocol-header and query collisions
refused. Cookie quoting supports spaces, separators and escaped values.
Broker credentials, workload JWTs and permits remain in memory; journals hold
only ownership, operation facts and opaque digests. Remote parser/fetch errors
cannot echo credential-bearing bodies, URLs or causes into explicit controls.

The file provider accepts regular `0400`/`0440` files and the Kubernetes layout
`<audience>.jwt -> ..data/<audience>.jwt`, where `..data` selects a real
generation inside the pinned volume. Ordinary key links, linked generation
ancestors and outside targets fail. Reads are bounded to 16 KiB and check
file type, permission bits, inode, size and timestamps before/after reading;
configured-root and token path drift during authority callbacks also fails.
Node has no general `openat`: this detects observed drift but does not promise
OS-atomic ancestry against an adversarial same-user ABA path swap. Platforms
without `O_NOFOLLOW` reject this optional adapter.

JWT signatures are verified remotely. Local validation checks ASCII,
base64url representation, exact audience and integer expiry, including large
JSON integers and decimal strings without rounding. Deliberately malformed
JWTs that Python's permissive decoder/coercions might accept (boolean/floating
expiry, non-string audiences, noncanonical encodings) fail explicitly.

Permit message hashes follow the reference's protobuf JSON normalization and
Python sorted UTF-8 JSON. In particular, protobuf `Struct`/`Value` numbers are
IEEE-754 doubles: data-part integers can become `1.0` in the digest, and values
above exact-double range round as in protobuf. This optional wire protocol
does not change Native's exact integer storage. Fixed fixtures were exported
using the reference environment's actual `Message`/`MessageToDict`; Python is
used to generate test baselines only, never in product installation/runtime.

## Persistence and recovery

The existing original Native Run or independent DSH Agent/Session/call owns
execution. Its initial `prepared -> sending` admission still precedes network
effects. Internal Prepare intent is saved under that same private call before
HTTP; verified preparation binds the server's actual platform task ID.
Credential resolution and peer admission each have durable markers. Grants
are not cached or reused after an interrupted operation.

The first valid remote Task is recorded as `binding` before `BindA2ARemoteTask`
and published as bound only after its acknowledgement. A fresh approved
`get` may reconcile an uncertain Bind using `PrepareA2ATaskOperation` for the
original platform task. It never resends Bind or the original message. If the
server cannot confirm the binding, uncertainty remains. Prepare/send outcomes
without a usable task binding also remain unknown; reopening history or
dispatching the original admitted call does not re-prepare or re-send it.

An initial Prepare response already bound to a remote Task becomes `GetTask`,
including for streaming callers. Fresh approved continuation/cancellation
prepares the original managed task with stable effect idempotency. Separate
safe reads obtain fresh operation identities, so the pre-cancel query and
post-cancel confirmation can both run. State publication uses the existing
short SQLite lock and preserves concurrent control entries, terminal states,
pause generations and the original deadline. No exactly-once claim is made.

## Verification scope and remaining work

Affected tests use actual token files, HTTP Actions, JSON-RPC/REST/SSE peers,
SQLite locks, NativeKernel and the Studio gateway. Explicit doubles cover the
remote services, issuer, DSH registry/consent and model responses. Process
tests use actual SIGKILL at Prepare, peer-send and Bind acknowledgement
boundaries, then open the original journal in a different PID and assert zero
automatic task HTTP replay (immutable event delivery can resume). Mounted Host verification supports
`scripts/verify-studio-native-a2a.mjs --internal-control-plane --source <built-host> --archive <tgz> --keep`,
with the actual preset/ToolRegistry/SessionController and Node-only PATH.

## Canonical lifecycle journal and delivery

Internal Native and independent DSH calls now produce canonical v2
`execution.scope/v1` lifecycle item events. The original Native run remains
the parent; DSH derives a DSH scope from its actual Agent/Session identities.
The child never publishes `run.*` ownership events. Submitted, working,
input-required and terminal descriptors are durable, with monotonic positions
in the private child journal. A public terminal descriptor cannot reopen after
a private inspection of an unknown remote result.

The original private call record atomically includes execution state, the
immutable event log and pending event batches (`agentkit.a2a-event-journal/v1`).
Its existing short SQLite publication lock plus fsynced atomic replacement
avoid a cross-file gap between advancing the local state and queuing delivery.
This is a new Node storage format; it does not read Python outbox databases.
Events are bounded to 8,192 / 8 MiB per call, and capacity failure is explicit.

A separate cross-process SQLite delivery lock serializes each owner's worker.
It posts the persisted bytes through actual `AppendA2ATaskEvents`, with fresh
`a2a-task-sink` authentication on every attempt. Delivery has a 5-second attempt
deadline and fixed 1-second retry interval. Only a successful response can
remove the pending batch; the immutable log remains available for replay.
After an uncertain acknowledgement the same event IDs and payloads are
retried, relying on the server's event-id deduplication. This projection retry
never retries Prepare, Bind, Send, Get or Cancel.

The reference's six permanent task-event error codes move the original batch
atomically into retained dead letters. Explicit `eventDelivery.flush/status`
reports a permanent failure even if later batches succeed. Arbitrary remote
messages, details and error codes do not enter the journal. Session closure
does not cancel Host-owned projection delivery; Host shutdown attempts a
bounded flush and retains unconfirmed batches. Native and DSH preset startup
reopen pending delivery without starting a model turn or tool operation.

The producer also checkpoints ordinary remote messages and artifacts, including
text, JSON values, typed tool calls/results, URL attachments and raw base64 files.
Part identities survive append and cold restore. Producer event IDs and SSE IDs
deduplicate identical facts and reject conflicting reuse; completed messages are
immutable. Proto3 empty scalar/list defaults normalize before fingerprinting,
while explicit empty messages, null Value contents and signed zero survive.

An internal terminal notification and `lastChunk` remain provisional. Only an
actual original `GetTask` observation authoritatively replaces/completes artifacts,
removes stale provisional artifacts and closes the canonical content checkpoint.
It also supplies completed text-part references to the lifecycle descriptor.
A failed confirmation leaves the original effect unknown; cold dispatch never
re-sends it or silently repeats the read. An explicitly authorized original-task
inspection remains available. Direct Message responses need no invented task.

Input/auth requests publish typed interaction/continuation facts, deduplicate
their original message identity and resolve superseded structured requests.
Typed approval declarations are validated and their previews bounded/redacted.
Remote progress can resume a continuation but cannot decide an approval: that
decision still belongs to the Host's durable interaction ledger.

Declared public tool-activity artifacts (`urn:ksadk:a2a:tool-activity:v1`) now map
to remote tool-call/result observations in the same atomic journal and outbox.
They preserve stable child identities across SSE, GetTask and cold recovery;
duplicate frames/defaults produce no new facts. A changed valid closed item
fails atomically. Malformed/unsafe first observations become a safe diagnostic,
and malformed updates retain the last accepted observation without exposing raw
input. Sensitive keys/values, internal URL literals, strict public schemas and
the reference 16 KiB per-event / 1 MiB cumulative invocation limits are checked.
These observations grant no local tool execution or approval authority and do
not become text output references. This implements outgoing-call consumption;
it does not implement an inbound server or a public-activity producer.

Approval-decision event integration,
session-wide canonical event-store consumption, delivery diagnostics in Studio
UI, and custom outbox-path/backend configuration parity remain open. Do not infer
complete canonical parity from the mapped subset. Subscriptions/automatic waiters and inbound registry/
server assembly also still require implementation and acceptance.
Online control-plane authentication and real human/browser acceptance are
also unverified. See `native-migration-status.md` for the unchanged full goal.
