// Build-only adapter: both permission consumers use the same pinned parser.
// Keep reference sources and their upstream hashes unchanged.
export { isRuntimeReadOnlyBashCommand } from '../third-party/zcode-command-plan/index.ts';
export { parse as parseBashSyntax } from 'unbash';
