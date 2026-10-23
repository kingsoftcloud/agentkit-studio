# Native A2A Node integration

Reference: read-only `ksadk-python`, branch `feat-ksadk-harness-2`, commit
`355059d78e47ed764bbdb3606304cdf34e9838a3`. This implementation covers the
AgentCard-driven outgoing tool path. It does not yet complete the entire A2A
product, internal workload control plane, or inbound server migration.

## Binding and execution

Use the existing AgentKit Harness entry (`runtime.type = "harness"`) with the
whole-turn Native contract `agentkit.native-dsh-turn/v1`. Declare pinned remote
specs in the Agent's `spec.bindings.a2a`, for example:

```json
[
  {
    "local_name": "research",
    "binding_id": "research-binding",
    "space_id": "a2a-space-00000000000040008000000000000001",
    "target_agent_id": "a2a-agent-00000000000040008000000000000002",
    "expected_version_id": "a2a-version-00000000000040008000000000000003",
    "exposure": "tool"
  }
]
```

The Host snapshots `KSADK_A2A_SERVICE_URL` (default
`https://aicp.api.ksyun.com`), `KSADK_A2A_SERVICE_TOKEN`, AICP credentials
(`KSADK_A2A_ACCESS_KEY`/`KSADK_A2A_SECRET_KEY`, falling back to
`KSYUN_ACCESS_KEY`/`KSYUN_SECRET_KEY`), and region/account settings. Secrets stay
in Host closures. Only an opaque configuration digest participates in the
Run's plugin lock and recovery capsule.

The discovery Space defaults to the first bound spec. `KSADK_A2A_SPACE_ID`,
or the first entry in JSON `KSADK_A2A_SPACE_IDS`, overrides discovery. Without
a Space, no A2A tools are mounted. A Space alone allows discovery but does not
authorize a call to an unbound target; calling requires a pinned spec.

The production preset carries the spec snapshot into `native-dsh-tools.mjs`.
It registers `list_a2a_agents`, `get_a2a_agent_card`, and `call_a2a_agent` in
DSH's existing tool pipeline. The actual Native ledger request supplies scope,
Session, Run, turn, Build, call, operation and fence identity. DSH pre/post
policies and the existing standing policy/one-shot permission service remain
on the dispatch path. The model supplies only an agent reference and message.

Discovery uses the reference's public `ListAToASpaceAgents` Action, not the
different internal `ListA2ASpaceAgents` Action. Official AICP endpoints use
KOP signing or the configured service token. Custom service endpoints receive
no AICP signing credentials. AgentCard interfaces must declare protocol `1.0`
and `JSONRPC` or `HTTP+JSON`. The discovered version must equal the bound pin.
The hosted service token is not forwarded to an external-source AgentCard.

Card endpoints default to public HTTPS, with DNS address checks at the actual
connection boundary and redirects disabled. A trusted Host can explicitly set
`KSADK_A2A_ALLOW_PRIVATE=true` for its private deployment or local integration
server. Tool arguments cannot alter this policy or select an arbitrary URL.

## Persistence and cancellation

Native commits its tool intent before entering the gateway. The A2A service
then writes an atomic fsynced `sending` marker and allocates an immutable local
`a2a-task-*` handle before entering the network. State is stored outside the
workspace, under the Host's `native-harness/workspace-state/<agent>/a2a-calls`.
The record binds the complete original request, Host configuration, scope and
Session. Per-call SQLite OS locks serialize competing processes.

The first observed remote task/context pair is checkpointed before consuming
later events. A different pair is rejected. Artifact replacement/append,
terminal status, output references and ordered text parts are projected from
the wire. A stable duplicate SSE ID is idempotent; conflicting reuse fails.
Terminal reply selection preserves the reference's last-artifact preference,
then last-agent-message fallback. Stream EOF with an unfinished known task
polls that original task with `GetTask` until terminal or input pause.

Repeated admission of the identical call replays its stored result. It does
not rediscover or send again. Interrupted sends remain unknown, including a
crash after the marker but before the actual send. Unknown state never grants
permission for a replacement send. Cancellation aborts local waiting and
preserves the original remote locator; it does not assert that the remote
agent was cancelled. Do not create a new call ID to retry an unknown effect.

## Executed verification and remaining work

`tests/native-a2a-host.test.mjs` uses actual local HTTP/SSE, the production
Studio gateway, NativeKernel, SQLite and ledger authority. Only the DSH registry
is a declared pipeline double. It checks both protocol bindings, streaming and
non-streaming, actual UTF-8 chunks, duplicate events/calls, permissions,
version drift, cancellation, broken streams, GetTask and cold SQLite reopen.

`tests/native-a2a-process.test.mjs` kills real Node workers with `SIGKILL`
after network-send entry and after remote-task checkpointing, then starts a
replacement worker. It asserts the unknown Native outcome, unchanged original
remote checkpoint, one send, one original model call and zero replacement
model/tool executions. This is a process recovery proof, not a packed DSH Host
or online cloud-service proof.

`scripts/verify-studio-native-a2a.mjs --source <built-maintained-dsh> --archive
<Studio.tgz> --keep` additionally drives the actual packed `mountStudioHost`,
authenticated control RPC, production preset, DSH ToolRegistry and
SessionController with independent local HTTP model/discovery/JSONRPC-SSE
services. Node 26.5.0 and 22.19.0 both verify two actual model calls, one
discovery, one send, and zero GetTask calls for this terminal SSE fixture.

