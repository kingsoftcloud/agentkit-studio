# Third-party source notices

`packages/agentkit-harness-core/src/patch-parser.mts` and `patch-apply.mts`
preserve ZCode's structured patch parser and pure hunk application from commit
`3c5b227649371507ddc4eb46ac5133afe6db1cab`, paths
`apps/zcode-cli/packages/core/src/tool/{patch-parser,patch-apply}.ts`.
Only attribution headers, local module extensions and optional-property type
annotations required by Native's stricter compiler change. The Native adapter
owns path confinement, permissions, snapshots, publication and recovery.
The Apache-2.0 license is preserved in `third-party/ZCode-LICENSE`.

`packages/agentkit-harness-core/src/edit-matchers.mts` preserves the standalone
matching algorithm from ZCode commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`,
`apps/zcode-cli/packages/core/src/tool/edit-matchers.ts`, with an attribution
header added. Native adapts its results at the workspace boundary, retains its
own read-state/publication checks and runs matching in a bounded Node worker.
This Apache-2.0 source is covered by `third-party/ZCode-LICENSE`.

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
digests. The packaged `packages/agentkit-harness-node/dist/native-command-plan.mjs` bundles these modules with
`unbash@4.0.1`; notices are included in `packages/agentkit-harness-node/dist/native-command-plan.LICENSE.txt`.
This module classifies Plan permissions only and supplies no execution engine.

`packages/agentkit-harness-core/src/memory-extraction-scheduler.mts` adapts
ZCode's extraction eligibility, single-flight scheduler, pending-work
coalescing and cancellation from the same pinned commit, file
`apps/zcode-cli/packages/core/src/memory/extraction.ts`. Native substitutes
its own message type and adds a Host-persisted cursor callback; it does not
reuse ZCode's memory prompt or file tools. This modified Apache-2.0 source is
covered by `third-party/ZCode-LICENSE`.

`packages/agentkit-harness-node/src/native/model-anthropic-cache.mjs` adapts the
stable-system-prefix and latest-conversation breakpoint behavior from that
commit's `apps/zcode-cli/packages/core/src/context/builder.ts` and
`apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`.
Native projects provider wire messages without changing its durable transcript.
The ZCode reference is Apache-2.0 and its license is preserved in
`third-party/ZCode-LICENSE`.

`packages/agentkit-harness-core/src/todos.mts` and
`coordinator-response.mts` adapt ZCode's `TodoRead`/`TodoWrite` and
`RespondToCoordinator` tool shapes and result behavior from the same pinned
commit: `apps/zcode-cli/packages/contracts/src/tools/{todo,respond-to-coordinator}.ts`
and `apps/zcode-cli/packages/core/src/tool/handlers/{todo,respond-to-coordinator}.ts`.
Native implements its own receipt commit and child-owner checks. These adapted
Apache-2.0 interfaces and behaviors are covered by `third-party/ZCode-LICENSE`.

Other modules refer to ZCode as a behavioral benchmark without importing its
source layout, including plan-mode rules, MCP destructive hints, local context
pruning thresholds, model continuation and workspace rewind. Their comments
identify the relevant reference; the attribution above names retained or
adapted source more directly.
