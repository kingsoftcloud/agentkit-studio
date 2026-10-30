# Native A2A Node integration

Reference: read-only `ksadk-python`, branch `feat-ksadk-harness-2`, commit
`355059d78e47ed764bbdb3606304cdf34e9838a3`. This implementation covers the
AgentCard-driven outgoing tool path and optional internal outgoing
registry/permit/credential/task binding described in
[internal A2A](native-a2a-internal.md). It does not yet complete the entire A2A
product, all subscription consumers or inbound server migration. Explicit
original-task subscriptions are now wired as described below.

## Explicit original-task subscriptions

The authenticated Native and DSH/Codex task controls accept `kind: subscribe`.
The existing task panel exposes **观察远端进展** after reading a Host that advertises
`agentkit.studio-a2a-task-subscription/v1`. It observes the original remote task;
no model prompt, replacement task or second execution loop is created.
**停止观察** aborts only this read, without requesting remote cancellation.

Public AgentCard routes use `SubscribeToTask` JSON-RPC or A2A 1.0 REST
`POST /tasks/<id>:subscribe`. Internal routes first persist a preparation intent,
request `PrepareA2ATaskOperation` with `subscribe_to_task`, validate the original
target/version/task/context and obtain fresh workload/broker credentials. A
route without streaming support fails explicitly before peer transport. Existing
resource/permission bindings apply, and this read cannot approve or continue a
remote interaction. The control view's additive subscription contract leaves
existing task-control v1 consumers and sealed tool receipts intact.

The private control marker is durable before network admission. Each frame is
validated and checkpointed through the original projection; internal canonical
facts enter the existing durable outbox and Studio Session consumer. Stream-local
SSE IDs are scoped to this observation, while duplicate/conflicting IDs within
one observation retain their existing checks. Terminal notifications are hints:
one `GetTask` of the same task confirms the result and final content. EOF while
that snapshot is working remains working. Missing/failed confirmation cannot
invent a terminal receipt. Late observations cannot replace a confirmed terminal.

Observation uses the existing bounded 90-second control lifetime and stream
limits. It stops at EOF, a wait/terminal hint, disconnection, cancellation or
deadline; a fresh observation is explicit. It does not provide a permanently
reconnecting SDK subscription. A crash leaves its durable marker unresolved,
and replacement Hosts do not reconnect or replay Send/Cancel. Remote cancellation
uses its independent lock and still requires exact-command consent. Unknown
write commands remain independently recorded while observations run.

Directed tests cover actual Actions/JSON-RPC/REST/SSE/token files/SQLite for
Native and independent DSH ownership, public DSH/Codex product routes, wrong
bindings, unsupported streaming, EOF/terminal confirmation, permission loss,
concurrent cancellation and noncooperative transport cleanup. Two real SIGKILL
boundaries prove cold no-reconnect behavior. The packed mounted Native busy-cancel
verifier now also observes the live original task through authenticated RPC and
UI state before cancellation. These fixtures use controlled services and model
responses; real browser/human, online service and all incoming/subscription
consumers remain separate acceptance gates.

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

