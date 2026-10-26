# Memory startup recovery and local fault evidence

2026-10-26. This is partial evidence for the active enterprise Studio objective,
not certification of the entire Memory feature or platform.

## Changes

The completed parent ledger also serves as the durable extraction trigger.
Startup scans only the Host's trusted tenant/workspace/user's current completed
heads, verifies the original admission capsule and resolves its immutable Agent
revision/Build. A later mutable draft disabling extraction does not rewrite an
already-admitted Run's policy. Auxiliary Runs and child owners are not fresh
source admissions. Consumed or terminal-error jobs do not restart on every boot.
A wake requested while a pump is finishing is retained, avoiding stranded jobs.

The trusted principal also limits dispatch, status and explicit scheduling.
A regression puts another tenant's legitimate queued job in the same SQLite
files: this Host leaves its status/fence untouched and rejects inspection or
scheduling of that scope. The production Host restart test changes the mutable
Agent to revision 2, disables extraction there, and still recovers the original
completed revision-1 Run using the immutable original policy.

## Actual process faults

`tests/native-memory-extraction-process.test.mjs` kills real Node processes with
SIGKILL without rewriting stored records:

| Fault boundary | Observed cold-process result |
| --- | --- |
| Parent terminal before enqueue | Discovers parent, writes one fact, advances cursor. Another reopening makes no model request. |
| Job committed before dispatch | Preserves job ID, writes one fact, advances cursor. Another reopening makes no model request. |
| Memory owner committed before kernel receipt settlement | Waits the actual production 90-second job lease, preserves one original tool intent and one version-1 fact. The original 60-second wall budget has expired: no further model request or receipt-query dispatch, incomplete job, unchanged cursor. |

All three cases passed. The last proves no blind replay, not successful
completion or reconciliation after budget exhaustion. The first run incorrectly
expected a receipt reconciliation after the deadline; the corrected assertion
preserves the original budget. The first two cases were rerun after the final
principal guard change. The slow fault was not repeatedly rerun for subsequent
presentation changes; a short actual-HTTP test separately verifies the new
budget error code. No lease was shortened and no fake clock was used.

P5 earns **1 of its 6 fault-acceptance points** for these Memory boundaries.
Business-tool, background/child, cancellation and broader recovery experiments
remain required. The fixed overall denominator now records **51/100**.

## Status and rendered component

The production recovery-status service is exercised for successful extraction
and a five-model-attempt budget stop. It exposes auxiliary usage separately
from the completed parent's one model call. Chromium rendered the actual Studio
task panel and ResourceDialog with those captured replies, verified separate
usage, both outcomes, Chinese budget text, refresh and close, and saved images.

Limits: the Host test has a narrow synthetic DSH Session/ownership carrier;
the browser uses captured replies. This is isolated component acceptance, not
the packed mounted application, full app navigation or live authenticated
browser RPC. P4's remaining usage/status point is still unearned. The original
recovery button can remain available in these samples because their synthetic
DSH turn has not published turn/end; a completed Native ledger alone does not
prove DSH delivery is closed. All model replies/tokens are controlled fixtures,
not quality, cost-saving or performance benchmarks.

## Reproduction

Focused integration: **35 passed**. Separate process runs: **2 fast faults and
1 90-second fault passed**. Client bundle, TypeScript contracts and diff checks
passed. No full suite was run.

```sh
node --test --test-timeout=15000 tests/native-memory-extraction-host.test.mjs tests/studio-native-memory-host.test.mjs tests/native-child-panel.test.mjs
node --test --test-name-pattern='before-enqueue|queued' tests/native-memory-extraction-process.test.mjs
node --test --test-name-pattern='effect-committed' tests/native-memory-extraction-process.test.mjs
AGENTKIT_NATIVE_MEMORY_UI_EVIDENCE_DIR=/tmp/enterprise-agent-memory-ui node --test --test-name-pattern='production Host completion|production recovery status' --test-timeout=10000 tests/studio-native-memory-host.test.mjs
node scripts/verify-native-memory-browser.mjs --source .artifacts/dsh-native-zcode --evidence-dir /tmp/enterprise-agent-memory-ui
```

Transient logs: `/tmp/enterprise-agent-memory-recovery-integration.log`,
`/tmp/enterprise-agent-memory-fast-crash-validation.log`,
`/tmp/enterprise-agent-memory-owner-crash-validation.log`,
`/tmp/enterprise-agent-memory-browser-validation.log`.
Browser screenshots/proof: `/tmp/enterprise-agent-memory-ui/browser/`.

## Independent actual Claude Code audit

The CLI independently audited background/child lifecycle. Its missing-principal
claim came from the concurrently changing worktree and was rejected against
actual Host wiring and the restart test. Its suspected child background-command
wedge was rejected after tracing the production child allowlist and parent
command/policy binding. No watcher patch was justified. The CLI's follow-up
completed and reported 31 focused watcher checks passing; primary reviewed the
source chain, not a second execution of that suite.

Internal watcher/worker health accessors have no dedicated product RPC. This is
an observability audit item, not evidence that per-task recovery status is
missing. No background/child acceptance credit is claimed from this audit.

Remaining: compaction/rewind cursor lineage, full mounted-product interaction,
representative real-model extraction quality and broader platform acceptance.
