import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshNodeBuiltins } from '../src/providers/dsh-node-builtins.mjs';
import { DSH_NODE_BUILTIN_NAMES } from '../src/providers/dsh-node-builtin-catalog.mjs';
import { sandboxRegistryName } from '../src/providers/sandbox-code-name.mjs';
import { createStudioSkillManagement } from '../src/skill-management.mjs';
import { createStudioKnowledgeTools } from '../src/knowledge-tools.mjs';
import { createLegacyMemoryTools } from '../src/legacy-memory-tools.mjs';

const reference = JSON.parse(readFileSync(new URL('./fixtures/native-reference-builtin-catalog.json', import.meta.url)));
const expected = [...reference.ordinary, ...reference.resourceTools].map(sandboxRegistryName).sort();

test('the reference inventory has a real Node owner for every ordinary and selected resource tool', async t => {
  assert.equal(reference.ordinary.length, 31);
  assert.equal(new Set(expected).size, 34);
  assert.deepEqual([...DSH_NODE_BUILTIN_NAMES].sort(), expected);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-node-inventory-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const workspaceRoot = join(base, 'workspace'), stateDir = join(base, 'state');
  mkdirSync(workspaceRoot); mkdirSync(stateDir, { mode: 0o700 });
  const unused = async () => assert.fail('inventory assembly must not dispatch a service or a model');
  const connection = { bindingDigest: 'a'.repeat(64), client: { skillAction: unused, action: unused } };
  const agentId = 'inventory-agent';
  const knowledge = createStudioKnowledgeTools({ agentId, connection });
  const memory = createLegacyMemoryTools({ agentId, root: join(stateDir, 'memory'), workspaceRoot });
  t.after(() => Promise.all([knowledge.close(), memory.close()]));
  const management = createStudioSkillManagement({ agentId, workspaceRoot, stateDir,
    skillDiscovery: { registerBundleSkills: unused, listInstalled: unused }, agents: { get: unused, update: unused },
    source: { search: unused, inspect: unused } });
  const port = createDshNodeBuiltins({ agentId, agentRevision: 1, buildId: 'inventory-build', workspaceRoot, stateDir,
    ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, approval: { request: unused } },
    env: { KSADK_SANDBOX_BACKEND: 'local_process', KSADK_SKILL_RUNTIME_BACKEND: 'local_process' },
    toolBindings: reference.ordinary.concat(reference.resourceTools), skillConnection: connection,
    getSkillManagement: () => management, getKnowledgeTools: () => knowledge, getLegacyMemoryTools: () => memory });
  t.after(() => port.close());
  assert.deepEqual(port.definitions.map(tool => tool.name).sort(), expected);
  for (const name of expected) assert.equal(port.supports(name), true, name);
  for (const name of [...reference.excludedMeta, 'run_code', 'workspace', 'nonexistent_builtin'])
    assert.equal(port.supports(name), false, name);
  const args = { path: 'inventory.txt', content: 'Actual composed workspace port' };
  const result = await port.execute('write_workspace_file', args, { name: 'write_workspace_file', arguments: args,
    callId: 'inventory-write', agent: { session: { id: 'inventory-session' } }, signal: new AbortController().signal });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(readFileSync(join(workspaceRoot, args.path), 'utf8'), args.content);
  // Returned schemas cannot alter the private ownership map or other callers.
  port.definitions[0].name = 'tool_dispatcher';
  assert.deepEqual(port.definitions.map(tool => tool.name).sort(), expected);
});
