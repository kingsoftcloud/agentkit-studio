# Native Harness core

Host-independent TypeScript execution contracts, durable state machine and
`NativeKernel`. No Studio, DSH, Node filesystem, database or HTTP runtime is
imported by the core. SQLite and HTTP model adapters are in
`@kingsoftcloud/agentkit-harness-node`; Studio composes the same kernel through
its existing adapter.

The package is private during local acceptance. Build from the repository with
`node scripts/build-native-harness.mjs`, then pack this directory. Installation
uses the compiled ESM and declarations in `dist`; no repository build step is
required by consumers. Packages are not published by these commands.

## Public composition

Import `configure`, `NativeKernel`, `NativePolicyModule`, `defaultPolicyModules`,
`defaultPolicyBindings` and the port/store contracts from the package root.
The host supplies a store, model/tool ports, a deterministic digest and an owner
identity. `runUntilIdle` is the only execution driver. Observe committed events
through the store and `onCheckpoint`; `onStream` is provisional model output.

## Policies

A registration has `{ id, version, implementation, context? }`. `context` is a
synchronous pure function receiving deeply frozen copies of snapshot,
configuration and its binding. Return strings of context, not executable actions
or state patches. Context is wrapped as user data and remains subject to protocol
validation, context budgets and normal tool permissions. It grants no authority.
The host loads trusted JavaScript: this interface is a capability boundary, not a
sandbox for malicious code or a restriction on closures supplied by the host.

New context strategies require no kernel edits:

```js
const hint = {
  id: 'company.task-hint', version: '1', implementation: 'task-hint/v1',
  context: ({ binding }) => [String(binding.options.hint)],
};
const config = configure({
  ...input,
  policyModules: [...defaultPolicyBindings(input), {
    id: hint.id, version: hint.version, implementation: hint.implementation,
    options: { hint: 'Prefer concise answers.' },
  }],
});
const kernel = new NativeKernel({
  ...host,
  policyModules: [...defaultPolicyModules, hint],
});
```

Only bound modules contribute context or handle internal tools. Todo and plan
state reductions are closed, immutable built-in capabilities; normal modules
cannot write arbitrary snapshot fields. Tool admission, lifecycle, ordering,
receipts, fencing and commits remain core responsibilities. Review and provider
strategies use explicit built-in slots. Adding a new execution primitive still
requires extending the core contract.

New configurations persist module identities, versions, implementation contracts
and options in their configuration digest. Absence of `policyModules` on a
historical configuration means the existing v1 built-ins inferred from its
original flags; loading does not rewrite its configuration or digest. Enabled
legacy flags require matching bindings, so omission cannot silently disable an
existing Build's behavior. Missing or incompatible registrations fail before
execution. Changing a binding creates a new configuration/Build, not an in-place
upgrade of an existing task. Registrations must be pure and hold no mutable
session state; authoritative state belongs to the run snapshot.

This finite extraction does not make every capability a plugin. Browser,
background and child task lifecycle primitives remain explicitly maintained by
the core. The example standalone host demonstrates the Node composition without
Studio/DSH.

## Execution guarantees

Messages are append-only observations. Prepared/compacted views are separate and
bound to the source, goal, workspace and configuration digests. Imported history
never executes tools. Tool calls/results remain paired and provider replay IDs
remain distinct from internal IDs.

A session has one active turn; leases and fences reject stale owners. Effects
commit their intent before claim/dispatch, and receipt/state/events commit
atomically. Unknown writes are never blindly replayed. Explicit pure-inference
and safe-read recovery policies retain the old uncertain receipt and charge a
new bounded attempt; `readOnly` alone does not authorize recovery. External
systems still need idempotency keys or observation/reconciliation: a lease does
not guarantee exactly-once external effects.

`reviewBackgroundInterruption` records an explicit operator confirmation that
the original processes have stopped. It is available only for an interrupted
head whose owned background results were observed, with no unknown tool write,
unreceipted effect or unsettled descendant. The scoped event cursor, inactive
lease and idempotent command bind the decision. Its separate durable metadata
does not change the terminal snapshot, receipt, output or execution verdict.
It permits a host to stop waiting; it does not reconcile the unknown result.

Cancellation is durable and wins over final completion. Late results cannot
rewrite the ledger. Verification requires bound non-model evidence for required
checks; absent evidence stays unverified. Projections across separate databases
must consume committed event identities idempotently. `onCheckpoint` is awaited
before the next effect; a callback failure leaves a resumable run.