Native commits its tool intent before entering the gateway. After trusted
discovery the A2A service allocates an immutable local `a2a-task-*` handle and
persists `prepared`, with the explicit `agentkit.a2a-send-admission/v1` storage
contract and original absolute deadline. Dispatch must atomically admit
`prepared` to an fsynced `sending` marker before entering the network. State is stored outside the
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
The optional internal control-plane path additionally confirms a terminal
notification with the original `GetTask` before declaring its artifacts complete;
see [canonical content and delivery](native-a2a-internal.md#canonical-lifecycle-journal-and-delivery).

An approved cancel that wins the same short state lock before send admission
commits a local terminal and the command receipt together. Its outcome is
`local_cancelled_before_send`; there is no SendMessage, GetTask or CancelTask.
If send admission wins, cancellation uses the existing remote-task path.
Interrupted prepared calls require an explicit original dispatch, with its
original authority and deadline; opening history alone never sends them.
Existing `sending`/unknown records are never reclassified as prepared.

Repeated admission after send entry replays its stored result. It does
not rediscover or send again. Interrupted sends remain unknown, including a
crash after the marker but before the actual send. Unknown state never grants
permission for a replacement send. Cancellation aborts local waiting and
preserves the original remote locator; it does not assert that the remote
agent was cancelled. Do not create a new call ID to retry an unknown effect.

## Explicit original-task controls

The shared Node Host now exposes `owner.control.execute()` under
`agentkit.studio-a2a-task-control/v1` for Native **and independent DSH** owners.
It accepts `get`, `continue`, and `cancel`, a stable `commandId`, the original
`operation_locator`, and a fresh Host authority. Both `assertControl` and
`authorizeControl` must be provided by the trusted Host. A retired Native tool
fence cannot authorize a control; the original execution guard remains required
for the original tool path. No control accepts a caller-selected route,
credentials, remote task ID, or replacement target/version.

The Studio Native product route is `sessions/native-a2a-control`, exposed as
`controlNativeA2aTask(payload, signal)` on HTTP and authenticated DSH RPC clients.
Its payload has `agentId`, `sessionId`, `runId`, `operationKey`, `callId`,
`kind`, and `commandId`. A continuation additionally supplies the current
`pauseDigest` and either `parts` or `json`. `json` is the **original JSON text**
for one data part: the Host parses it with its exact-number parser, preserving
unsafe integer tokens through approval, persistence, cold replay, and wire
serialization. Text, object, scalar, array, and null data inputs are supported.
There is a 64-part / 1 MiB complete-message limit, matching the reference.

The product service resolves the actual Session, checks the original Native
tool intent and recovery capsule, and requires the same trusted preset revision
and Frozen Build. Fresh human `continue`/`cancel` commands always request exact
command consent through the real approval service, including under
`workspace-write`. Confirming an existing sending/unknown/resolved command is
a read and does not request another approval. A queued, not-yet-delivered cancel
requires fresh consent on explicit retry. The shared transport still checks current authority,
private storage identity, the original remote task/context pair, and the
original pinned route. A changed binding cannot reuse a checkpoint.

Before a continuation/cancel can enter the network, its complete DTO, stable
message ID and command digest are fsynced under a short state transaction.
The original send/continuation, task reads, and cancellation have separate
long-lived SQLite locks. An identical sending/unknown/resolved command confirms
its stored outcome; changed reuse rejects. A crashed/lost send is never sent
again, even after cold restart. `get`
observes the original task without rewriting the unknown effect's intent.
Another continuation ID cannot retry an unresolved send for the same remote
pause. A confirmed continuation can legitimately return the identical question;
the persisted pause generation distinguishes that new input opportunity from
the old command, even when the peer reuses its message ID. A new continuation
also retains the original admitted absolute deadline; approval and Host restart
do not reset it. Legacy records derive that deadline from their creation time
and original timeout. Records are limited to 64 MiB, projections to 8 MiB, and
the per-call command inventory to 10,000 entries; exceeding limits fails closed.

Remote cancellation is confirmed only after `CancelTask` **and a validating
`GetTask`**. Concurrent completion is reported as `already_terminal`;
unsupported cancellation and uncertain cancellation remain distinct outcomes.
The CancelTask reply's terminal observation is persisted before confirmation;
a subsequent contradictory terminal is rejected rather than overwriting it.
Aborting local waiting never fabricates a remote cancelled state. Reads and
cancellation can proceed while the original stream or continuation is busy.
Before the remote task ID is known, `get` returns the local checkpoint with
`outcome=remote_task_not_bound`; it does not send a remote query. The Studio
state accepts this explicit outcome and enables cancellation. An approved cancel
is durably `queued` before waiting for the original task binding. After a caller
or Host exits, the exact same queued command can be explicitly retried with
fresh authority and consent; it is not automatically delivered on startup.
The fsynced `sending` marker is the no-retry boundary before CancelTask.
Denied cancellation retains the client command ID so a retry can obtain fresh
consent rather than creating an unrelated command.

Every state write re-reads the original record under the short lock, preserves
other commands, checks command-ID conflicts, and retains a newly bound task and
confirmed terminal against stale stream/read snapshots. A different terminal
is rejected. Continuation admission checks pending cancellation atomically
under that same lock; an already admitted continuation may subsequently be
canceled. This does not promise exactly-once effects or atomic remote execution.

In Studio, open **运行与子任务**. The original Run's A2A calls have explicit
**核对远端任务**, **请求远端取消**, and text/JSON supplemental-input controls.
Remote questions and output are visible. A lost response retains the original
command for **确认原操作回执**; refresh never sends a replacement message.
These controls manage the remote task. They deliberately do not invent a
successful Native tool receipt or resume an interrupted Native Run. The
remaining Kernel interaction/reconciliation flow must consume the verified
outcome through a real execution boundary before that Run can continue.

Control verification is in `tests/native-a2a-controls.test.mjs` (actual HTTP,
both bindings and both owner contracts), `tests/native-a2a-control-process.test.mjs`
(four actual SIGKILL/replacement cases), `tests/studio-native-a2a-control.test.mjs`
(production Kernel/SQLite/gateway/service/route with declared narrow DSH
doubles), and `tests/native-a2a-panel.test.mjs` (state, deterministic hook render,
HTTP/RPC contracts). This is not a browser/Electron or cloud-service proof.

Pre-send coverage lives in `tests/native-a2a-busy-cancel.test.mjs` (Native/DSH,
JSONRPC/HTTP+JSON, denial and deadline) and `tests/native-a2a-presend-process.test.mjs`
(independent processes: either admission wins, SIGKILL after preparation,
local terminal before acknowledgement, and sending marker before transport).
These tests use real private storage, SQLite locks and local HTTP/SSE peers;
they do not claim browser or online-service acceptance.

Busy coverage additionally lives in `tests/native-a2a-busy-cancel.test.mjs`
(both transports/owner contracts, unknown/bound task, late reads/streams and
command conflicts) and `tests/native-a2a-busy-process.test.mjs` (a separate
original stream process remains live while the control process is SIGKILLed
before delivery or during an applied/unapplied CancelTask). Replacement PIDs
reapprove only queued commands and never resend an entered cancel. Two further
cross-process cases pause a continuation after its observation is persisted:
a concurrent queued cancellation or confirmed terminal prevents its sending
marker and HTTP request. Admission also validates the latest pause generation.

`verify-studio-native-a2a.mjs --busy-cancel` uses the full mounted Host, actual
SessionController and ApprovalService, authenticated HTTP controls and the
product UI state controller. A controlled HTTP human answerer produces the
real durable approval asked/decided pair. The original stream remains open
during cancellation; after confirmation it emits a stale WORKING event. The
original Native Run completes with the verified cancelled tool result, one
Send and one CancelTask. This is deterministic integration, not live human or
browser approval, Electron, fresh installation or an online A2A service.

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
- Full browser acceptance of the authenticated task controls and automatic
  structured-input/remote-approval waiters in the original Native Run. The
  manual original-task API/panel and explicit same-Run receipt reconciliation
  are implemented, including full mounted-Host busy cancellation and cold
  recovery evidence. Input/auth pauses require those explicit controls;
  [active Native receipt waiting](native-a2a-receipt-wait.md) now automatically
  requests same-Run reconciliation after a committed terminal fact. Unattached
  cold Host turns and unknown outcomes still require explicit recovery/query.
  DSH/Codex have authenticated product
  controls and local task inventory as described below; real browser and
  live human/service acceptance remain separate.
- Required task stream subscriptions; pre-send local cancellation and busy-call
  durable cancellation delivery are now implemented with separate process proofs.
- Internal workload Actions, projected workload tokens, permits/credential
  broker, inbound A2A serving, and remote orchestration/handoff exposures.
- External peer credential schemes beyond the current hosted token path and
  any required v0.3 compatibility surface.
- A fresh full installation/proof of the current maintained Host graph, full
  Electron/other-platform checks and real model/CLI regressions. Ordinary
  Python builtin fallback has already been removed; Desktop Node Office and
  resources have separate evidence. That does not prove every backend,
  configuration or product combination; see [current status](native-migration-status.md).

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
receipt reconciliation, automatic auth/input waiters, inbound/internal control
plane, remote orchestration, Frozen deployment and fresh-install gates above
still apply. Ordinary local builtin dispatch uses Node ports and fails closed
when a required executor is absent.

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

## Studio controls for DSH and Codex tasks

Local DSH Native and Codex conversations expose **A2A 远端任务** in the header.
The inventory reads only original local call records, with 64-item pages and
an inventory digest. Opening or refreshing it never discovers a peer or sends
GetTask. Choose an individual task to inspect its remote state, provide input
or cancel. Native whole-turn Runs retain their **运行与子任务** controls.

Authenticated operations `sessions/dsh-a2a-history` and
`sessions/dsh-a2a-control` use `agentkit.studio-dsh-a2a-inventory/v1` and the
shared task-control response. Their identity is the original Agent, Session,
call, Agent revision and Build; callers cannot supply a Native Run or scope,
authority, remote URL or credentials. Inspection may expose historical
revisions; effects require the exact current original binding. Original DSH
tool receipts remain immutable when the remote task is continued or canceled.

Every new write requires exact-command approval, including workspace-write.
With a closed conversation, the Host owns a separate
`agentkit.a2a-human-control/v1` external turn, flushes ownership before asking,
and commits the approval audit and turn ending before returning a grant.
No model call or replacement Native Run is created. An interrupted approval
turn is resumed only by explicit control under the same preset and asks fresh
consent. The remote command ledger still determines whether any effect may be
sent; confirming an entered or finished command never resends it or asks again.
During an original open turn, approval uses that audit log; if the turn closes
while consent is pending, the grant is discarded and the operation must be
confirmed again. Host retirement, request cancellation, policy or binding drift,
and failed durability checks prevent a new effect.

`verify-studio-dsh-a2a-controls.mjs --source <built-maintained-Host> --archive
<Studio.tgz> --keep` exercises the packed production preset, ToolRegistry,
SessionController, ApprovalService and authenticated routes for DSH Native and
Codex, including a closed-history continuation, busy cancellation, cold audit
restoration and duplicate confirmation. Add `--crash-approval` to kill the Host
while approval is pending, resume the same owned approval turn in a new PID,
ask fresh consent and confirm exactly one continuation. These checks use a
controlled HTTP peer/answerer, Node-only PATH and existing linked dependencies;
they do not prove real browser/human, model/CLI, online service, Electron,
Frozen deployment or a fresh installation.
