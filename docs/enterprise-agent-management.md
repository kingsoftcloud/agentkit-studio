# Native defaults and mounted Agent management

Reviewed 2026-10-26. This batch completes the user-facing version/conflict and
management evidence in P2 and the mounted task-interaction evidence in P4 of
the enterprise Agent Studio plan. It does not certify the remaining governance,
context/budget integration or real-model measurements.

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
capability annotations as manual creation. These legacy annotations are not
permission grants: the follow-up governance audit found no execution consumer.
Explicit non-Native drafts receive no Native host annotation. Confirmation, exact draft revision, catalog validation and
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
7. A second revision-3 turn holds its model response while the actual browser
   reloads. The reopened page shows the in-progress user message; releasing the
   response displays the answer in that same Session, and another reload keeps
   it. SQLite records a completed continuation Run linked to the earlier Run.
   The model endpoint observes one request for this turn, with no duplicate.
8. A third revision-3 turn starts before Chrome is put offline. The model
   response is released while the browser remains offline; SQLite confirms all
   three current-Session Runs completed before reconnection. Returning Chrome
   online restores the answer without another model request, and another reload
   retains it.
9. A fourth revision-3 turn holds its model response until the real conversation
   Stop button is clicked. The UI shows a stopped terminal after reload, SQLite
   records a `canceled` Native Run linked to its parent, and a late model answer
   does not appear. The fixture observes one model request for that turn.
10. A fifth revision-3 turn receives a provider 401 with a private response
    body. SQLite records one failed Native Run and one model call. The Run panel
    shows the fixed public explanation before and after a browser reload; the
    private response body never appears in the UI. The canonical failure event
    uses the same safe explanation.
11. A separate coding Agent with a frozen strict policy calls the bound
    `write_workspace_file` tool. Chrome shows the pending DSH approval, reloads,
    then answers “allow once” in the original Session. The file is written
    once; the SQLite Run has two model calls and one tool call. Persisted Session
    history contains one `approval/asked` and one matching `approval/decided`,
    with no raw file arguments in the approval reason. Explicit provider
    reasoning is present in an expandable thought row and survives reload.
12. A second Agent binds a model profile with
    `provider_thinking_display: false`. Its fixture still supplies
    `reasoning_content`, but Chrome does not display it before or after reload.
    The inspected Session history also contains no private reasoning text.

The local model is a controlled HTTP/SSE fixture, not a quality/token/latency
benchmark. A reload during an active turn proves page-level reconnection. A
Playwright network outage proves the browser can recover a result that the Host
committed while offline. Neither proves abrupt Host crash recovery or a range
of real-world network failure patterns; those remain separate acceptance scopes.
The Stop check covers a held model request; cancellation during an external
tool's unknown side effect has its own Native receipt/recovery acceptance.
The approval and reasoning checks use controlled provider responses. They prove
the mounted product path and visibility policy, not the quality or disclosure
terms of a real model provider. Approval after an abrupt Host crash and a wider
range of in-flight side effects remain separate fault-acceptance scopes.
The verifier uses a reused dependency graph, not a clean dependency install.
Its Node-only PATH deliberately excludes OS document-directory helpers; the
shipped workspace controller is configured with a scratch Documents directory.
It does not replace the Host or bypass execution/permission gates.

The refreshed machine-readable report is `enterprise-agent-management-evidence.json`.
Its archive and production source hashes identify the evaluated implementation.
The local evidence directory also contains screenshots of conflict recovery,
revision status, both revision executions, page reload, network recovery, the
stopped terminal, provider failure and approval. The machine-readable report
records the explicit reasoning-on and reasoning-off sessions.

Reproduction:

```sh
npm pack --pack-destination /tmp --json > /tmp/agentkit-studio-pack.json
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
The provider-error extension passed 45 focused Host/projection/panel checks,
then 21 affected recovery checks after a validation-assertion correction.
The mounted Chrome verifier passed with six model requests, including the one
failed request; it used a fresh production archive. These checks do not measure
real-model answer quality or latency.
The extension for approval and reasoning passed with nine fixture model
requests. Its fresh packed Host and actual Chrome showed one durable approval
answer, one workspace effect, public thought after reload and no displayed
thought for the profile that disabled it. A separate read of the corresponding
Session logs confirmed the disabled profile's private text was absent. Actual
Claude Code supplied the tool-call fixture shape; its suggested cloud personal
assistant approval UI path was rejected after checking the maintained DSH
`ui-approval` source and the successful Native browser flow.
The build guard caught and prompted removal of an accidental browser dependency
on the runtime contract; the default now lives in `src/authoring-defaults.mjs`.
Initial verifier corrections used the actual separate Build-list route and a
shared browser context for two tabs; they did not alter production behavior.
