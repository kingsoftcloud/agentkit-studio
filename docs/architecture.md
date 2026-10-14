# Architecture

AgentKit Studio is a DSH product plugin. The host owns Agent composition, Sessions,
persistence, stream events, tools, file delivery and desktop/browser surfaces.
Studio adds Agent editing, resource bindings, product settings and release wiring.

## Packages and source

| Path | Responsibility |
| --- | --- |
| `src/` | Studio Host services, API adapters and product plugin |
| `src/client/` | Browser modules, per-apply composition and DSH UI extensions |
| `src/providers/` | DSH Native, AgentKit Harness and Codex runtime integration |
| `packages/agentkit-harness/` | Independently packed DSH runtime plugin |
| `patches/` | Reviewed changes against the pinned public DSH host |
| `tests/` | Unit, contracts and packaging regressions |
| `scripts/` | Development, real Host verification, packaging and release tools |
| `assets/`, `docs/`, `.github/` | Identity, public guides and CI |

## Runtime ownership

`src/runtime-contract.mjs` freezes runtime identity, Build, Session and Run bindings.
DSH Native uses upstream execution directly. AgentKit Harness uses DSH's Agent,
Session, LLM and streaming protocol; it does not introduce another persistence
format. Codex requires an adapter for its child process and tool protocol, while
native file delivery still goes through the DSH Session's tools.

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
