# Native governance boundary follow-up

Status: partial, 2026-10-26. P2's complete trusted extension/resource authority
acceptance remains open. This record distinguishes versioned policy enforcement
from historical display-only labels and areas still lacking end-to-end proof.

## Implemented: versioned Native Agent tool policy

Newly authored Native Agents save `agentkit.native-agent-policy/v1` in their
Revision. `strict` asks once for every effectful or unknown tool, including
workspace, MCP, commands, Skill shell and child tools. `loose` inherits the
mutable Session/Host policy: verified Node builtins keep their existing body
authorizer; unknown external effects in a read-only Session require approval.
`custom` has exact tool-name `inherit`/`ask`/`deny` rules and denies unlisted
effectful tools. `inherit` cannot bypass the Host's own denial. Historical
`policyTemplate` labels without the versioned object retain their original
behavior; saving them in the form creates a new explicit policy Revision.

The admitted preset installs one `tools/pre-execute` listener plus a monotonic
`tools.guard`. A private WeakMap binds a successful `allowed-once` outcome to
the exact ToolRegistry execution and its sealed arguments. The Node builtin
authorizer and Memory's own consent reuse that same live grant, avoiding a
second approval for the same call; no durable receipt or matching call ID can
recreate it. Raw tool arguments stay out of the approval reason; the UI sees a
call ID and argument digest. AgentStore validates the versioned contract on
create/update. The policy is snapshotted in the admitted preset, included in
the Host binding digest and checked by a digest in the Native recovery capsule.
If another declarative pre-execute policy also asks for the same call, the
listener combines the constraints into one ApprovalService request; a later
denial wins before an approval is requested.

The [packed Host evidence](enterprise-agent-bound-policy-evidence.json) runs
business and coding Agents through production routes and the maintained DSH
ToolRegistry under deliberately permissive `danger-full-access` Sessions. It
observed four unique `approval/asked` events for three MCP calls and one
workspace write, one CRM mutation, frozen Build behavior and cold continuation
without repeated effects. This is controlled-model local integration evidence,
not a real-model quality benchmark. Focused form, store, admission, policy and
recovery tests pass; the full suite was not rerun for this batch.

Actual Claude Code reviewed the implementation independently. Its first two
legacy-recovery findings were based on a stale source snapshot: current code
activates only an explicit versioned object, and focused tests check old labels.
Its third finding exposed a possible second ask from another pre-execute
listener; the listener now coalesces declarative asks. Claude did not rerun the
packed Host verifier.

Remaining governance evidence: actual denied/cancelled approval paths under a
packed Host, all named Skill/child/extension surfaces under a versioned policy,
and complete resource-authority and license audit. `security.allowedPermissions`
is still Host capability metadata, not a one-shot permission grant; its labels
must not be presented as authorization proof.

## Fixed: parent MCP retained authority across asynchronous waits

The Native gateway previously supplied an exact current-intent checker only for
child MCP calls. A parent had a bound MCP name and passed the ToolRegistry, but
its remote adapter did not receive the checker. Releasing its actual SQLite
lease during the registry-policy wait or credential resolution still caused one
`tools/call` HTTP request before the kernel rejected its stale receipt.

`tests/native-mcp-dispatch-authority.test.mjs` reproduced both failures before the
fix against real NativeKernel, SQLite, the production resource adapter and a
local HTTP MCP peer. The model and registry policy stage are controlled doubles;
the ledger, credential/connection path, MCP client and transport are actual
implementation. Ownership is released in the store, not simulated by editing a
manifest or inventing a tool receipt.

Parent and child calls now share the sealed-request/current-intent check. It is
checked before entering the registry, at the owned tool body, through credential
resolution before starting a connection, and after connection setup before the
remote tool call. Completed calls cannot reuse the captured authority. A failure
after an external effect remains uncertain; this does not provide external
exactly-once semantics or automatically undo a remote operation.

Four new cases verify:

- normal MCP execution has one effect, a committed original tool receipt and no
  repeated effect when the terminal run is inspected again;
- ownership loss in the registry gate prevents entering the resource adapter;
- ownership loss during credentials prevents even initializing a new connection;
- ownership loss during MCP initialization prevents `tools/call`.

