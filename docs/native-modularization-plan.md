# Native modularization and standalone Node host

Status: local implementation and acceptance complete, 2026-10-26. Local scope only; no main merge,
cloud scheduler, npm publication or repository split.

## Responsibility and interface plan

| Owner | Retained responsibility | Change |
| --- | --- | --- |
| Core | Protocol legality, budgets, cancellation, durable intents/receipts, leases/fences, atomic commits, child/background lifecycle | Remains the sole execution driver |
| Registered policies | Todo behavior/context, planning guidance, delivery review strategy, provider context projection | Versioned registration, per-run enablement, immutable inputs and constrained contributions |
| Node adapters | SQLite and model HTTP protocols | Public installable package, reusing existing adapter implementations |
| Studio/DSH | Product Session, projections, Agent/Build/resources and UI | Retain current adapter and compatibility |

Run configuration records policy identity/version/binding. Legacy configurations
retain their original built-in semantics; missing or incompatible implementations
must fail before effects. Modules do not receive a writable store, effect ports,
permission grants or budget mutation. Ordinary context strategies can be added
without changing NativeKernel. New execution primitives still require core work.

## Acceptance ledger

- [x] Registered, optional policies extracted without a second execution loop.
- [x] Durable policy bindings, legacy recovery, incompatible/missing module rejection.
- [x] Context/tool policies cannot bypass authority, budgets or protocol validity.
- [x] Enable/disable and independent concurrent-session state checks.
- [x] A separately registered example policy with no NativeKernel edit.
- [x] Focused Studio todo, plan, review and context regressions.
- [x] Public core/Node package entry points and dependency/license audit.
- [x] Fresh-directory installation of local tarballs, without Studio/DSH.
- [x] Standalone real model + read tool + actual write.
- [x] Process restart/continuation and no blind replay of unknown writes.
- [x] Standalone cancellation, permission rejection, budgets and committed events.
- [x] Reviewable local commits and final requirement/evidence audit.

Actual Claude Code is assigned the independent Node package/build and example
host work. The primary owns policy contracts, integration, review and acceptance.
Evidence will distinguish controlled model fixtures from real provider calls.

## Policy implementation evidence

`policy-registry.test.mjs`: 9 focused tests pass, covering versioned manifests,
immutable inputs, bounded context, independent sessions, disablement, recovery
staging, cancellation, permissions and request-token admission.
`native-policy-compatibility.test.mjs`: historical DSH ownership normalizes and
rebinds without adding metadata to its old configuration digest. A changed custom
strategy is rejected. Historical configurations remain the v1 inferred contract;
new raw admissions receive explicit manifests. Studio reconstruction preserves
original manifests or legacy absence.

The registry resolves enabled built-in strategy slots from each run's bindings.
Todo/plan internal tool handlers and their limited state reductions are registered
closed capabilities. Review prompts/triggers and provider context projection use
those resolved slots. Core still owns reliable plan/review lifecycle and protocol
handling; this is not an arbitrary state-hook API or a claim of total pluginization.

Focused batches before the final integrated acceptance: 67 todo/plan/review/provider
checks; 59 context and Studio plan/bound-policy checks; 34 verification/input/registry
checks. Later slot-resolution changes were checked with 64 relevant policy tests;
legacy DSH suite had 68 passes plus one new test fixture error, corrected and passed
separately. These overlapping batches are not a total unique-test count or a final
all-repository acceptance claim.

## Installed package and real-provider evidence

Both private 0.0.1 packages were packed with npm, then installed with scripts
ignored into a fresh directory. The installed core kernel SHA-256 matches the
same compiled kernel used by Studio. The package boundary verifier passed:
core has only its three Ajv dependencies; Node imports only the public core
package and Node builtins. License files and packed-file allowlists pass.

`verify-native-installed-live.mjs` runs a worker copied into that installation.
The worker imports only the two public npm names and reads connection credentials
from environment variables. Selecting an existing local connection is test setup,
not a Studio dependency of that worker. The generated task reads a nonce-bearing
input file and writes exactly the observed contents once. It registers its own
`example.exact-copy` strategy without a NativeKernel edit.

Real provider: `deepseek-v4.1-flash`, OpenAI Chat protocol, three HTTP 200 responses,
three model calls, one actual read and one actual write; 1361 input tokens,
141 output tokens, 256 cached input tokens reported. The first process exits
immediately after the read receipt commits. A second process reopens SQLite and
completes the same run; a third attaches to the terminal with no new events,
models or writes. All 21 committed events were consumed. The task itself remains
`unverified` because this minimal host supplies no verifier port; the external
acceptance compares file bytes and operation counts. No model-generated verdict
is treated as acceptance evidence. A controlled HTTP driver exercised the same
worker separately and is labeled controlled, not real-provider evidence.

The initial live fixture used a lease too short for process startup; it was
corrected to two seconds. A transient network error was correctly classified and
the live fixture now allows two provider retries within the original six-call
budget. An exploratory exact-copy input with a trailing newline was not reproduced
byte-for-byte by the model; the final finite acceptance input has two lines and
no trailing newline. This validates the local execution path, not general task
quality or arbitrary byte-perfect model copying.

Integrated core and focused Studio suite: 980 passed, zero failed. A source-size
gate then exposed the host assembly exceeding its existing limit by two lines;
the policy reconstruction was factored into the existing bindings helper. The
12 affected boundary/compatibility/source-size checks passed afterward. This
helper change does not alter the kernel or Node bundle used in the live run.
Contracts TypeScript checking and tracked-source portability also passed.

