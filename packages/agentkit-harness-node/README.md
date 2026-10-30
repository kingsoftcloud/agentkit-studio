# @kingsoftcloud/agentkit-harness-node

Standalone Native Harness Node adapters: a durable **SQLite run store** and a
**one-request model HTTP port**, packaged as an independently installable Node
module. It ships the Native Node adapters in this package and externalizes [`@kingsoftcloud/agentkit-harness-core`](../agentkit-harness-core)
for the kernel, contracts, transitions and durable execution. It has **no
Studio/DSH runtime dependency** and **does not duplicate the core kernel**.

## Public surface

```js
import { SqliteRunStore, createNativeModelPort, nativeModelRecoveryPolicy }
  from '@kingsoftcloud/agentkit-harness-node';
```

- `SqliteRunStore` — a `TransactionalRunStore` backed by `node:sqlite` with WAL,
  full synchronous commits, append-only events and immutable ledger items. Host
  recovery discovery (`listScopes`) returns only scope identities.
- `createNativeModelPort({ resolveProfile, fetchImpl?, maxResponseBytes?,
  idleTimeoutMs? })` — one host-resolved HTTP request per attempt. Streams
  text/thinking/tool_delta display deltas and seals a single `ModelResult`. The
  adapter never retries and never executes tools; the kernel owns backoff,
  call budgets and tool execution. Credentials travel only in headers.
- `nativeModelRecoveryPolicy({ protocol, parameters })` — returns
  `'pure-inference/v1'` for the plain inference protocols with no parameter
  extensions, else `'manual'`. Used as `RunConfiguration.modelRecoveryPolicy`.

## Command output observations

`./native/local-command-tools` accepts an execution-local observation capability:
`tools.execute(request, { onProgress })`. It supplies ordered stdout/stderr
chunks while an authorized foreground command runs, including the supervised
durable foreground backend. These chunks have no exit status or execution
verdict. Cancellation or stale authority suppresses further observations;
observer failures cannot change the final tool result. Background output still
uses the owned `read_command_output` interface.

`./native/command-progress` provides `createCommandProgressObserver` for a Host
to bind these chunks to a **required** output projector and publisher. The
projector receives a bounded cumulative snapshot, can hold or reject it, and
returns only `command_preview` stdout/stderr. A slow projector coalesces pending
snapshots; closing, aborting or losing current ownership rejects late output.
It never writes a receipt or model context and imports no Studio/UI code.

The projector is the streaming output governance boundary. Final-result
redaction does not authorize publishing raw previews. Hosts must supply their
streaming redaction/disclosure policy; this package never defaults to raw
publication. The Studio connection of this capability is a separate integration
step, not implied by the Node observation API.

Local command failures retain bounded `command_evidence` facts: the request,
execution, publication or transport stage, fixed cause codes, cleanup issues
and any observed exit code. Durable supervised commands preserve the same
facts in their private record across reconnects. These facts contain no raw
exception text, paths or command input and do not turn an unknown outcome into
success or authorize replay. Historical records without them remain readable.

The whole-turn adapter can close a reviewed background interruption using
`closeReviewedBackgroundInterruption`. It requires the scoped durable operator
review, closes the original presentation owner with an error ending, and binds
no execution ports. Later tasks retain the original unknown observation in
their history. A lost response can retry the same review; unknown tool writes
remain outside this mechanism.

## External process

The package also ships the `agentkit-native-rpc` bin and `./rpc-entry` export.
It uses versioned JSON-RPC 2.0 over NDJSON on stdin/stdout for `initialize`,
`task/submit`, `task/status`, `task/subscribe`, `task/cancel`, and `task/resume`.
Supply a separate durable business `requestId` on submission. Keep both the run
database and the request ledger across restarts; unknown writes are never
blindly replayed. An ended task with `outcome: unverified` is not validated success.

Set `NATIVE_MODEL_PROTOCOL`, `NATIVE_MODEL_BASE_URL`, `NATIVE_MODEL_API_KEY`, and
`NATIVE_MODEL_NAME`, then start:

```sh
agentkit-native-rpc --db ./runs.sqlite --ledger ./requests.sqlite \
  --workspace ./workspace --permissions workspace:read
```

The workspace must exist. No filesystem permissions are granted by default.
Startup bindings are frozen; recovery rejects changed bindings. This is a local
child-process interface for language-neutral clients, not a Python SDK or a
network multi-tenant server. One host process owns each store.

## Build

```
node scripts/build-native-node.mjs
```

esbuild bundles `src/index.mjs` into `dist/index.mjs`, externalizing `@kingsoftcloud/agentkit-harness-core`
and Node builtins. The build asserts, from the esbuild metafile, that the
adapter closure contains only this package's entries and `src/native/` adapter
sources and no Studio/DSH/host code.

## Install (local tarball)

The package is `private` and is consumed from local tarballs; it is not
published. `scripts/verify-native-standalone.mjs` packs both
`@kingsoftcloud/agentkit-harness-core` and this package, installs them into a
fresh temp directory, and drives a standalone example host against the
installed packages.

## Owned command output

The `native/owned-command` export includes
`createOwnedCommandOutputReader({scope, store, readers, isClosed})` and
`OWNED_COMMAND_OUTPUT_CONTRACT`. An authenticated Host may page output from a
current Session-owned background process after reopening storage. The reader
checks the original committed launch receipt, selects only that recorded
backend and checks ownership again before returning. It cannot launch, stop,
acknowledge or resume work. Returned bytes require a separate Host operator
disclosure policy before publication. Cursors count backend UTF-8 bytes;
display redaction must not replace them with displayed-text lengths.

## License

Apache-2.0 (see `LICENSE`). `NOTICE` documents the dependency/license audit:
no third-party source is bundled.