A targeted existing child check also exposed an earlier error-normalization
problem: the authority wrapper loaded a foreign run even after its ledger check
had returned false, throwing `run_not_found`. The same failure was reproduced
against the committed baseline. The wrapper now returns false immediately,
before loading or adopting any conversation branch for an unauthorized request.

Validation (targeted, no full suite):

```sh
node --test --test-timeout=15000 tests/native-mcp-dispatch-authority.test.mjs tests/mcp-transports.test.mjs tests/local-resource-adapters.test.mjs
node --test --test-timeout=20000 --test-name-pattern='MCP|mcp' tests/studio-native-children.test.mjs tests/native-dsh-tools.test.mjs
node --test --test-timeout=15000 tests/native-mcp-dispatch-authority.test.mjs tests/native-workspace-publication.test.mjs tests/native-tool-receipt-authority.test.mjs
```

These executions pass 27, 18 and 16 checks respectively; the new four cases
appear in more than one command and are not counted as distinct extra evidence.

The [fresh packed Host report](enterprise-agent-governance-host-evidence.json)
revalidates both business and coding Agents, real MCP and workspace effects,
frozen Build resource/instruction binding and cold continuation. The packed
changed production modules were byte-compared with the worktree. This is the
existing bounded vertical verifier, not a full suite or real-model benchmark.

## Prior finding: display-only policy labels

Actual Claude Code's read-only audit found that new-authoring
`spec.security.allowedPermissions` / `toolPolicy` are written as metadata but
are not read as a permission gate. Main review confirmed this and additionally
found that `bindings.policyTemplate` (`strict`, `loose`, `custom`) is exposed by
the form but has no execution consumer. A saved label is not proof of an
enterprise permission constraint. The authoring capability annotations must not
be described as enforced grants.

Current enforcement instead lives in the trusted Host's ToolRegistry pipeline,
`authorizeNativeBuiltin`, exact per-call Memory consent, Native intent/lease
checks and resource/version bindings. Native's whole-turn gateway DOES register
owned tools and call `ctx.tools.execute`; it does not bypass that pipeline.
The existing native-workspace wrapper deliberately delegates its approval to
this Host gate. Ordinary model tool calls cannot replace the Host authorizer;
plugins that execute arbitrary Node code are trusted Host composition, not an
untrusted code sandbox.

A second Claude proposal to map “loose” to `approval: never` and seed session
policy at creation was rejected. In the maintained DSH source, `never` rejects
approval requests; it does not auto-approve them. Initial session defaults are
also not an immutable enterprise ceiling. Its assertion of a separate,
unconditionally bypassed Native workspace permission loop contradicted
`src/providers/native-dsh-tools.mjs` and the mounted evidence.

The original implementation checklist (now partially fulfilled):

1. Define precise, user-visible semantics for the Agent's bound policy and its
   relationship to mutable session settings. Resolve legacy/custom values
   explicitly instead of silently granting a new meaning.
2. Enforce the policy at the existing trusted dispatch boundary for workspace,
   MCP, commands, inherited child tools and Skills. Host restrictions must still
   be able to deny; an extension's earlier allow must not remove the constraint.
3. Bind the policy to the Agent revision/Build and recovery capsule. Share a live
   exact-call approval through the actual pipeline where needed; neither a
   persisted boolean nor a model-visible receipt may recreate a one-shot grant.
4. Verify strict policy under a permissive session, denial/cancellation during
   approval, original-version cold restoration, and no duplicate approval for
   the same action. Then update the form to describe the behavior actually
   enforced and remove/deprecate misleading inert capability annotations.

The first Claude audit independently ran 54 focused authority/archive/grant
checks, but it did not inspect the parent MCP dispatch seam. Main review's
reproduction above supersedes its broad “no bypass found” wording. None of these
partial reviews certifies all extension/resource governance.

Actual Claude Code's final read-only review inspected the parent/child guard,
credential/connection rechecks and the ledger authority helper. It found no
concrete regression in that bounded change. Its first review invocation reached
its turn limit; the resumed final report completed. Primary ran and inspected
the executable checks and the packed-Host evidence above; the review did not
claim independently rerunning them or completing the remaining governance work.
