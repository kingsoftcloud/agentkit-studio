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

Core, Node adapters and task UI are consumed from fixed npm releases of
[ksadk-harness](https://github.com/kingsoftcloud/ksadk-harness). Studio does not
compile a local copy. Its tests cover installed public contracts and Host/product
integration; the independent repository owns implementation tests and publishing.

Codex and DSH Native keep their own execution paths. The old Harness DSH plugin,
legacy local tool loop and ambient `legacy` selector have been removed. Old Harness
Builds without a Native pin are rejected and must be recreated; persisted DSH
text is never treated as proof of a Native side effect.

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
