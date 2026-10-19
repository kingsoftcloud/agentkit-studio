# Cloud assistant interaction contract

This document describes the shipped adapter boundary against DSH
`687f282e8625c6b8d11ff58211a90524be2e4317`, including the repository's existing
product patches. DSH remains the Agent, Session, approval-audit and durable-submit
owner. These adapters do not implement another runtime or use `/v1/responses` for
the personal assistant.

## Current product capabilities

- Input uses the existing cloud-owned durable submission path. Its receipt is
  acknowledged only after the DSH persistence flush.
- On capable images, `capabilities.composer` advertises the bounded native carrier.
  An isolated cloud Client graph owns a real SessionReference and native input.
  Its prompt facade still delegates to durable submit plus flush; older images
  retain the capability-driven custom input without a fake native binding.
- `personal-assistant-approval-bridge/v1` advertises the existence of the scoped
  API, not permission to perform interactive actions. The authoritative UI flag
  is `snapshot.capabilities.approval.interactive`.
- New, explicitly selected `workspace-managed/v1` assistants use the native
  workspace-write/ask profile and an online-presence-gated approval bridge. Existing
  Sessions are not migrated. See [the permission model](assistant-permission-model.md)
  for exact routine/sensitive tool admission and confinement limits. The approval
  bridge itself does not change policy or create credentials.
- `capabilities.localHandoff` remains false. `localHandoffDetails` explains
  `executor-unavailable` and `executesLocally: false`. No production local executor
  is installed or contacted.

## Why the existing local native composer cannot be reused as a cloud binding

The following are public upstream contracts, not inferred names:

1. [`SessionReference` and `ISessions`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/client/contract/sessions.ts)
   retain one exact Client generation using a Session id or direct-parent
   subagent address. A reference has `sessionId`, `binding`, `ready` and release;
   neither retain nor the reference carries a second Host or endpoint selector.
2. [`ClientSessions`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/client/sessions/service.ts)
   constructs its manager from one `SessionRemotes` collection. Consequently,
   retaining a cloud id in the existing local Controller addresses the local Host.
3. [`UiSession.bindingSource`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-session/src/client/index.ts)
   checks `sessions.binding(reference.sessionId) === reference.binding` and rejects
   foreign or retired Controller bindings. `uiSession.provide` contributes
   standard props to those bindings; it does not install another transport.
4. [`ConversationContent`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx)
   reads Session, input, pending interactions and workspace sources. Its
   `conversation.content` factory is an assembly extension, not a standalone
   textarea with an arbitrary submit callback. The public `/client` entry exports
   Composer types, not an independently callable Composer component. Native
   `Session.prompt` dispatches through that Controller's `remote.session.prompt`;
   picked files use the same Host's session-addressed file-upload service.
5. [`ConnectionInstallOptions`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/client/index.ts)
   does support a composition-owned RPC/stream carrier. Thus this is not a claim
   that DSH cannot connect to a remote Host. The product now installs an isolated cloud-bound Client service graph,
   an authenticated allowlisted carrier, Remote events, session control/history
   streams, receipt upload transport and teardown. It exposes only the required
   assistant endpoints, never a general-purpose owner Gateway.
6. Connection generations are local monotone ids. Upstream `ConnectionHostInfo`
   contains a display home directory; it is not a globally authenticated Host id.
   A matching Session id, generation number or home path cannot prove cross-Host
   identity.

The product reuses public Cordis-free primitives such as `Button`, `StateDot`,
`FileTypeIcon` and `RiskConfirmation` where appropriate. It must not manufacture a
`SessionReference`, hijack the current local selection, or import private Composer
implementation files or substitute the local graph for the cloud graph.

## Live approval adapter

`createAssistantApprovalBridge` in `src/assistant-approval-bridge.mjs` consumes the
official [`approval/request` waterfall](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/user-approval/src/types.ts).
DSH enforces `never` before dispatch and owns the `approval/asked` and
`approval/decided` audit pair. The live event has an Agent, tool name, optional call
id/reason/localized display reason, and cancellation signal. It contains neither
tool arguments nor the audit request id.

Construction accepts `ctx`, a trusted Host identity, an exact `ownsSession`
predicate, `enabled` (false by default), a trusted `policyOf` callback (never by
default), locale, and bounded request lifetime. The personal-assistant runtime
recognizes only ids derived through its agent/build/conversation mapping; it does
not use an `assistant-` prefix as ownership proof.

