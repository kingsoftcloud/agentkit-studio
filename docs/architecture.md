# Architecture

AgentKit Studio is a DSH product plugin. The host owns Agent composition, Sessions,
transcript persistence, stream events, tools, file delivery and desktop/browser surfaces.
Studio adds Agent editing, resource bindings, product settings and release wiring.

Native serves business and coding Agents through the same execution authority;
specific capability policies compose above the general execution mechanisms.

## Packages and source

| Path | Responsibility |
| --- | --- |
| `src/` | Studio Host services, API adapters and product plugin |
| `src/client/` | Browser modules, per-apply composition and DSH UI extensions |
| `src/providers/` | DSH Native, AgentKit Harness and Codex runtime integration |
| `packages/agentkit-harness-core/` | Host-independent TypeScript Native contracts, state machine and execution kernel |
| `packages/agentkit-harness/src/native/` | Node model, SQLite, workspace and other Native port adapters, shipped with Studio |
| `packages/agentkit-harness/` | DSH facade; its standalone package contains only the facade and model adapter |
| `patches/` | Reviewed changes against the pinned public DSH host |
| `tests/` | Unit, contracts and packaging regressions |
| `scripts/` | Development, real Host verification, packaging and release tools |
| `assets/`, `docs/`, `.github/` | Identity, public guides and CI |

## Runtime ownership

`src/runtime-contract.mjs` freezes runtime identity, Build, Session and Run bindings.
DSH Native uses upstream execution directly. New AgentKit Harness Revisions and
Builds default to `agentkit.native-dsh-turn/v1`. The Native kernel owns the full
model/tool loop, budgets, retries and side-effect scheduling. DSH delegates the
turn through its maintained external-turn interface; it must not run a second
tool loop or retry the same Native effects. Missing Host capabilities reject
admission rather than falling back to a model interceptor.

The TypeScript core does not depend on DSH objects or the UI. Node adapters persist
Native Run state, commands, intents, receipts and events in SQLite. DSH continues
to own the product Session and transcript. Versioned ownership and delivery
projections connect the two stores; recovery retains the original Run identity,
configuration and effect history. Unknown side effects require reconciliation
instead of blind replay.

Codex uses its existing child-process and tool adapter. DSH Native and Codex keep
their execution paths; file delivery continues through DSH Session tools. The
standalone Harness facade's model adapter remains available for independent DSH
consumers, but installing that facade alone does not install Studio's Native
execution engine. See the [package boundary](../packages/agentkit-harness/README.md).

Old Frozen Builds preserve their engine pin. The trusted Host can select `legacy`
for new admissions without rewriting existing Native Runs.

Resources and credentials are resolved in the trusted Host. Browser components
receive capability/status information and typed operations. They do not own model
credentials, cloud signing keys or runtime process state.

## Compatibility and distribution

The Makefile pins the upstream DSH tag and commit. Packaging applies the patch
series in an isolated checkout and verifies the actual archive module graph.
The live development checkout is not a release input.

macOS and Windows packages ship the same Studio code and runtime contract with
platform-specific installer/update checks. npm packages remain DSH plugins. A new
upstream baseline requires fresh compatibility and real Host evidence before its
pin changes.
