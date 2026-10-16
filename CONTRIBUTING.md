# Contributing to AgentKit Studio

AgentKit Studio extends the public DeepSeek Harness host. Keep changes focused on Studio behavior and public host contracts; do not copy the DSH source tree into this repository.

## Setup

```sh
corepack enable
make setup DSH_ROOT=../deepseek-harness
```

The DSH checkout must match the version and commit declared by the repository Makefile. Keep the checkout and all user data outside Git.

Edit browser sources under `src/client/`; do not commit generated `dist/` files.
For a source-linked plugin, run `pnpm build:client` before loading it in DSH.
Normal checks, tests and packing run this build through their lifecycle hooks.
The package allowlist deliberately includes `dist/` even though Git ignores it.

## Local validation

Run the smallest relevant checks first, then the complete package gate for changes that affect the product surface or release package:

```sh
node --check src/index.mjs
node --test tests/local-resource-adapters.test.mjs
make check
make release-check
```

Browser or Host changes also require the corresponding real DSH verification. Use an isolated `DSH_HOME`; do not place credentials, profiles, downloads, or runtime artifacts in the repository.

Native macOS qualification rebuilds the client from the exact signed source
commit and its frozen lockfile in a disposable directory, then compares those
bytes with the installed ASAR. The qualification tools may come from a newer
commit; their own client bundle is never the expected signed artifact.

Host patches are generated from the pinned maintenance branch archived in
`host-source/`. Restore it with `make patch-source-import`, edit and test the
maintenance commits, then run `make patch-source-export` and
`make patch-source-verify`. See [the maintenance guide](docs/refactor-patches.md)
for the checkout variables and metadata requirements. Direct patch edits fail the
build's source synchronization gate.

## Public release rules

- Keep source, tests and public guides free of credentials, customer data, personal paths, team plans and private deployment evidence. Service endpoint configuration follows the documented Host contract.
- Do not commit `.env` files, profiles, private keys, temporary URLs, generated caches, or `.artifacts` output.
- Do not claim a cloud, native Host, or desktop result from a fixture or a source-only test.
- Package and workflow changes require `make release-check` and a clean `git diff --check`.
- Public `main` changes go through a pull request with required CI and security checks. Release artifacts are produced by GitHub Actions from an approved `main` commit.

## Commit and pull request guidance

Use a single-purpose conventional commit message, add regression coverage for behavior changes, and describe the validation that was actually run. Do not push a release or publish an artifact until review and repository gates have passed.
