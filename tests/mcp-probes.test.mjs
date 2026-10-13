import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpProbes } from '../src/mcp-probes.mjs';

test('cloud MCP observations survive reload and failures replace stale success', async () => {
  const storeDir = await mkdtemp(join(tmpdir(), 'studio-cloud-probe-'));
  try {
    let failed = false;
    const calls = [];
    const localStore = async () => ({ get: async () => null });
    const adapters = async () => ({ listMcpTools: async resource => {
      calls.push(resource);
      if (failed) throw Object.assign(new Error('MCP 鉴权失败'), { code: 'MCP_AUTH_FAILED' });
      return [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }];
    } });
    const probes = createMcpProbes({ storeDir, localStore, adapters });
    assert.equal((await probes.probe('mcp-cloud')).toolCount, 1);
    const restored = createMcpProbes({ storeDir, localStore, adapters });
    assert.equal((await restored.get('mcp-cloud')).contract.discoveredTools[0].name, 'search');
    failed = true;
    await assert.rejects(() => restored.probe('mcp-cloud'), { code: 'MCP_AUTH_FAILED' });
    assert.equal((await probes.get('mcp-cloud')).status, 'error');
    assert.equal((await probes.get('mcp-cloud')).contract, undefined);
    assert.deepEqual(calls, [{ resourceId: 'mcp-cloud' }, { resourceId: 'mcp-cloud' }]);
    await assert.rejects(() => probes.probe('mcp-local-missing'), { code: 'MCP_NOT_FOUND' });
  } finally { await rm(storeDir, { recursive: true, force: true }); }
});
