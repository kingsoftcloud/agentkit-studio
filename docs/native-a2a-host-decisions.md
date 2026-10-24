# Host decisions for managed remote approvals

The internal outgoing A2A canonical path now binds explicit human controls to
the actual Host approval audit. A remote `ksadk_interaction` hint is presentation,
never a local permit. Native and independent DSH owners share this implementation.

`requestStudioA2aApproval({ requireReceipt: true })` observes the exact real
Session's `approval/asked` and `approval/decided` pair, including the original
tool/call/reason, service-issued request ID and physical Session sequence
(zero is valid). It rejects absent, foreign, duplicate or contradictory audit
pairs, a replaced approval service, changed turn/preset/authority, aborts and
failed durability barriers. The audit observer is removed on every exit.
Only `allowed-once` is a grant. Policy rejection, unavailable answerers and
withdrawn consent do not become remote approval decisions.

The private `agentkit.a2a-host-decision/v1` receipt contains the original Session,
preset, request/call/tool IDs, request digest, outcome and audit positions.
Authenticated client requests cannot submit receipts or authority fields.
Host adapters bind the receipt to the complete original control command digest;
the source publication checks the exact still-pending interaction and pause.
The receipt is not a reusable execution credential.

While admitting a control under the original call's short publication lock,
the Host atomically fsyncs the complete effect intent, first-wins decision,
canonical `interaction.resolved`, immutable event journal and outbox. No remote
task operation enters before this commit. A failed commit admits no effect.
Both existing remote Append and Studio Session delivery consume the same fact;
neither consumer controls the Native loop or appends a Native tool receipt.

The optional task-view capability `agentkit.a2a-remote-approval-control/v1`
advertises the original interaction, preview and any committed decision:

| Human control | Required input | Local canonical decision | Remote operation |
| --- | --- | --- | --- |
| Approve | `continue`, exact pause digest, `[{ data: "approve" }]` | `approved` | Supplemental SendMessage on the original task/context |
| Reject | `reject`, exact pause digest, no parts/JSON | `rejected` | CancelTask, then original GetTask confirmation |
| Cancel | Existing `cancel` command | `canceled` if the approval is still pending | Existing cancellation/confirmation path |

Explicit rejection requires fresh Host consent for that exact operation. It
never sends a supplemental `reject` message. Declining the local permission
question itself does not authorize a separate cancellation. Unsupported or
unconfirmed remote cancellation does not imply remote success; the committed
local rejection remains visible. Continue retains the original deadline.

After a process dies with an admitted command, confirmation returns its prior
result or an unknown outcome. Neither the durable decision nor a fresh command
ID permits replay of that effect. An explicit original GetTask can reconcile
remote status. This can conservatively leave an approved-but-unsent command
unknown after a pre-transport crash; there is no exactly-once claim or automatic
resend. The existing independent Native receipt reconciliation remains required
before continuing an interrupted Native Run.

A confirmed supplemental response may ask the identical question again. A
trusted continuation command gives this a distinct canonical interaction;
repeated GetTask/notification observations cannot create another opportunity.
Actual remote progress may close a continuation, but never supplies an approval
decision. Studio's task panel offers explicit approve/reject controls; the common
observation renderer displays committed decisions without action controls.

Verification commands (run against the package being evaluated):

```sh
node --test --test-concurrency=1 tests/native-a2a-decision.test.mjs tests/native-a2a-decision-crash.test.mjs tests/studio-a2a-control-approval.test.mjs tests/native-a2a-panel.test.mjs
node scripts/verify-a2a-host-decisions.mjs --source "$DSH_SOURCE" --evidence "$EVIDENCE_FILE"
```

The service verifier uses actual maintained Session/Projection/Approval services,
real Node transport/journal/delivery, controlled answerers/HTTP peers, a minimal
agent containing the real Session, and an explicit fsynced file test carrier.
Process tests use actual SIGKILL across distinct PIDs, with a declared Host
receipt double; they independently prove no effect replay before transport or
after remote application. These are not mounted Studio Agent/controller,
live-human/browser/Electron/online-service or fresh-install acceptance.

Still open: automatic managed approval/input waiters, durable explicit expiry
facts and invocation-policy audit parity, inbound/subscription assembly, legacy
public producer coverage, and full product-entry acceptance. The complete
migration remains incomplete; this document does not narrow its scope.