The API is:

- `snapshot(sessionId)` returns `{ capabilities, pending }`.
- `decide(sessionId, input)` resolves only a current request.
- `disconnect(sessionId)` withdraws that Session's questions as unavailable.
- `dispose()` withdraws all questions and unregisters the listener.

Each pending item carries:

```js
{
  kind: 'approval', requestId, generation, hostId, sessionId,
  turn, turnStartSeq, toolName, callId,
  reason, displayReason, presentation, canAllow,
  expiresAt, choices: ['allowed-once', 'rejected']
}
```

`callId`, `reason` and `displayReason` are optional. `presentation` prefers the
selected localized display reason, then English, then the reason. Credentials are
redacted and content is bounded. Without readable action details, `canAllow` is
false and `choices` is only `['rejected']`; a direct forged allow request also
fails with `details-unavailable`. No missing arguments are filled from history.

The runtime exposes pending items as `snapshot.pendingInteractions`. The client
may show controls only for this live collection, with an interactive capability
and matching `choices`. It sends the pending identity fields plus `decision` to
`approval-decide`. The authenticated Node route derives the conversation's Session
independently; request ids are correlation ids, not authentication credentials.

Before settling, the adapter synchronously verifies the exact live Agent object,
Host, Session, bridge generation, turn number, turn start sequence, lifetime,
signal, and effective policy. There is no await between this check and settlement.
Double clicks, retired questions, other conversations, replaced Agents and prior
bridge generations cannot grant permission. Responses acknowledge a live answer,
not completed tool execution or durable approval audit persistence.

Historical audit rows remain read-only. Starting a new adapter never restores
pending requests from them. Production managed mode requires an observed native
ready event and successful event consumption; carrier close, stream loss, disposal
and the 35-second presence deadline withdraw pending questions. Snapshot polling
alone does not prove this presence. Closing the assistant and disposing its
Context dispose the adapters. Withdrawal does not cancel unrelated queued work.
Presence permits asking; only the exact native allowed-once decision grants the
individual supported sensitive invocation.

## Local handoff protocol and controlled simulator

`createAssistantLocalHandoff` in `src/assistant-local-handoff.mjs` exposes
`capabilities`, `snapshot`, `offer`, `validate`, `execute`, `cancel`, and `dispose`.
Production supplies no executor. It therefore rejects offers and execution before
any action; no approval boolean can enable it.

The controlled test executor is explicitly `kind: 'simulation'`. Version one
accepts only a bounded `read-file` intent with a relative path. Absolute paths,
traversal, URL/shell commands, extra credential/permission fields and unbounded
reads are rejected. It never opens the file.

An offer binds the immutable action digest to the source Host, Session, Agent,
turn and turn-start sequence, bridge generation, exact target executor and its
connection generation, and an expiry. A trusted user-facing confirmation callback
receives that exact offer; `approved: true` in a wire payload is not permission.
After confirmation, the adapter rechecks all scope and target facts before
dispatch. It retires the offer once; unknown outcomes are never blindly retried.
Disconnect/reconnect, new turns, cancellation, expiry and disposal fail closed.

Every simulator receipt states `simulated: true` and `executed: false`, and binds
its request, target generation and action digest. The module rejects other
executor kinds. Supporting actual desktop execution remains a separate authorized
integration requiring a verified executor connection, its user confirmation and
matching permission boundaries. This implementation does not connect a computer,
create credentials, grant persistent access or execute anything on a desktop.

## Verification

```sh
node --test tests/assistant-interaction-bridge.test.mjs
AGENTKIT_DSH_ROOT=/path/to/isolated-built-dsh node scripts/verify-assistant-interactions.mjs
```

The first command covers adapter failures, stale/replayed ids, scoped runtime
assembly, disposal and simulation. The second uses real built DSH Agent, Session,
turn projection and ApprovalService instances, verifies same-named Sessions on
two Hosts, native audit outcomes, native `never` enforcement, cancellation and
history non-revival. It records the pinned commit and whether existing product
patches modify the checkout. It makes no model, account, network or desktop calls.
This evidence is not a real desktop execution or a deployed interactive-approval
qualification.
