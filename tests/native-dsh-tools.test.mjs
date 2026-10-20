import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { scope } from '../packages/agentkit-harness-core/test/fixtures.mjs';
function setup(t, names = ['write_workspace_file'], contracts = []) {
  const root = mkdtempSync(join(tmpdir(), 'studio-native-tools-')), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new Map(), calls = [];
  let deny = false, postFailure = false;
  const ctx = { effect: install => install(), tools: {
    register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    execute: async input => {
      calls.push(input);
      if (deny) return { isError: true, content: [{ type: 'text', text: 'Policy denied' }] };
      const registered = registry.get(input.name), value = await registered.execute(input.arguments, input);
      if (postFailure) return { isError: true, content: [{ type: 'text', text: 'Post-execution pipeline failed' }] };
      return { isError: false, value, content: registered.output.render(input.arguments, value) };
    },
  } };
  const gateway = createNativeDshTools({ ctx, config: { toolBindings: names, toolContracts: contracts }, workspaceRoot, stateDir: join(root, 'state') });
  const agent = { session: { id: 'session' } };
  const definitions = () => gateway.definitions(agent, [...registry.values()]);
  const request = (arguments_ = { path: 'file.txt', content: 'value' }, name = names[0]) => ({
    scope, runId: 'run', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain',
    operationKey: 'operation', signal: new AbortController().signal, call: { callId: 'provider-id', name, arguments: arguments_ },
    definition: definitions().find(item => item.name === name), interaction: null,
  });
  return { gateway, agent, request, registry, workspaceRoot, calls, ctx,
    deny: () => { deny = true; }, postFailure: () => { postFailure = true; } };
}
test('Native builtin effects require ledger authority and pass through the registry before real writes', async t => {
  const host = setup(t), registered = host.registry.get('write_workspace_file');
  await assert.rejects(registered.execute({ path: 'escape.txt', content: 'not authorized' },
    { agent: host.agent, callId: 'invented', signal: new AbortController().signal }), /studio_native_tool_authority_missing/);
  assert.equal(existsSync(join(host.workspaceRoot, 'escape.txt')), false);
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request());
  assert.equal(result.status, 'ok'); assert.deepEqual(result.workspaceChangedPaths, ['file.txt']);
  assert.equal(readFileSync(join(host.workspaceRoot, 'file.txt'), 'utf8'), 'value');
  assert.match(host.calls[0].callId, /^ak-native-/);
});
test('registry denial prevents a Node write and post-write failure becomes uncertain', async t => {
  const denied = setup(t); denied.deny();
  assert.equal((await denied.gateway.forAgent(denied.agent).tools.execute(denied.request())).status, 'error');
  assert.equal(existsSync(join(denied.workspaceRoot, 'file.txt')), false);
  const failed = setup(t); failed.postFailure();
  const result = await failed.gateway.forAgent(failed.agent).tools.execute(failed.request());
  assert.equal(result.status, 'uncertain'); assert.deepEqual(result.workspaceChangedPaths, ['file.txt']);
  assert.equal(readFileSync(join(failed.workspaceRoot, 'file.txt'), 'utf8'), 'value');
});
test('one admitted registry invocation cannot execute the same Native builtin body twice', async t => {
  const host = setup(t), registered = host.registry.get('write_workspace_file');
  host.ctx.tools.execute = async input => {
    const value = await registered.execute(input.arguments, input);
    await assert.rejects(registered.execute(input.arguments, input), /studio_native_tool_already_dispatched/);
    return { isError: false, value, content: registered.output.render(input.arguments, value) };
  };
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request());
  assert.equal(result.status, 'ok');
  assert.equal(readFileSync(join(host.workspaceRoot, 'file.txt'), 'utf8'), 'value');
});
test('session identity and run identity constrain Native registry calls', async t => {
  const host = setup(t), port = host.gateway.forAgent(host.agent).tools;
  await assert.rejects(port.execute({ ...host.request(), sessionId: 'other' }), /studio_native_tool_not_bound/);
  assert.equal(host.calls.length, 0);
  await port.execute(host.request());
  await port.execute({ ...host.request({ path: 'second.txt', content: 'two' }), runId: 'second-run' });
  assert.notEqual(host.calls[0].callId, host.calls[1].callId);
});
test('unimplemented Node builtins fail explicitly without invoking a Python bridge', async t => {
  const host = setup(t, ['not_yet_ported'], [{ name: 'not_yet_ported', executor: 'builtin', parameters: { type: 'object' } }]);
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'not_yet_ported'));
  assert.equal(result.status, 'error'); assert.match(JSON.stringify(result.content), /STUDIO_NATIVE_BUILTIN_UNAVAILABLE/);
});
test('catalog resource identities resolve to tool names and disabled contracts cannot regain builtin authority', async t => {
  const host = setup(t, ['catalog-file-write', 'workspace_status'], [
    { name: 'write_workspace_file', resourceId: 'catalog-file-write', executor: 'builtin', parameters: { type: 'object' } },
    { name: 'workspace_status', resourceId: 'workspace_status', executor: 'builtin', enabled: false, parameters: { type: 'object' } },
  ]);
  assert.deepEqual([...host.registry.keys()], ['write_workspace_file']);
  assert.equal((await host.gateway.forAgent(host.agent).tools.execute(host.request({ path: 'file.txt', content: 'bound' }, 'write_workspace_file'))).status, 'ok');
  await assert.rejects(host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'workspace_status')), /studio_native_tool_not_bound/);
});
test('MCP names are not replaced by workspace builtins; external failure requires reconciliation', async t => {
  const host = setup(t, ['workspace_status'], [{ name: 'workspace_status', executor: 'mcp', parameters: { type: 'object' } }]);
  assert.equal(host.registry.has('workspace_status'), false);
  host.registry.set('workspace_status', { name: 'workspace_status', parameters: { type: 'object' } });
  host.ctx.tools.execute = async () => ({ isError: true, content: [{ type: 'text', text: 'Acknowledgment lost' }] });
  assert.equal((await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'workspace_status'))).status, 'uncertain');
});
test('external tool additional contexts are retained in the Native receipt', async t => {
  const host = setup(t, ['external']);
  host.registry.set('external', { name: 'external', parameters: { type: 'object' } });
  const contexts = [{ role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'Skill body' }] }];
  host.ctx.tools.execute = async () => ({ isError: false, content: [{ type: 'text', text: 'Loaded' }], additionalContexts: contexts });
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'external'));
  assert.equal(result.status, 'ok'); assert.deepEqual(result.content.additionalContexts, contexts);
  assert.equal(result.context.content, 'Loaded');
  assert.equal(result.additionalContexts[0].content, 'Skill body');
  assert.deepEqual(result.context.presentation.content, [{ type: 'text', text: 'Loaded' }]);
  assert.deepEqual(result.additionalContexts[0].presentation.source, { kind: 'tool', callId: 'provider-id' });
});
test('Native model and display views use the authoritative post-policy receipt', async t => {
  const host = setup(t);
  host.ctx.tools.execute = async input => {
    await host.registry.get(input.name).execute(input.arguments, input);
    return { isError: false, content: [{ type: 'text', text: 'Policy-redacted result' }] };
  };
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request());
  assert.equal(result.context.content, 'Policy-redacted result');
  assert.deepEqual(result.context.presentation.content, [{ type: 'text', text: 'Policy-redacted result' }]);
  assert.deepEqual(result.workspaceChangedPaths, ['file.txt']);
});
test('tool image observations use Host-owned bytes and retain their structured display receipts', async t => {
  const host = setup(t, ['external']), ref = { attachmentId: 'owned-image', name: 'observation.png' };
  host.registry.set('external', { name: 'external', parameters: { type: 'object' } });
  const blocks = [{ type: 'text', text: 'Image observation' }, { type: 'image', attachment: ref }];
  let reads = 0;
  host.ctx.get = name => name === 'attachments' ? { readImageRequest: async receipt => {
    assert.deepEqual(receipt, ref); reads++; return { mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) };
  } } : undefined;
  host.ctx.tools.execute = async () => ({ isError: false, content: blocks });
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'external'));
  assert.equal(reads, 1); assert.equal(result.context.content, 'Image observation');
  assert.equal(result.context.media[0].image_url.url, 'data:image/png;base64,AQID');
  assert.deepEqual(result.context.presentation.content, blocks);
  assert.notEqual(result.context.presentation.content, blocks);
});
