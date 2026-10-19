# Cloud-bound native assistant input

The assistant page keeps its safe rich transcript, tool details, scoped Stop, files,
and live approval controls. A separate real Cordis Client graph renders only the
native conversation composer for the same cloud Session. It never retains that
Session on the desktop's Controller.

## Public interfaces and isolation

`Connection.installConnection({ transport })` feeds the public Typert registry,
Gateway, Remotes, SessionController, UI Session and renderer plugins. The input is
the official `conversation.content` factory, inside its official SessionProvider
with an actually retained SessionReference. Its views and width controls are
omitted through factory slots. Queue/Todo docks are shadowed through public slots
because the product transcript already presents their safe information.

Installing the Session service starts an asynchronous Host catalog read. The
cloud graph waits for the public `sessions.list` to become ready and include the
exact cloud identity before calling `retain`; an authenticated `native-open` id
alone is not a discovered Client Session. The bounded wait is cancelled with the
graph and releases its subscription; a missing identity or timeout requires
reconnection without creating a local Session or inventing a binding.

The graph does not install the stock page-global remote-access or Blob-upload
adapters. Its public service implementations start with no access, accept only
current-cloud-session display grants, and convert browser-selected Blob bytes
through the dedicated bounded attachment-upload channel. The cloud carrier still
enforces every RPC. No local workspace/navigation authority or default WebSocket
transport is available.

Patch 043 adds three instance settings with backward-compatible local defaults:

- `hostPathPolicy: upload-only`: selected files are uploads; no page-global Host
  path hook is read, and directory intake is rejected.
- `draftPersistence: memory-only`: native draft text, browser objects and inline
  image bytes are never written to global Session-ID draft keys.
- `submissionActions: queue-only`: unsupported native steer/stop gestures are
  disabled instead of silently changing their semantics. Product scoped Stop
  remains outside this composer.

Before creating any Context, the client parses the public `Config({})` and checks
all three patch defaults. A same-version Host without these fields is rejected
with an upgrade message before any binding, native input or local hook exists.

## Durable admission and recovery

Every carrier operation explicitly carries the same conversation (`personal` by
default), including upload, follow/poll/cancel and close. `native-open` supplies a
Host-authenticated journal scope tied to the deployment receipt and native Session.

Native inline images are uploaded first. The native request ID, full-content
fingerprint, timezone and cloud receipts are persisted before the receipt-only
prompt crosses the carrier. The carrier maps that request to durable submit plus
flush; native admission is never sent to an unguarded prompt endpoint.

Recovery entries are keyed by journal scope, Session and request ID. There is no
shared mutable index. Concurrent composers cannot overwrite a different unknown
ACK. Recovery also reads the original single-key format. Confirmation addresses
the exact pending request, removes only its acknowledged record and then exposes
the next pending record. No pending record means confirmation does not succeed.

After an unknown ACK, native input may restore its failed draft. Confirmation
compares its complete serialized content fingerprint and checks draft revision
and attachment IDs again after ACK. Only an unchanged matching restored draft
causes a memory-only graph rebuild, clearing that draft, its attachments and undo
history. Later user edits keep their existing graph. Receipt expiry is surfaced
as a deterministic not-admitted failure and requires explicit reselection.

Switching assistants, hiding the page or disposing the graph aborts read streams,
releases its actual SessionReference and closes the carrier. It does not cancel
cloud work. Late graph/open/upload results cannot enter the next assistant. A
legacy product draft keeps the native graph connected for live-approval presence
while its composer stays hidden until the older draft is handled.

## Evidence and boundaries

- `tests/assistant-native-transport.test.mjs`: bounded receipt conversion,
  unknown-ACK replay, cross-deployment isolation, multi-composer journals, legacy
  recovery, expiry, storage failure and cancellation.
- `scripts/verification/verify-assistant-native-graph.mjs`: real pinned DSH
  Connection/Gateway/Controller/SessionReference and native input with a controlled
  external carrier; same-ID Hosts, switching, release, local hook/draft isolation,
  file and image-only admission, unknown-ACK recovery, and the real ModuleLoader
  materializing the packaged browser entry.
- `scripts/verification/verify-assistant-native-ui.mjs`: real native transcript
  registries and React primitives, product attachments, live approval controls and
  dynamic permission notices.

The ModuleLoader test materializes the built browser factory and verifies its
client dependency boundary. It does not claim a full production Host boot or a
browser session. The graph tests use a controlled external carrier, not a real
account. Full release qualification additionally requires automatic Host startup and a real cloud browser flow; mocked carriers alone cannot establish those results.
