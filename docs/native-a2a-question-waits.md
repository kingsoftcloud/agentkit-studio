# Native managed A2A question waits

The Native Host presents a managed remote input/approval through the maintained
`userQuestions.ask` service while the original Kernel Run waits for its tool
receipt. This upgrades the AgentKit Harness entry; DSH does not take over the
Native execution loop. The product path uses Node only.

The binding advertises `agentkit.a2a-question-ledger/v1`. Builds include this
contract in their binding digest. Records from a different binding are not
silently adopted.

## Answer and operation permission

1. The original admitted call, task, scope, question generation and absolute
   deadline identify the wait. A cross-process question lock permits one
   presenter without holding the execution lease or state publication lock.
2. A validated answer is written to the private call journal under the original
   publication lock and fsynced **before** asking for operation permission.
   String values include the empty string. Other types use exact JSON parsing
   and the original schema. Normalization follows the reference envelope rule.
3. Sending that answer (or cancelling after rejecting a remote approval) requires
   a separate, live Host approval and actual durable Session audit receipt.
   A question answer is never an operation grant. Task and pause identity are
   rechecked after permission. Admission commits the decision and effect intent
   before network transport.
4. A confirmed receipt wakes one deterministic `reconcile_tool` command. The
   Kernel reads the receipt under a new ledger-owned claim and continues the
   original Run. The initial tool intent/uncertain receipt stay immutable.

Ordinary input rejection ends the original call locally with
`A2A_INPUT_REJECTED`; it sends no remote cancellation. Rejecting a remote
approval requests independent permission for `CancelTask`, never a supplemental
`reject` message. A denied operation preserves the answer and ends the original
tool locally with `A2A_APPROVAL_DENIED` without changing remote state.

Both question presentation and operation permission retain the original absolute
deadline. An uncooperative service cannot extend it or use a late reply to admit
an effect. A local timeout produces `A2A_OVERALL_TIMEOUT`, not a fabricated remote
terminal. A committed owning-Run terminal withdraws outstanding local questions
(or expires them if due), without remote side effects. A stale checkpoint cannot
perform that cleanup; abandoned presentation alone leaves its question recoverable.

## Recovery

After a crash before answering, a newly authorized Host can present the unresolved
original question. After answering but before operation permission, it reuses the
durable answer and asks fresh permission; it does not ask for the answer again.

An admitted operation with an unknown result is never automatically resent or
queried by the idle waiter. Its deadline does not turn uncertainty into a local
failure claiming the operation did not happen. Use the existing explicit task
inspection/reconciliation controls. The fresh task read immediately **before**
admitting a permitted operation remains part of its normal identity check.

Question lifecycle facts use canonical v2 **status items** in an independent
local observation stream with its own source key and durable Session cursor.
They are not remote interaction answers, model messages, or new tool executions,
and never go to remote `AppendA2ATaskEvents`. The stream contains status, target
and deadline, without answer content. The task panel prevents replacing a saved
answer and keeps explicit remote inspection/cancellation available.

### Reattaching a cold Studio turn

After a Host restart, the existing Native recovery panel can **接回原运行并继续等待**
for an original A2A receipt-observation wait. This resumes the same durable DSH
turn and Native Run. The Host revalidates the original admission, preset, Build,
model route, prompt and frozen configuration before installing its waiter.
Reattachment itself makes no new GetTask, Send, discovery or model request.
**核对原工具结果** remains a separate explicit receipt query. Refreshing status
or history does not resume execution.

The versioned `receiptWait` capability is available only for the original
single `call_a2a_agent` call, its fenced running intent, matching uncertain
receipt and `receipt-observation/v1` definition. It does not admit an arbitrary
unknown write. An already active waiter reports `recovering`, cannot be resumed
twice and still accepts an explicit reconciliation request.

Host startup now discovers these original waits after Session, preset, approval
and Workspace registry readiness. Before restoring, it verifies the actual live
root, archive policy, original external owner and expired execution lease; full
configuration rebinding still happens in the owning turn. Archived Sessions and
Native children are not admitted through this root recovery path. Closing the
discovery worker stops scanning; it cannot cancel or replace a Native Run.

Terminal question cleanup has a separate versioned ledger cursor. It withdraws
local waits without Get/Send/Cancel or model execution. A closed DSH turn uses a
local-only cleanup port, with the original capsule/current preset/checkpoint
guards. An interrupted unknown write stays interrupted. If cleanup committed but
the original `turn/end` did not, startup still adopts that pending original owner
to finish its terminal delivery. The question cursor is not proof of DSH closure.
Changed or unavailable original bindings fail closed and require repair; the
worker retains a bounded error and continues discovering other candidates.

### Questions from an active Native child

