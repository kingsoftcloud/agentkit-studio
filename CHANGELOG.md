# Changelog

## 0.0.2

- Display the installed desktop build separately from the Studio plugin and pinned DSH versions.
- Pass the official DSH Session workspace to each Codex child and thread instead of writing in the system temporary directory.
- Preserve native DSH tool-mode and file-delivery guidance for Harness steps; expose the official present tool to Codex through scoped native/PTC dispatch.
- Bound model stream silence instead of terminating active local Harness/DSH replies after three minutes.
- Preserve the official macOS Code Mode host entitlements required for actual Codex tool execution.
- Preserve image-only and mixed image input for bound local Agents through DSH attachment storage, Harness model requests and native Codex image inputs.
- Preserve multimodal model capabilities advertised by nested `/v1/models` metadata.
- Keep long-running Codex turns alive while progress continues, with idle and explicit total budgets.
- Keep the in-app browser registration active and ship the independent Harness plugin verification path.

## 0.0.1

- Initial AgentKit Studio plugin package for the public DSH host.
- Agent authoring, resource binding, native conversations, deployment, automation, and channel surfaces.
- Codex and DSH plugin lifecycle integration.
- Curated official DSH plugin entries with post-install Host capability verification.