## Capability boundary audit

| Existing branch | Strategy boundary | Authority retained by core/host |
| --- | --- | --- |
| Todo tools, reminders and reductions | Registered `native.todos`, enabled by `todoPolicy` | Tool admission and the atomic todo state/event commit |
| Plan guidance, tool selection and planning results | Registered `native.planning`, enabled by plan/child-plan flags | Approval, write denial, interaction and child lifecycle |
| Delivery review prompts and trigger decisions | Registered `native.delivery-review`, enabled by review policy | Bounded model/tool dispatch and evidence-bound acceptance |
| Provider replay/context projection and guidance | Registered `native.provider-context`, required default compatibility slot | Protocol validation, request admission and committed replay identity |
| HTTP encoding and provider cache headers | Shared Node model adapter, externalized core dependency | One request per attempt; retry and budget decisions remain core-owned |
| Browser, child and background operations | Existing explicit ports and lifecycle contracts | Ownership, cancel, fencing, reconciliation and unknown-effect handling |
| Workspace/filesystem and SQLite | Node adapters and example tool port | Host grants permissions and confines paths; core journals dispatch/results |
| Agent/Build, Session and UI projections | Existing Studio/DSH adapter | Product assembly and projection consume the same core |

Built-in registrations are closed immutable capabilities, not replaceable
arbitrary reducers. Their enablement follows persisted flags and manifests;
removing a required binding is an error. Ordinary registered context modules
have versioned options and no execution or state-writing interface. Pure helpers
may resolve built-in slots without a custom registry; the driver validates all
bound registrations before effects. This deliberately avoids a general plugin
framework and leaves reliable lifecycle mechanisms in the core.

## Final requirement/evidence audit

| Requirement | Inspected evidence | Result |
| --- | --- | --- |
| Local packages, real provider, read and write | Fresh tarball install; `real-model.json`: three HTTP 200 responses, one read and one byte-checked write | Passed |
| Restart continuation | Real worker exits 73 after a committed read; fresh process completes the same SQLite run; terminal attach adds no events/effects | Passed |
| Unknown write is not replayed | Example exits 7 after the real write and before its receipt; resume is `interrupted/effect_outcome_unknown`, write log remains exactly one | Passed |
| Cancel, permission denial, budget | Installed example's controlled child processes: canceled with uncertain receipt; denied write creates no file; budget stops before tool dispatch | Passed |
| Enable/disable, isolation and constrained modules | Nine registry tests, including concurrent alpha/beta/disabled sessions, immutable copies, bounded output, cancel/permission/token gates | Passed |
| New strategy without a kernel edit | Registered `example.exact-copy` in the real installed worker; binding persisted in SQLite | Passed |
| Existing Studio behavior and legacy Build | Integrated 980 core/Studio tests plus 12 affected compatibility/source-size checks; old manifest absence/digest preserved | Passed |
| Same execution kernel | All 70 current core/Node runtime ESM files match the real-provider installation byte-for-byte; Node bundle externalizes core | Passed |
| Package contents, licenses and dependencies | Core 210 files/three Ajv dependencies; Node five files/public core dependency; Apache licenses; positive import/file allowlists; public-content audit of all 215 installed files | Passed |
| Reviewable changes and local scope | Separate policy, live acceptance, Node/example and audit commits; no remote push, main merge or npm publication | Passed |

The standalone verifier packs and installs both packages before running six
controlled scenarios. These exercise the actual kernel and SQLite as child
processes, not a replacement execution loop. The example now consumes committed
events with an `onCheckpoint` sequence cursor. Its final answer stays
`unverified` without a task verifier; receipt of model prose does not grant a
passing task verdict. File bytes and operation counts are checked externally.

Review added two write-confinement cases beyond lexical traversal and existing
symlinks: a dangling final symlink and a parent-alias write. All five escaped
reads/writes are rejected before filesystem access; outside files remain
untouched. Final file opens use `O_NOFOLLOW` where available. After adding an
explicit file sync, the three affected write/restart/confinement cases were
rerun against the final unmodified example source in the installed environment.
The source SHA-256 is
`119f1f4b3a2b70d4a29a7fafc36c30c629856aa9bc2147d6b92683d0ff91be48`.
This example assumes no hostile process concurrently replaces workspace
directories; it is not a filesystem sandbox.

Local evidence is retained under the ignored `.artifacts/native-modularization/`:
`real-model.json`, `controlled-standalone.json`, `final-source-writes.json`,
`package-content-audit.json` and `installation.json`. Personal installation paths
and credential selection stay there rather than in published package metadata.
The content audit is the repository's high-confidence public-material check,
not a claim that the separate full-history Gitleaks CI gate was executed.

Reproduction from the repository root:

```sh
node scripts/verify-native-standalone.mjs
node scripts/verify-native-package-boundary.mjs
node --test packages/agentkit-harness-node/test/*.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.contracts.json
node scripts/check-portability.mjs
```

For a real provider, retain an installation with `NATIVE_VERIFY_KEEP=1` and
run `verify-native-installed-live.mjs --installed-dir <installation>` with
connection variables supplied from the local environment. Instructions for
manual local-tarball installation are in `examples/native-standalone/README.md`.
The final focused Node adapter checks passed 4/4, TypeScript contracts passed,
and portability checked 1757 tracked files. The integrated 980-test result was
not repeated for documentation or example-only fixes.

Completion applies only to this finite local goal. No cloud scheduler, cloud
deployment, framework-wide plugin system or general model-quality benchmark is
claimed. Studio/DSH remains the existing product adapter.
