# AgentKit Studio

[官网与下载](https://kingsoftcloud.github.io/agentkit-studio/) · [文档索引](docs/README.md) · [GitHub Releases](https://github.com/kingsoftcloud/agentkit-studio/releases)

AgentKit Studio is a product plugin for the public [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host. It provides Agent authoring, resource management, local conversations, deployment controls, automation, and plugin discovery in the Harness Web and desktop surfaces.

The Studio plugin is designed to run with the pinned DSH host version declared in [CONTRIBUTING.md](CONTRIBUTING.md). This repository contains Studio code, compatibility patches, tests, and packaging scripts; it does not vendor the DSH source tree or user credentials.

## What it provides

- Agent creation and revision-based editing with model, MCP, Skill, knowledge, and memory bindings.
- Native DSH conversations for Studio, Codex, and Star Harness runtimes.
- Host-owned resource discovery and lifecycle operations.
- Build, deployment, automation, channel, and operational surfaces through typed Host APIs.
- DSH plugin discovery with curated official bundles and post-install capability checks.
- Portable build artifacts that keep credentials in the destination Host.

Cloud features require a compatible AgentEngine control plane and credentials configured in the Host. A local test or a visible catalog entry does not prove access to a cloud resource.

## Install and use

Start with the [desktop and development guide](docs/getting-started.md), or browse
[GitHub Releases](https://github.com/kingsoftcloud/agentkit-studio/releases).
The [documentation index](docs/README.md) covers runtimes, plugin development,
signing and updates.

## Development setup

Requirements:

- Node.js `22.23.4` (or `24.22.1+`) with development headers
- pnpm `10.33.2`, Corepack, Git, Make, and a native compiler toolchain
- A checkout of the pinned DSH source tree, kept outside this repository

```sh
corepack enable
make setup DSH_ROOT=../deepseek-harness
make dev DSH_ROOT=../deepseek-harness
```

Use `DSH_HOME` and `AGENTKIT_HOME` to isolate local profiles and Studio data. Do not copy another user's profile or credentials into the repository.

`dist/` is generated locally and is not tracked in Git. `make dev` (or
`make web-dev`) rebuilds and installs the plugin before launch. Desktop build and
launch targets also build the client first. `pnpm check`, `pnpm test` and
`pnpm pack` rebuild it automatically; packaged plugins still include `dist/client.js`.

## Experts and cloud personal assistant

The Agents panel includes an original expert catalog, resource templates and local teams built on official DSH Agent Teams. Existing Agents still use the same editor, frozen revisions and native conversations. See [expert catalog and local teams](docs/expert-catalog.md).

The cloud personal assistant is now a separate DSH client plugin: install `@kingsoftcloud/agentkit-personal-assistant`. Studio keeps the Agent catalog, preset binding and the DSH Native cloud runtime that plugin talks to; the in-app assistant panel, its opening wizard and its desktop-side transport are no longer part of this repository.

## Checks

```sh
pnpm install --frozen-lockfile
make check
make pack
make release-check
make public-gate
```

`make check` runs syntax, portability, source-size, contract, and product-surface checks. `make release-check` additionally validates package contents, DSH patch format, and archive integrity.
`make public-gate` is the shared source, package, and public-surface gate used by
both forge pipelines. The read-only [`branch-sync.md`](docs/branch-sync.md)
contract describes the separate exact-ref parity check.

The curated DSH plugin market can be verified against a real pinned Host in an isolated profile:

```sh
AGENTKIT_DSH_ROOT=/path/to/deepseek-harness \
AGENTKIT_DSH_HOME=/tmp/agentkit-studio-dsh \
pnpm verify-dsh-plugin-market --execute --all
```

The verification command does not approve dependency build scripts automatically and never uses a personal profile unless the caller explicitly supplies it.

## Repository layout

- `src/` — Studio Host and browser implementation
- `src/client/` — browser ES Modules with scoped state and page composition, bundled into `dist/client.js`
- `packages/agentkit-harness/` — independently packaged DSH runtime plugin
- `examples/` — minimal public configuration examples
- `docs/` — usage, architecture and release guides
- `patches/` — versioned compatibility patches for the pinned DSH release
- `scripts/` — build, package, portability, and Host verification tools
- `tests/` — unit, contract, packaging, and product-surface tests
- `docs/brand/` — public visual guidance

## Contributions

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes that affect the Host contract, packaging, credentials, runtime behavior, or public release path need focused tests and fresh verification before review.
