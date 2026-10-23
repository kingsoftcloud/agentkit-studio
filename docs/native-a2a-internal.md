# Optional internal A2A control plane

Reference: `ksadk/a2a/control_plane.py` and `space_client.py`, read-only
`ksadk-python` revision `355059d78e47ed764bbdb3606304cdf34e9838a3`.
This is the outgoing registry/permit/credential/task-binding adapter used by
the existing Native and independent DSH A2A Host. It is not completion of the
inbound server, automatic waiters, subscriptions or canonical event outbox.

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
automatic HTTP replay. Mounted Host verification supports
`scripts/verify-studio-native-a2a.mjs --internal-control-plane --source <built-host> --archive <tgz> --keep`,
with the actual preset/ToolRegistry/SessionController and Node-only PATH.

Canonical task-event delivery/outbox, subscriptions/automatic waiters and
inbound registry/server assembly still need implementation and acceptance.
The transport's `appendTaskEvents` primitive alone does not close that gap.
Online control-plane authentication and real human/browser acceptance are
also unverified. See `native-migration-status.md` for the unchanged full goal.
