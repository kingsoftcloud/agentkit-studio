# Native completed-turn cloud Memory

This preserves Studio's existing `memory-instance` resource binding when
`runtime.type = "harness"` selects Native. It is separate from Python Native's
`local-default` candidate/recall/management owner, which remains unchanged.
Previously `studio_native_memory_write_port_unavailable` rejected the entire
Native turn when the existing Studio policy enabled post-turn cloud submission.

The shared Host now binds `agentkit.studio-native-cloud-memory-turn/v1` for
that policy. Revision and Frozen admission use the same binding. The original
`candidate`, `explicit_only`, `off` and disabled-Memory decisions are shared
with `local-runtime.mjs`; direct remember instructions retain the original
`Flush` flag. No extra model or execution loop is created. Managed execution
already consumes the shared Host's completed-turn callback; no separate writer
is installed for it.

## Ownership and persistence

`bindMemoryWriter()` captures the trusted resource client's configuration in a
private closure. Its public transport descriptor contains the fixed origin,
region/environment/traffic source and a principal digest. Credentials are not
copied to the Native ledger or effect journal. The descriptor and resource
policy participate in the Host binding digest. Later settings cannot move an
already admitted write to a different service; a cold Host must reconstruct
the matching binding. Credential-reference changes that change that principal
digest require new admission rather than silently changing the original Run.

Only a canonical completed snapshot, matching its stored configuration digest,
scope, Session and original recovery capsule, can be consumed. Both the direct
Managed binding and the DSH whole-turn wrapper digest are checked. Interrupted,
canceled, blocked, failed and budget-exhausted outcomes do not submit. Background
notification configurations have no original user input and cannot resubmit
their source conversation.

The existing `LegacyMemoryEffects` SQLite owner persists the full bounded
`CreateMemorySdk` DTO, request UUID, message UUIDs and timestamps in a FULL
transaction before network dispatch. Its identity includes the original
scope/Session/Run and consumer version; its request binds the original config,
input and final text. The original user/Agent partition and Session hashing,
20-message/16,000-character bounds and API version are retained.

The journal is under
`<studio-store>/native-harness/cloud-memory-turns/<scope-hash>/effects.sqlite`.
Confirmed duplicates read the original receipt. Pending work or a lost response
returns uncertainty without resending, including after database reopen. This
does not promise external exactly-once. A receipt confirms acceptance only;
`extraction: not_confirmed` does not assert indexing or future recall.

The optional callback runs after the main terminal and before resource release,
under the existing bounded completed-turn lifetime. Failure cannot replace the
answer, usage or verifier outcome. Closure revokes late writes. A newly
dispatched result emits the existing content-free `studio/resource-check`
event; replay does not create another submission or resource-check event.

## Directed evidence and remaining work

Only the affected paths were checked on Node 26, with syntax checks and:

```
node --test --test-name-pattern 'cloud Memory|memory adapter writes' tests/studio-native-harness.test.mjs tests/local-resource-adapters.test.mjs
node --test --test-name-pattern 'cloud Memory' tests/studio-native-harness.test.mjs
node --test --test-name-pattern 'cloud Memory completion' tests/studio-native-harness.test.mjs
node --test --test-name-pattern 'durable cloud Memory writer' tests/local-resource-adapters.test.mjs
```

The first checks exposed the DSH wrapper's additional Host digest and fixture
transport expectations; those were corrected without loosening persistence or
no-resend assertions. Subsequent runs repeated only affected failures. Five
distinct cases have passing evidence: existing ordinary adapter compatibility,
Revision/Frozen actual Host-service completion using SQLite and real HTTP,
lost-response no-resend, and fixed-configuration/retirement behavior. The real
HTTP test reads the prepared SQLite row before dispatch and matches the exact
wire DTO/request UUID; a separate reopened Run/effect owner reuses the receipt.
Logs are `.artifacts/native-migration/cloud-memory-{turn,turn-targeted,turn-completion,transport}.log`.

The Host-service fixtures double the DSH registry/session services. This is not
a fresh fully mounted Host, browser, online AICP or new process-kill proof.
Product-level explicit reconciliation for uncertain cloud submissions remains
open; automatic retry is not a substitute. Final capability/entrypoint
acceptance and the Native default switch remain separate migration gates.
