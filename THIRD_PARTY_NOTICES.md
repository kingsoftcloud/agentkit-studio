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
