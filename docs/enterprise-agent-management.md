# Native defaults and mounted Agent management

Reviewed 2026-10-26. This batch completes the user-facing version/conflict and
management evidence in P2 of the enterprise Agent Studio plan. It does not
certify the remaining task interaction, governance or real-model measurements.

## Behavior

New local manual and conversational drafts select Studio Native (`harness`).
The Agent store and local creation route use the same pure authoring default.
Explicit DSH/Codex selections, template runtime selections, persisted drafts,
Agent revisions and existing legacy edit interpretation retain their engines.
The pure default module does not import the runtime package into the browser.

A stale editor cannot publish over a newer Agent revision. The form keeps the
unsaved fields and explains the conflict. The explicit “读取最新版本” action
warns that it replaces those fields, fetches the latest record and remounts the
form. The user can then reapply changes and save with the latest revision.
There is no automatic overwrite or three-way merge. The ordinary Back and Save
controls remain available for other failures; no new automatic mutation retry
was introduced.

Conversational creation now uses its existing resolved Host factory when no
custom factory is supplied, and declares the same minimal Native host/MCP
capabilities as manual creation. Explicit non-Native drafts receive no Native
host capability. Confirmation, exact draft revision, catalog validation and
unknown-outcome guards remain in place.

## Mounted evidence

`scripts/verify-studio-native-management-web.mjs` opens actual Chrome against the
maintained DSH Web composition and a fresh packed Studio production Host. It
uses real UI actions for all Agent/Build mutations and conversation submission;
read-only authenticated RPC and the actual SQLite ledger verify outcomes.

The proof covers:

1. New manual configuration defaults to Native, while all three runtime options
   remain selectable; a local model is bound and the Agent can be found by search.
2. The Build page creates a successful immutable Build of revision 1.
3. Two real browser tabs load revision 1. The first saves revision 2. The second
   is rejected without publishing a revision and retains its unsaved prompt.
4. Explicit refresh loads revision 2. Reapplying an edit publishes revision 3;
   the list shows r3 and distinguishes its historical Build.
5. Running that historical Build from the Build page executes the revision-1
   instruction after the live Agent has changed to revision 3.
6. Binding the current Agent to a new Session executes revision 3. Both histories
   survive full page reload. SQLite records two completed Native runs with
   original revisions 1/3 and one model call each. The legacy loop sentinel is
   never entered.

The local model is a controlled HTTP/SSE fixture, not a quality/token/latency
benchmark. A reload proves history restoration, not abrupt Host crash recovery
or live-stream network reconnection. Those have separate acceptance scopes.
The verifier uses a reused dependency graph, not a clean dependency install.
Its Node-only PATH deliberately excludes OS document-directory helpers; the
shipped workspace controller is configured with a scratch Documents directory.
It does not replace the Host or bypass execution/permission gates.

The machine-readable report is `enterprise-agent-management-evidence.json`.
Its archive and production source hashes identify the evaluated implementation.
The local evidence directory also contains screenshots of conflict recovery,
revision status and both revision executions.

Reproduction:

```sh
node scripts/build-client.mjs
npm pack --ignore-scripts --pack-destination /tmp --json
node scripts/verify-studio-native-management-web.mjs --source .artifacts/dsh-native-zcode --archive /tmp/kingsoftcloud-agentkit-studio-0.0.2.tgz
```

## Focused review and validation

Actual Claude Code independently inspected runtime defaults and revision
handling, and ran eight focused existing files (66 passing checks). Main review
accepted the need for mounted conflict/refresh proof and completed it above.
The review's claim that an error has no exit action was rejected against the
always-present Back control. A three-way merge is an optional enhancement, not
required for safe explicit refresh. Its missing-runtime legacy catalog finding
concerns malformed/pre-contract files, not records created by this batch; no
historic data migration is claimed.

Primary's focused source/form/Host regression checks passed (204 checks):

```sh
node --test --test-timeout=15000 tests/host-route-contracts.test.mjs tests/local-agent-edit-conflicts.test.mjs tests/agent-store.test.mjs tests/authoring-tools.test.mjs tests/agent-memory-form.test.mjs tests/agent-native-role-form.test.mjs tests/agent-template-ui.test.mjs
```

Contract TypeScript and the guarded client build passed. No full suite was run.
The build guard caught and prompted removal of an accidental browser dependency
on the runtime contract; the default now lives in `src/authoring-defaults.mjs`.
Initial verifier corrections used the actual separate Build-list route and a
shared browser context for two tabs; they did not alter production behavior.