A declared child role may explicitly grant `list_a2a_agents`,
`get_a2a_agent_card` or `call_a2a_agent` from the parent's bound A2A tools. Targets
and the A2A contract are included in the child's frozen binding digest and checked
again when restoring ports. A2A access is not inherited merely by declaring a
child role. Filesystem isolation still applies to workspace writes; it does not
grant remote invocation. Calls retain the existing Host tool-policy pipeline.

The child owner now drives its original receipt wait through the live root's
question and approval services. Its remote journal, intent, result and budgets
belong to the child Run and child Session; human presentation and audited consent
use the parent's product Session. Before each local observation and decision,
the bridge checks the live root, fixed parent preset, exact child checkpoint,
original parent external-turn admission, and either the unsettled committed
reservation or the still-fenced foreground startup intent. Ordinary child tool
approvals continue to use their existing Kernel interaction bridge.

Parent cancellation, explicit child stop and Host retirement withdraw the local
wait, drain the child's durable cancellation and reject late answers. Withdrawing
this waiter alone sends no remote cancellation. Terminal cleanup uses the child's
actual committed checkpoint. A separately committed matching receipt observation
can settle an original unknown receipt without modifying that receipt; unrelated,
missing or still-unknown observations cannot authorize result delivery.

The product-assembly tests cover foreground/background input and remote approval,
parent/child cancellation, stale root/preset/parent ownership, and binding forgery
using real Kernel/SQLite and controlled HTTP. Agent, question and approval audit
services in these child tests are explicit doubles.

`scripts/verify-studio-native-a2a.mjs --child-question-cold --source <built DSH>
--archive <packed studio .tgz> --keep` additionally verifies a typed input through
the fully mounted question/approval/Session services. It kills the actual Host
while the original parent is collecting its waiting child, waits for the actual
lease expiry and automatically reattaches that parent once the SDK has published
its live idle root, without a recovery resume RPC. Discovery never opens an
absent Session; the SDK owns that write handle. Admission rechecks the same root,
parent checkpoint/configuration, expired leases and sealed child checkpoints.
A lost collector records the same child's known pending observation;
a fresh fenced collector reconstructs its sealed ports and local question wait.
This does not rerun the child tool. Unknown writes outside the classified original
receipt wait remain unavailable, and cancellation is not inferred from observation.

The mounted input scenario passes on Node 26, and the remote-approval scenario
(`--child-question-approval`) passes on Node 22, with a Node-only PATH. Before
answering, reattachment leaves model/discovery/Send/Get/Cancel counts unchanged;
the original child checkpoint and question identity survive. The separately
audited continuation then settles one child allocation and closes the original
DSH turn once. Adding `--child-answer-crash` kills the replacement after its answer
is durable but before separate operation consent completes. A third actual Host
reuses that answer without another question and asks for fresh consent. The old
unanswered approval remains audit history; no decision is invented for it. Both
scenarios pass this second crash boundary, with exactly five model requests,
one discovery, two Sends (initial and approved continuation), two receipt reads
and no cancellation. HTTP model, managed remote control plane/peer and human
answerer are controlled fixtures; the dependency graph is linked from the
maintained SDK. Other child crash/cancellation boundaries, stale browser approval
presentation, browser/human acceptance, fresh installation and other product
entry combinations remain open. Root startup recovery does not adopt child Runs
independently or adopt ordinary child tool approvals.

## Verification scope and remaining migration work

`tests/native-a2a-question-wait.test.mjs` exercises real Kernel/SQLite/journals and
controlled HTTP, including SIGKILL after answer persistence, cold process reuse,
late replies, two-stage permission, deadlines, concurrent waiters and terminal
cleanup. Question presenters and consent receipts in those tests are declared
doubles. `scripts/verify-a2a-question-wait.mjs --source <built DSH checkout>` adds
the actual maintained question, approval, Session and projection services through
the production Host idle adapter. Its answerers, minimal live-root registry,
sandbox-policy lookup and fsynced persistence carrier remain declared fixtures.

The mounted Host verifier's `--reconcile-cold --receipt-crash --terminal-close-crash`
scenario additionally checks automatic reattachment without a resume RPC and a
real process kill after cleanup but before the original DSH `turn/end`. Its
one-shot append failure is an explicit fault injector; the replacement uses the
real append method. The HTTP model and public paused A2A peer are deterministic;
this does not prove a mounted cold typed-question/human/browser flow. Closed-turn
typed-question cleanup uses real journals, Kernel/SQLite and SIGKILL with declared
minimal closed-Session/root/preset authority doubles.

These checks do not establish the full migration's completion. Remaining child cold
recovery boundaries, subscriptions/inbound assembly, full mounted question/browser flows, fresh
installation/Electron, online providers and the broader capability/configuration
and execution-entry audit remain separate gates. Explicit DSH/Codex task control
remains available; this automatic waiter belongs to the Native owning Run.
