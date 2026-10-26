# Studio runtime and deployment boundary audit

Status: local source and product audit, 2026-10-26. This records the three
supported Harness choices without claiming one engine's state can be resumed
by another, or that this local phase has deployed Native to the cloud.

## Two distinct choices

`runtime.type` selects the engine. `harness` is Studio Native (NativeKernel
inside the maintained DSH plugin), `dsh-native` is the DSH loop, and `codex`
is the Codex App Server adapter. `STUDIO_RUNTIME_TYPES` and
`STUDIO_RUNTIME_CAPABILITY_MATRIX` in `src/runtime-contract.mjs` are the public
routing vocabulary. New local authoring defaults to `harness`; an explicit
runtime is preserved. `local` versus `cloud` is a separate route flag in
`src/providers/dsh-runtime.mjs`, not a fourth runtime type.

| Engine | Local execution owner | Product Session / visible stream | Durable authority and limits |
| --- | --- | --- | --- |
| `harness` | Studio NativeKernel with Host model/tool/SQLite ports | DSH Session events and assistant stream | Native run ledger, leases, receipts and frozen Build; DSH owns user conversation |
| `dsh-native` | DSH Agent loop with Studio resource/model bridge | DSH Session events and assistant stream | DSH Session/loop semantics; do not report Native run-ledger guarantees for it |
| `codex` | Separate Codex App Server process and adapter | Studio Codex adapter projects Codex turn/items into the product | Codex process/session contract; the shared matrix does not advertise Native/DSH persistence for it |

`src/providers/dsh-runtime.mjs` routes local Codex to its subprocess and
non-Codex local turns to the local handler. Its cloud branch uses the configured
cloud runtime/client and explicitly rejects image input for the current cloud
image. That branch is not proof of a cloud Native scheduler. A local Native
turn is admitted only when `binding.local === true`, runtime is `harness`,
the Native engine contract matches, and the Agent/Revision/Build still match;
see `src/host/services/native-harness.mjs`.

## Identity, management and packaging

The common identity is Agent ID, revision, Build ID, Session ID and Run ID.
`studioRunIdentity` rejects missing or inconsistent IDs, and route binding
checks Agent/Session. `src/studio-build.mjs` content-addresses the frozen
Agent spec and engine pin. `src/build-engine.mjs` preserves old unpinned/legacy
Builds and prevents a later Host flag from reinterpreting a Native Build.
`src/portable-bundle.mjs` exports and verifies that Build rather than
rebuilding an Agent from mutable current settings. This is a deployment
artifact boundary, not live cross-runtime state migration.

Local management evidence already covers create, edit with revision conflict,
Build, old versus current revision selection, task history, reconnect and
cancel through actual mounted product routes and Chrome; see
`enterprise-agent-management.md` and
`enterprise-agent-management-evidence.json`. The route-driven business/coding
verticals in `enterprise-agent-platform-local-evidence.json` cover the same
Native engine with real local effects and cold continuation. Those controlled
model proofs do not establish Codex/DSH feature parity or cloud deployment.

The focused contract, Build and portable tests passed 28/28 on this audit.
They check all three names and shared IDs, distinct engine pins, archive
tampering rejection, Native portable export/import, and legacy rollback. No
full suite was rerun. This closes P5's three-point runtime/local-management/
deployment-boundary **audit** only; actual cloud deployment, other-platform
installs and cross-engine in-flight handoff remain outside the local phase and
must not be described as verified behavior.
