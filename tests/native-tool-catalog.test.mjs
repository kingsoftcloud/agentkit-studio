import test from 'node:test';
import assert from 'node:assert/strict';
import { listStudioTools, nativeLocalToolContract } from '../src/native-tool-catalog.mjs';
import { workspacePatchDefinition } from '../packages/agentkit-harness/src/native/workspace-tools.mjs';
import { createResourceRoutes } from '../src/host/routes/resources.mjs';

test('Native catalog merges all legacy pages before paging and keeps the local writer contract', async () => {
  const calls = [], serverClient = { listCatalogResources: async query => {
    calls.push(query);
    return query.cursor === 'legacy-page-2'
      ? { items: [{ resourceId: 'second', name: 'second' }], nextCursor: null }
      : { items: [{ resourceId: 'first', name: 'first' }, { resourceId: 'apply_workspace_patch', contract: { executor: 'forged' } }], nextCursor: 'legacy-page-2' };
  } };
  const query = { kind: 'tool', runtimeType: 'harness', limit: 1 };
  const rows = []; let cursor;
  do { const page = await listStudioTools({ query: { ...query, cursor }, serverClient });
    assert.equal(page.items.length, 1); assert.equal(page.total, 6); rows.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(rows.map(row => row.resourceId), ['apply_workspace_patch', 'list_workspace_checkpoints', 'preview_workspace_rewind', 'rewind_workspace_files', 'first', 'second']);
  assert.equal(rows[0].contract.executor, 'builtin');
  assert.deepEqual(rows[0].contract.inputSchema, workspacePatchDefinition().parameters);
  assert.ok(calls.every(call => call.limit === 200));
  const contract = nativeLocalToolContract(rows[0].resourceId);
  assert.deepEqual(contract.permissions, ['workspace:write', 'workspace:delete']); assert.equal(contract.sideEffect, 'workspace');
  contract.parameters.required.push('forged'); assert.deepEqual(nativeLocalToolContract(rows[0].resourceId).parameters.required, ['patch_text']);
  assert.equal(nativeLocalToolContract('unknown'), undefined);
});

test('resource route exposes the local Native tool when the optional old catalog is absent', async () => {
  const serverClient = { listCatalogResources: async () => { throw Object.assign(Error('Absent'), { code: 'CATALOG_UNAVAILABLE' }); } };
  const routes = createResourceRoutes({ serverClientPromise: Promise.resolve(serverClient) });
  const result = await routes('resources/list', { kind: 'tool', runtimeType: 'harness', query: '结构化', source: 'local' });
  assert.equal(result.ok, true); assert.equal(result.value.items[0].resourceId, 'apply_workspace_patch');
  assert.equal(result.value.warnings[0].code, 'CATALOG_UNAVAILABLE');
  const cloud = await routes('resources/list', { kind: 'tool', runtimeType: 'harness', source: 'cloud' });
  assert.equal(cloud.value.items.length, 0);
  const unavailable = await routes('resources/list', { kind: 'tool', runtimeType: 'harness', status: 'disabled' });
  assert.equal(unavailable.value.items.length, 0);
  await assert.rejects(routes('resources/list', { kind: 'tool', runtimeType: 'harness', query: 'changed', cursor: 'invalid' }), { code: 'INVALID_RESOURCE_CURSOR' });
});

test('other engines preserve their catalog request, response and opaque cursor', async () => {
  for (const runtimeType of [undefined, 'dsh-native', 'codex']) {
    const response = { items: [{ resourceId: 'remote-only' }], nextCursor: 'opaque-remote' };
    const calls = [], serverClient = { listCatalogResources: async (...args) => { calls.push(args); return response; } };
    const controller = new AbortController();
    const result = await listStudioTools({ query: { runtimeType, query: 'remote', limit: 3, cursor: 'opaque', source: 'local', status: 'available' }, serverClient, signal: controller.signal });
    assert.equal(result, response);
    assert.deepEqual(calls, [[{ kind: 'tool', query: 'remote', limit: 3, cursor: 'opaque', source: 'local', status: 'available' }, { signal: controller.signal }]]);
  }
});

test('Native catalog does not hide cancellation or real errors and bounds malformed paging', async () => {
  for (const code of ['SERVER_INVALID_RESPONSE', 'UNAUTHORIZED']) {
    await assert.rejects(listStudioTools({ query: { runtimeType: 'harness' }, serverClient: {
      listCatalogResources: async () => { throw Object.assign(Error(code), { code }); },
    } }), { code });
  }
  await assert.rejects(listStudioTools({ query: { runtimeType: 'harness' }, serverClient: {
    listCatalogResources: async () => ({ items: [], nextCursor: 'same' }),
  } }), { code: 'INVALID_RESOURCE_CURSOR' });
  const controller = new AbortController(); controller.abort(); let requests = 0;
  await assert.rejects(listStudioTools({ query: { runtimeType: 'harness' }, signal: controller.signal,
    serverClient: { listCatalogResources: async () => { requests++; } } }), { name: 'AbortError' });
  assert.equal(requests, 0);
});
