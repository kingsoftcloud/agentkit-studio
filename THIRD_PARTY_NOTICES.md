# Third-party source notices

`packages/agentkit-harness-core/src/tool-search-ranking.mts` adapts the tool
ranking algorithm and MCP name normalization from [ZCode](https://github.com/zai-org/ZCode),
commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`, files
`apps/zcode-cli/packages/core/src/tool/search/search.ts` and
`apps/zcode-cli/packages/core/src/mcp/name.ts`.
The local adaptation replaces package imports with Native-local types and
retains the ranking, exact selection, aliases and MCP matching behavior.
ZCode supplies this source under Apache-2.0; its license is preserved in
`third-party/ZCode-LICENSE`.

`third-party/zcode-command-plan/` preserves ZCode's standalone POSIX command
parser, read-only argument policies and Git runtime checks from the same pinned
commit. Its `index.ts` extracts `isRuntimeReadOnlyBashCommand` from
`apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.ts`; the remaining
source modules are unchanged. `source.json` records their paths and SHA-256
digests. The packaged `dist/native-command-plan.mjs` bundles these modules with
`unbash@4.0.1`; notices are included in `dist/native-command-plan.LICENSE.txt`.
This module classifies Plan permissions only and supplies no execution engine.