The complete Native tool intent and committed receipt, original numeric turn,
scope, Build, call/operation identity and private managed remote-task record
are mandatory assertions. The old actual Host PID exits; a different PID
resumes the original history without new input. The answer and completed turn
are present, execution events and tool admissions are unchanged, the entire
Native record compares canonically, and the full original managed-call bytes
remain unchanged. Both processes use a Node-only PATH. Original/cold record
files, request captures, hashes, PIDs and scope/Run identities are retained in
the evidence root. This uses the fixed installed dependency graph and a
graceful Host restart; the separate process test above covers SIGKILL. It is
not online cloud, fresh installation or Frozen deployment acceptance.

Still required for full migration:

- Frozen export/deployment coverage and the remaining product operations for
  this binding; the local packed Host and history path above is now verified.
- Authenticated product operations/UI to inspect, reconcile, continue and
  request cancellation of the original managed remote task. Input/auth pauses
  currently stop the Native call with an uncertain result and preserve its
  checkpoint; the product continuation flow is not implemented yet.
- Internal workload Actions, projected workload tokens, permits/credential
  broker, inbound A2A serving, and remote orchestration/handoff exposures.
- External peer credential schemes beyond the current hosted token path and
  any required v0.3 compatibility surface.
- Fresh Node-only dependency installation and the remaining legacy Python
  builtin replacement. The DSH Native/Codex A2A Node adapter is now present; its validation scope is
  described below. Other unmigrated builtin tools still use the old bridge.

These are explicit remaining capabilities, not supported fallback paths.

## DSH Native and Codex Node A2A tools

The local DSH/Codex preset now retains a copy of `spec.bindings.a2a` as well.
An explicit managed binding admits `list_a2a_agents`, `get_a2a_agent_card` and
`call_a2a_agent`, including an Agent with no other tool bindings. A conflicting
MCP/resource executor under one of those names rejects admission. The names
also remain available as explicitly selected builtins. A missing Node factory
fails with `A2A_NODE_PORT_UNAVAILABLE`, without trying the Python bridge.

`createDshNodeA2aTools` uses the original DSH Agent, Session, call ID and
arguments, with Host-fixed revision, Frozen Build and endpoint/credential/plan
bindings. It shares the AgentCard, HTTP+JSON/JSONRPC, SSE and terminal artifact
selection implementation with Native. Its contracts are distinct:

- `agentkit.dsh-node-a2a-tools/v1` for the Host port and locked binding;
- `agentkit.dsh-a2a-tools/v1` for the shared tool implementation;
- `agentkit.studio-dsh-a2a-host/v1` for managed remote-call checkpoints.

There is no fabricated Native Run, scope, task chain or execution fence. The
Host-private `builtin-workspace/a2a/` tree contains original DSH intents and
receipts and separate managed remote-call checkpoints. Both the original tool
intent and send marker precede sending HTTP. A duplicate finished call returns
its exact receipt; a lost owner or interrupted send returns uncertainty and
never resends. Changed Agent revision, Frozen Build, arguments or service
binding cannot reuse an old call. Another Agent/Session owns a separate call.
These records do not replace or rewrite the existing Native record format or
Native identity/binding digest.

The real DSH pre/guard/around/post pipeline remains in charge. Node dispatch
also checks the current sandbox standing policy and exact-call approval.
Cancellation, Host retirement or authority drift during approval/discovery
cannot continue into a send. Once sending may have started, uncertainty stays
JSON-persistable even if no task ID has arrived (`task_id: null`); the original
call locator remains authoritative. Remote task/context/projection checkpoints
are preserved separately. Never submit a new call ID merely to retry an
unknown send.

`tests/dsh-node-a2a-tools.test.mjs` uses real localhost HTTP/SSE, JSONRPC and
HTTP+JSON, UTF-8 chunk boundaries/duplicate event IDs, exact durable ordering,
policy/identity/version drift, concurrent duplicates, caller/Host/timeout
interruption, actual SIGKILL and a different Node PID opening the same records.
This deterministic peer is not an online managed service. Remaining product
inspect/reconcile/continue/cancel, auth/input pauses, inbound/internal control
plane, remote orchestration, Frozen deployment and fresh-install gates above
still apply. Other builtin tools still retain Python fallback.

The packed production Host verifier now exercises both DSH runtimes through
their real preset/SessionController/ToolRegistry, including policy denial,
exact-call approval, duplicate receipts and a different Host PID restoring
the original A2A records with zero new HTTP calls. Cold startup exposed an
async preset-registration race (`Unknown agent preset`); Host readiness now
awaits actual historical preset reconciliation. Deliberately delayed,
failed and retired registration tests cover that boundary. Node 26.5.0 and
22.19.0 each pass 138 affected tests and the packed local, refused-E2B and
whole-turn Native A2A checks. Native's deterministic model executes exactly
two model requests, one discovery and one send; cold recovery preserves
those counts and the complete Run record. These checks use a fixed installed
dependency graph; fresh installation and DSH/Codex model/CLI remain separate.
