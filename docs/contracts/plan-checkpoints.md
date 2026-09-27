# Studio plan checkpoints

This file records decisions made when the implementation is compared with the original
P0/P1 plan. It is intentionally short and evidence based.

## 2026-09-24 — product surface checkpoint

### Signal

The first browser slice proved that a `main` slot and a Settings slot could load, but it
looked like a DSH plugin page with a few status cards. Adding more independent plugin pages
would have made the product boundary worse.

### Decision

Keep Studio product navigation in the official DSH sidebar, directly below New Session. The
sidebar now has first-class rows for Overview, Agents, Runtime, Resources and Delivery, one mark,
one palette and one Host status model. DSH remains the host for conversation, session, workspace
and Dock state; those responsibilities are not copied into the shell.

### Acceptance evidence

- Official Web profile on port 3098 rendered five Studio rows through DSH `sidebar.panellist` and
  five keyed `main` slots, with the unchanged DSH workspace/session region immediately below.
- The official brand slots now render the AgentKit Studio mark/name, and the Studio profile
  disables the generic Plugins panel so the global panel list contains only the five Studio rows.
- The Settings modal contains a native AgentKit Studio section through `settings.section`.
- No action claims a connected Host while the real health/capability Remote is absent.

### Next gate

Before enabling create/build/deploy controls or adding more visual areas, connect the typed
KsADK Host health/capability Remote and feed its capability snapshot into the shell. Static
cards are not a substitute for that gate.

## Release presentation rule

The Web profile is a development and validation surface, so the DSH session/workspace frame may
remain visible in browser evidence. The distributable Desktop profile must launch directly into the
Studio panel, use the AgentKit Studio product title and app mark, and keep the generic plugin
manager out of the primary user flow. The official DSH Electron and Host lifecycle remain reused
underneath.

The existing checked-in Web dist still carries the fixed DSH fallback document title. The release
build must set `DSH_CLIENT_TITLE=AgentKit Studio` while building the official Web/Desktop assets;
this is a build input, not a runtime title hack in the Studio plugin.

## 2026-09-27 — Agent selection and Teams checkpoint

### Signal

The Agent selector could display a label while the sandboxed DSH `srcdoc` frame could not safely
read the Host catalog. A direct cross-origin fetch would fail before the Host could authenticate
it, and treating an Agent ID as a DSH preset would silently run the default DSH composition.

### Decision

Use the public DSH Connection/WebServer boundary for a narrow read-only `/agentkit/agents/list`
catalog seam. Keep the selector visibly labelled `候选智能体` and the selected value marked
`未绑定当前会话` until an explicit
`AgentRevision → DSH admission/provider` contract exists. Do not inject InputHub or
SessionCommandController and do not add a second conversation state machine.

Enable Agent Teams by default only in the version-pinned AgentKit `agentkit-ui` profile. The
upstream DSH Team packages remain opt-in. Official tests and the live DSH composer smoke are
recorded in `agent-teams-2026-09-27.json`.

### Next gate

The Host-owned route is now proven for a real DSH Native Build: the rc.2 SDK-backed runtime
returned a canonical SSE stream ending in `run.completed` (see the 2026-09-27 evidence record).
The remaining product gate is to expose that route from an Agent card/conversation entry while
keeping the official DSH composer honest. Do not turn the current context selector into a fake
`session/prompt` retargeter. Codex and KsADK bound-Agent entries need the same typed stream proof
before they can be advertised as selectable execution targets.

### User-facing selection rule

Until that entry is shipped, the selector visible in the official DSH composer is intentionally
labelled `候选智能体`; a selected value shows `未绑定当前会话`. It can be used to remember
which Agent the user is preparing to run, but a
message sent from that composer still belongs to the unbound DSH session. The eventual flow is:

1. open `Agents` and choose a concrete Agent Revision;
2. choose `打开绑定 Agent 对话` (Host-owned route), which creates or resumes a canonical Session
   for that Revision;
3. send messages in that route and observe the typed SSE stream; or choose `无 Agent · DSH 原生
   会话` and use the unchanged DSH composer.

This wording is part of the acceptance boundary. A catalog option or a successful DSH-native
Team tool call is not evidence that Codex or KsADK execution has been admitted into the DSH
composer.

## 2026-09-27 — Studio-owned harness feasibility checkpoint

### Signal

The local product still needs a provider path that does not make `ksadk-python` or a Python Host a
mandatory Studio dependency. The real bound-Agent DSH Native route now works through a Host-owned
canonical stream, while Codex remains blocked by provider registration and dynamic
AgentRevision admission is still open.

### Decision

Treat a **Studio-owned Node/TypeScript Host runtime** as a time-boxed provider spike. It may own
the local model loop and use DSH's public provider/agent or JSON-RPC boundaries, but it must not
run in React, inject `InputHub`/`SessionCommandController`, or create a second transcript store.
The server remains the control plane and bound sessions still emit `CanonicalEventEnvelope` events
to the server. `ksadk-python` remains an optional sibling runtime until the Studio-owned spike
passes resource, approval, recovery and cloud ownership gates.

### Acceptance boundary

- P0: create a local model-only Agent, stream through the Host canonical route, cancel, reload and
  recover without Python.
- P1: add DSH public tools/MCP/Skill, approvals, reconnect/dedupe and one real resource binding.
- P2: evaluate knowledge/memory, Teams, Schedule/Channel, evaluation/observation and cloud image
  parity. Unsupported capabilities must be declared rather than silently falling back.

The full option matrix and dependency accounting are recorded in
`../../../.scratch/studio-dsh-native-2026-09-24/studio-owned-runtime-feasibility-2026-09-27.md`.
