import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.artifacts/native-architecture'); mkdirSync(directory, { recursive: true });
const groups = {
  core: ['packages/agentkit-harness-core/test/model-surface.test.mjs',
    'packages/agentkit-harness-core/test/tool-discovery.test.mjs',
    'packages/agentkit-harness-core/test/context-planning.test.mjs',
    'packages/agentkit-harness-core/test/tool-error-recovery.test.mjs'],
  workspace: ['packages/agentkit-harness-node/test/native-workspace-media.test.mjs',
    'packages/agentkit-harness-node/test/native-workspace.test.mjs'],
  host: ['tests/native-model-surface-host.test.mjs', 'tests/native-model-surface.test.mjs',
    'tests/native-context-ownership.test.mjs', 'tests/native-mcp-output.test.mjs'],
  execution: ['packages/agentkit-harness-node/test/native-local-output-policy.test.mjs',
    'packages/agentkit-harness-node/test/native-local-process.test.mjs', 'tests/native-local-execution.test.mjs'],
  children: ['tests/native-child-allocation.test.mjs', 'tests/native-child-allocation-integration.test.mjs',
    'packages/agentkit-harness-core/test/child-budget.test.mjs', 'packages/agentkit-harness-core/test/child-budget-kernel.test.mjs',
    'tests/agent-native-role-form.test.mjs', 'tests/native-child-declarations.test.mjs'],
  'child-host': ['tests/studio-native-children.test.mjs'],
  instructions: ['tests/native-dsh-tools.test.mjs', 'tests/studio-native-skills-disclosure.test.mjs'],
};
const patterns = {
  'child-host': 'deferred child controls|default discovery follows inherited child MCP|production Host confines a writing child|SQLite Host grants inherited MCP|child continuation keeps the borrowed source|memory: Host control route cancel',
  instructions: 'instruction|Skill|skill',
};
const args = process.argv.slice(2);
const only = args.length === 2 && args[0] === '--only' ? args[1] : null;
if (args.length && !Object.hasOwn(groups, only)) throw Error(`Usage: node scripts/verify-native-model-surface.mjs [--only ${Object.keys(groups).join('|')}]`);
const results = [];
for (const [group, files] of Object.entries(groups)) {
  if (only && group !== only) continue;
  const started = Date.now();
  const pattern = patterns[group];
  const result = spawnSync(process.execPath, ['--test', ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(directory, `${group}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  const passed = result.status === 0 && !result.error;
  results.push({ group, files, ...(pattern ? { pattern } : {}), passed, elapsedMs: Date.now() - started,
    tests: Number(/(?:ℹ|#) tests (\d+)/.exec(result.stdout ?? '')?.[1] ?? 0) });
  console.log(JSON.stringify(results.at(-1)));
  if (!passed) { process.exitCode = 1; break; }
}
writeFileSync(join(directory, only ? `acceptance-${only}.json` : 'acceptance.json'), JSON.stringify({
  schemaVersion: 'agentkit.native-model-surface-acceptance/v1', results,
  modelResponses: 'controlled', fullSuite: false, remotePush: false, mergeMain: false,
}, null, 2) + '\n');
