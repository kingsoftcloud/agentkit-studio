# Managed A2A structured input decisions

The existing Studio task panel now exposes the optional
`agentkit.a2a-remote-input-control/v1` capability for managed outgoing A2A
questions. It contains the original canonical interaction/continuation IDs,
request schema and any committed decision. Native and independent DSH owners
use the same implementation. The internal Host binding includes
`agentkit.a2a-host-input-decision/v1` in its digest, so recovery/Build binding
checks identify this behavior explicitly.

`continue` requires the exact current pause digest and one data part. The Host
normalizes a single `{result: value}` UI envelope only when the original schema's
type is not `object`, matching Python `runtime_input._structured_input_value`.
Object schemas preserve a `result` property. Unwrapping happens once, including
nested result objects. The normalized value must satisfy the requested schema;
validation uses the existing exact-integer-aware JSON Schema compiler. External
schema references and async schemas cannot fetch resources. Unsupported schemas
fail before asking for an execution grant. Studio's Python submission layer also
validates input schemas (`studio/interaction_submission.py:112–122`); its lower
level managed waiter itself only unwraps input.

The normalized command is the common input to the Host approval reason, command
digest, persisted effect intent, canonical answer and remote supplemental
message. A bare `allow` callback is insufficient: the real Host adapter requires
the original Session's durable `allowed-once` audit receipt, as described in
[Host decisions](native-a2a-host-decisions.md). Local denial, unavailable
answerers, abort and failed audit persistence authorize neither an answer nor a
remote cancellation.

Under the original call's publication lock, first-wins input decision, complete
effect intent, immutable `interaction.resolved` and outbox are atomically fsynced
before transport. The response contains the actual answer. Source metadata
records `host_outcome=submitted`, or `canceled` for an explicit approved
cancellation. A submitted JSON `null` is distinguished from cancellation by
this outcome. Remote status alone cannot overwrite a committed answer or append
another resolution for it. An observation without a Host decision retains the
existing remote-progress resolution semantics; it is not an answer receipt.

A confirmed continuation that asks the identical question again creates a new
interaction generation. Repeated reads cannot do so. Repeating an old command
after a new question or Host restart uses its original schema and returns its
prior result; conflicting content is refused. An unknown send is never retried,
even with a fresh command ID. Original-task GetTask remains an explicit read.
This may conservatively leave a decided-but-unsent input unknown after a crash;
there is no exactly-once claim.

The panel sends strings as JSON data (including an empty string), requires JSON
for other schemas, and hides the composer after a committed decision. It keeps
the original command for uncertain-response confirmation. The common inert
observation renderer displays the committed outcome without exposing answer
content or adding action controls.

Relevant validation:

```sh
node --test --test-concurrency=1 tests/native-a2a-input-decision.test.mjs tests/native-a2a-decision-crash.test.mjs tests/native-a2a-receipt-wait.test.mjs tests/native-a2a-panel.test.mjs tests/a2a-observation-view.test.mjs
node scripts/verify-a2a-host-decisions.mjs --source "$DSH_SOURCE" --evidence "$EVIDENCE_FILE"
```

The service verifier uses actual maintained Session/Projection/Approval services
and actual A2A transport/journal/delivery, with controlled HTTP peers/answerers,
a minimal agent containing the real Session and an fsynced test carrier. Genuine
SIGKILL tests cover before-transport and after-remote-apply boundaries in Native
and DSH, with explicitly declared audit doubles. These prove distinct parts of
the boundary; they are not live-human, browser, online-service, Electron or fresh
installation acceptance.

Still required for full migration: automatic presentation and waiting under the
original Run/deadline, separate durable question answers before supplemental
operation permission, explicit expiry/withdrawal facts, ordinary-input rejection
(Python raises `A2A_INPUT_REJECTED` without automatically canceling the remote
task), initial invocation-policy audit parity, cold Host reattachment, child
waiters, subscriptions/inbound assembly and the remaining full capability and
Studio entry-point acceptance gates. This explicit-control increment does not
complete those requirements or the overall migration.
