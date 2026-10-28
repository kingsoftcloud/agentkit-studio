# Native role authoring and local task lifecycle acceptance

Reviewed 2026-10-26. This batch closes the background/child lifecycle milestone
in the enterprise platform plan; it does not certify the remaining general task
interaction, model-quality or final integrated acceptance requirements.

## Product changes

The local Agent form now offers optional Native child roles under running
policy. Authors can choose role identity/instructions, a model from the parent
whitelist, parent-bound workspace tools, model/tool-call limits, timeout,
Skills/MCP inheritance and the concurrent-safety requirement. No roles means
delegation remains disabled. These settings publish with the loaded Agent
revision; existing Builds and Sessions keep their frozen configuration.

Editing normalizes legacy snake-case role fields while preserving advanced
options such as output schema. Removing a parent tool or model cannot silently
widen the child's resources: the form rejects the dependent configuration.
Known mutating tool contracts conflict with a concurrent-safe role until the
author explicitly changes the requirement. Other Harnesses and cloud-owned
Agents retain their own role metadata without being parsed as Native roles.
Unexposed invalid legacy options can be removed by deleting/recreating the
affected role; this form is not a general raw-spec editor.

The Host remains authoritative. The existing child binder still intersects
the frozen tools/resources, checks isolated writes and current authority, and
uses the same NativeKernel, receipts, budgets, cancellation and settlement.
The shared workspace-tool inventory did not change its allowed set.

The mounted browser proof reproduced a separate authoring defect: with the
optional legacy catalog unavailable, only patch/rewind tools were selectable.
Native's existing ten base workspace tools now expose local catalog contracts
from the same definitions used for execution. Local metadata wins over a
same-named remote row. Other Harness catalogs retain their original behavior.
This adds no executor or permission grant.

## Full mounted Studio browser evidence

`scripts/verify-studio-native-children-web.mjs` loads a fresh packed Studio into
the maintained DSH Web profile and drives actual Chrome. It uses authenticated
production routes, real forms and actual Session submission, with no browser
RPC stubs, synthetic execution records, cloud service or Python runtime.
The proof includes:

1. Create a Native Agent and role through the form, selecting local read/write
   tools while the legacy tool catalog is absent.
2. Approve delegation under strict policy; send guidance to the original active
   child, then promote that same child to background while its HTTP request is
   held. The next child request contains the guidance and a real file result.
3. Approve the parent's wait operation; read the sealed child result and its
   settled usage through the task panel.
4. Reload the page and read the same original child/result.
5. In a second real turn, approve delegation, stop the active child through the
   task panel, then release a late response attempting a file write.
6. Reload both rounds; inspect actual SQLite parent/child identity, revision,
   settlement and effects. The first child completes with two model calls and
   one read; the second is canceled with one model call, no tool intent and no
   file write. Parent descendant usage equals each child's usage once.

The model server receives exactly nine requests (six parent, three child).
Tokens are controlled fixture values; the canceled request has no received
token usage. These are lifecycle/effect observations, not real-model quality,
token-saving or latency benchmarks. Browser reload is not an abrupt Host crash
or a full network-partition test. The UI scenario promotes an existing
foreground child; direct background start has separate Host-level evidence.

The verifier compares packed production files with the current worktree and
records their hashes and the archive hash. It reuses the existing local DSH
dependency graph; this is not a fresh dependency installation. Its only extra
plugin is the existing legacy-model-loop sentinel. Entering that loop fails.
The script requires the built maintained DSH and Chrome and is intentionally
an artifact-level verifier, separate from `node --test`.

```sh
node scripts/build-client.mjs
npm pack --ignore-scripts --pack-destination /tmp --json
node scripts/verify-studio-native-children-web.mjs --source .artifacts/dsh-native-zcode --archive /tmp/kingsoftcloud-agentkit-studio-0.0.2.tgz
```

## Background process failure evidence

The existing packed-Host background verifier was revalidated with a frozen
Build and `--boundary cold`. It starts a real Node command, completes the
original foreground turn, SIGKILLs the actual Host while the command is running,
and opens a new Host. Cold discovery resumes the original Session and delivers
one typed completion without another user prompt. SQLite/JSONL and an actual
launch counter prove one command effect, one completion and three model calls.
Editing the live Agent does not replace the original Build instruction.

The first run exposed a stale verifier assumption that `run_command` was the
only model-visible tool. Current Builds also contain ToolSearch,
DeferredToolCall and three read-only Artifact controls. The verifier now checks
that exact six-tool set; no additional effect tool or production bypass was
introduced. Controlled-server assertion failures are surfaced before result
checks so they cannot masquerade as provider retry failures.

```sh
node scripts/verify-studio-native-background.mjs --source .artifacts/dsh-native-zcode --archive /tmp/kingsoftcloud-agentkit-studio-0.0.2.tgz --boundary cold --frozen --keep
```

## Focused verification and independent review

Primary's affected form/catalog/Build checks pass (38 cases), plus three named
workspace definition/write/receipt checks. Contract TypeScript and the browser
bundle build pass. No full suite was run.

```sh
node --test --test-timeout=15000 tests/native-tool-catalog.test.mjs tests/native-build-engine.test.mjs tests/agent-native-role-form.test.mjs tests/agent-memory-form.test.mjs
node --test --test-timeout=15000 --test-name-pattern='definitions expose all ten tools|write_workspace_file creates new files|scoped instructions observe committed parent file receipts' packages/agentkit-harness/test/native-workspace.test.mjs tests/native-dsh-tools.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.contracts.json
```

Actual Claude Code independently ran 25 named existing Host cases covering
original send/cancel/promote controls, duplicate commands, late A2A answers,
parent/child/Host cancellation, frozen authority loss and foreground/background
A2A usage settlement. All passed; no new execution defect was reproduced.

```sh
node --test --test-name-pattern='Host control route (send|cancel) targets the original active child|managed: original child (send|cancel|promote), exact retry|SQLite (parent|child|host) cancellation retires an active child A2A question|managed (child|root) A2A question rejects a late answer|SQLite child A2A answer cannot authorize an operation after|child MCP full request authority loss|child A2A (approval|input) waits through its live root' tests/studio-native-children.test.mjs
```

Claude's subsequent static review identified the concurrent-safety authoring
gap and repeated catalog-definition allocations; primary fixed both and added
the actual form regression. Its claim that missing child browser tools blocks
Studio browser acceptance was rejected: these are different requirements.
Neither the role tool inventory nor CI discovery was expanded to satisfy that
claim. The current evidence does not certify every background A2A cancellation
or authority-drift permutation; broader failure acceptance remains open.

Durable reviewed reports are in `enterprise-agent-child-lifecycle-evidence.json`.
Transient logs live under `/tmp/enterprise-children-*` and
`/tmp/enterprise-background-cold-validation.log`; the commands above remain
reproducible when those logs are removed.
