# AgentKit Studio

AgentKit Studio is a product plugin for the public [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host. It provides Agent authoring, resource management, local conversations, deployment controls, automation, and plugin discovery in the Harness Web and desktop surfaces.

The Studio plugin is designed to run with the pinned DSH host version declared in [CONTRIBUTING.md](CONTRIBUTING.md). This repository contains Studio code, compatibility patches, tests, and packaging scripts; it does not vendor the DSH source tree or user credentials.

## What it provides

- Agent creation and revision-based editing with model, MCP, Skill, knowledge, and memory bindings.
- Native DSH conversations for Studio, Codex, and AgentKit Harness runtimes.
- Host-owned resource discovery and lifecycle operations.
- Build, deployment, automation, channel, and operational surfaces through typed Host APIs.
- DSH plugin discovery with curated official bundles and post-install capability checks.
- Portable build artifacts that keep credentials in the destination Host.

Cloud features require a compatible AgentEngine control plane and credentials configured in the Host. A local test or a visible catalog entry does not prove access to a cloud resource.

## Development setup

Requirements:

- Node.js `22.19.0` with development headers
- pnpm `10.33.2`, Corepack, Git, Make, and a native compiler toolchain
- A checkout of the pinned DSH source tree, kept outside this repository

```sh
corepack enable
make setup DSH_ROOT=../deepseek-harness
make dev DSH_ROOT=../deepseek-harness
```

Use `DSH_HOME` and `AGENTKIT_HOME` to isolate local profiles and Studio data. Do not copy another user's profile or credentials into the repository.

## Checks

```sh
pnpm install --frozen-lockfile
make check
make pack
make release-check
```

`make check` runs syntax, portability, source-size, contract, and product-surface checks. `make release-check` additionally validates package contents, DSH patch format, and archive integrity.

The curated DSH plugin market can be verified against a real pinned Host in an isolated profile:

```sh
AGENTKIT_DSH_ROOT=/path/to/deepseek-harness \
AGENTKIT_DSH_HOME=/tmp/agentkit-studio-dsh \
pnpm verify-dsh-plugin-market --execute --all
```

The verification command does not approve dependency build scripts automatically and never uses a personal profile unless the caller explicitly supplies it.

## Repository layout

- `src/` — Studio Host and browser implementation
- `src/client-fragments/` — browser UI fragments assembled into `dist/client.js`
- `patches/` — versioned compatibility patches for the pinned DSH release
- `scripts/` — build, package, portability, and Host verification tools
- `tests/` — unit, contract, packaging, and product-surface tests
- `docs/brand/` — public visual guidance

## Contributions

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes that affect the Host contract, packaging, credentials, runtime behavior, or public release path need focused tests and fresh verification before review.
