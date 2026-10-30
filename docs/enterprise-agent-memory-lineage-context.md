# Memory lineage, full Studio UI and context budget evidence

2026-10-26. Partial acceptance for the existing enterprise Studio objective.
Same denominator: **54/100** (+1 mounted Memory usage/status, +2 context/budget).
No replacement runtime, cloud scheduler or Python dependency was introduced.

## Reproduced defect and production fix

Before the patch, a completed Memory extraction cursor could disappear from
the selected history after a conversation rewind. Scheduling the next
extraction failed with `studio_native_memory_extraction_cursor_not_in_history`.
The new repeated-branch regression was run against the pre-fix HEAD source and
reproduced that exact failure, then passed with the patch restored.

The Host retains the original cursor and its successful/no-op job as authority.
On a newer kernel branch generation, it filters only the active branch's
messages against original identities considered by completed jobs in that exact
scope/Session. It never reloads discarded prose into the extraction window.
A cursor without a completed owner, a regressed branch, or an absent cursor
without a newer branch fails closed. Source and live job/owner guards still
run before execution and at the Memory owner's commit; cursor advancement
still uses the existing SQLite CAS transaction.

The SQLite/localhost-HTTP regressions exercise multiple actual NativeKernel
rewinds and cold reopen. Prior no-op sources are not repeated, discarded
unprocessed messages do not reappear, and retained unprocessed short input
still accumulates. They construct trusted data-only rewind seeds from actual
kernel history; they do not independently certify product rewind authorization.

Compaction needed no production workaround: the existing planner keeps the
immutable transcript and reduces the model request view. An actual compaction
and cold-reopen source check confirms that an omitted original user message
and prior completed boundary remain capturable. Invented preference text in
the controlled summary never becomes a citation or public extraction source.
That source test uses a controlled model port and counter; actual HTTP and
production-counter coverage is supplied by the context checks below.

## Full mounted product

`scripts/verify-studio-native-memory-web.mjs` extracts a fresh Studio archive,
checks the installed client bundle and Memory dispatcher against the worktree,
loads the maintained DSH CLI/Web application, and drives actual Chrome.
Agents, binding, turns and status use production UI and authenticated RPC;
there are no captured browser replies, replacement renderer or direct product
record writes. Only the localhost model is controlled. A legacy DSH loop
sentinel must never be reached. The process PATH contains Node only.

Verified through the real form and task conversation:

- Create a Native Agent, bind the model, enable local candidate Memory,
  after-turn extraction, the 64-character threshold and actual write rollout.
- Run the Session; view one main model call separately from two auxiliary
  calls (input/output 22/14 fixture tokens).
- Reload the started conversation, reopen the task panel and retain status.
- Send another turn whose auxiliary task spends its five-call budget; show
  the Chinese incomplete/budget reason and separate input/output 55/35 usage.
- Reload again. Actual SQLite confirms two completed main Runs with one call
  each, two distinct auxiliary Runs, original Agent revision 1, and one
  version-1 fact. The exhausted job does not add a second fact.

The [saved report](enterprise-agent-memory-ui-evidence.json) records the exact
scratch output directory. `success.png` and `budget.png` were rendered; the
budget image was visually inspected. No uncaught renderer or model-server
errors occurred. Early verifier runs exposed missing fixture workspace setup
and an obsolete blank-session selector assumption after starting a conversation;
those were verifier defects, not production fixes.

This closes the previously isolated Memory usage/status evidence gap. Browser
reload is not a Host crash experiment; process-kill evidence remains in the
[separate recovery record](enterprise-agent-memory-recovery.md). Controlled
model responses and tokens do not prove extraction quality or token savings.
The maintained dependency graph is reused; this is not a fresh installation.

## Independent actual Claude Code work and review

The actual CLI session `434dd77b-b2c4-4908-845e-b17cd3de2fd3` owned only
`tests/enterprise-context-budget.test.mjs`. Its first two invocations reached
their turn limits during discovery; the resumed delivery invocation completed
and reported three passing checks. Primary inspected the code, removed duplicate
assertions, made cleanup await server closure, and strengthened exact HTTP
counts and aggregate input/output usage before rerunning it.

These use actual NativeKernel, file SQLite, localhost HTTP, the production
model adapter and production context binding/counter:

1. One task call plus two summaries spends `maxModelCalls=3`; separate summary
   usage events and total 15/21 fixture tokens persist. The planner stops with
   `context_finalization_budget_unavailable`. Reopening the terminal Run sends
   no additional HTTP call.
2. Empty summary responses stop after `maxSummaryRetries + 1` attempts, with
   original tool evidence retained in the transcript.
3. Cancellation during a held summary response ends canceled after exactly
   one task request and one in-flight summary, with no later request.

The existing actual-HTTP compaction test was revalidated separately: after a
sealed summary checkpoint, closing/reopening SQLite completes the task with
one real workspace file effect, one further model call, complete source quote
coverage and correct usage. It is a controlled checkpoint interruption, not
SIGKILL. No claim is made here about other provider protocols, nested child
budgets, all Host context sources or real-model performance.

## Reproduction

Affected checks: **47 passed**. Existing successful compaction/cold continuation:
**1 passed** separately. Client bundle and diff checks passed. No full suite.

```sh
node --test --test-timeout=15000 tests/native-memory-extraction-source.test.mjs tests/native-memory-extraction-host.test.mjs tests/native-memory-extraction-store.test.mjs tests/studio-native-memory-host.test.mjs tests/enterprise-context-budget.test.mjs
node --test --test-timeout=15000 tests/native-context-integration.test.mjs
node scripts/build-client.mjs
npm pack --ignore-scripts --pack-destination /tmp --json
node scripts/verify-studio-native-memory-web.mjs --source .artifacts/dsh-native-zcode --archive /tmp/kingsoftcloud-agentkit-studio-0.0.2.tgz
```

Transient logs: `/tmp/enterprise-memory-lineage-before-fix.log`,
`/tmp/enterprise-memory-lineage-integration.log`,
`/tmp/enterprise-context-budget-reviewed-validation.log`,
`/tmp/enterprise-context-continuation-validation.log`, and
`/tmp/enterprise-memory-web-validation.log`.

Remaining: broader context/resource and cross-capability budget acceptance,
background/child lifecycle, full task interaction, actual-model result/token/
latency evidence, management/runtime boundaries, licenses and final audit.
