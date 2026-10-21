import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { scope, fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { snapshotNativeMcpSchema } from '../src/providers/native-mcp-schema.mjs';
import { NATIVE_PYTHON_SYNTAX } from '../packages/agentkit-harness/src/native/python-syntax.mjs';
test('only an owned lint builtin pins the workspace syntax engine', t => {
  assert.deepEqual(setup(t, ['lint_workspace_file']).gateway.workspaceSyntax, NATIVE_PYTHON_SYNTAX);
  assert.equal(setup(t).gateway.workspaceSyntax, null);
  assert.equal(setup(t, ['lint_workspace_file'], [{ name: 'lint_workspace_file', executor: 'mcp', resourceId: 'remote' }],
    { executeMcpTool: async () => ({ content: [] }) }).gateway.workspaceSyntax, null);
});
function setup(t, names = ['write_workspace_file'], contracts = [], options = {}) {
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
  if (options.argumentEncodings) ctx.tools.argumentEncodings = options.argumentEncodings;
  const gateway = createNativeDshTools({ ctx, config: { toolBindings: names, toolContracts: contracts }, workspaceRoot, stateDir: join(root, 'state'), ...options });
  t.after(() => gateway.close());
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

for (const invalidOutput of [false, true]) test(`Native MCP pins exact input/output schemas through the ledger (invalid output: ${invalidOutput})`, async t => {
  const integer = 9007199254740993n;
  const parameters = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: integer, maximum: integer } } };
  const nativeMcpSchema = JSON.parse(JSON.stringify(snapshotNativeMcpSchema({ inputSchema: parameters, outputSchema: parameters })));
  let effects = 0, models = 0;
  const reply = { content: [], structuredContent: { id: invalidOutput ? integer - 1n : integer }, _meta: { private: 'do-not-send' } };
  const contract = { name: 'exact', executor: 'mcp', resourceId: 'remote', nativeMcpSchema };
  const host = setup(t, ['exact'], [contract], {
    argumentEncodings: ['dsh.raw-json-number/v1'], executeMcpTool: async request => {
      effects++; assert.equal(request.resourceId, 'remote');
      assert.equal(JSON.stringify(request.arguments), '{"id":9007199254740993}'); return reply;
    },
  });
  contract.resourceId = 'changed-after-binding';
  contract.nativeMcpSchema.outputJson = '{"not":{}}';
  const request = host.request({ id: integer }, 'exact');
  assert.deepEqual(request.definition.parameters, parameters);
  const { config, snapshot } = fixture({ tools: [request.definition] }), store = new MemoryRunStore();
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: { ...host.gateway.forAgent(host.agent), model: {
    generate: async input => {
      models++;
      if (models <= 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ ...request.call,
        callId: `schema-${models}`, arguments: { id: models === 1 ? integer - 1n : integer } }] };
      const results = input.messages.filter(message => message.role === 'tool');
      assert.match(results[0].content, /invalid_arguments/);
      assert.equal(results[1].content.includes('mcp_output_schema_invalid'), invalidOutput);
      assert.equal(results[1].content.includes('do-not-send'), false);
      return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
    },
  } } });
  kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(effects, 1); assert.equal(host.calls.length, 1);
  const receipts = store.load(scope, 'run').receipts.flatMap(receipt => receipt.result.results ?? []);
  const receipt = receipts.find(result => result.content?.structuredContent);
  assert.deepEqual(receipt.content, reply);
  assert.equal(receipt.status, invalidOutput ? 'error' : 'ok');
  await kernel.runUntilIdle(scope, 'run'); assert.equal(effects, 1); assert.equal(models, 3);
  assert.throws(() => host.gateway.definitions(host.agent, [{ name: 'exact', parameters: { type: 'object' } }]), /studio_native_mcp_schema_binding_changed/);
});

test('Native owns revision-bound MCP receipts while post-policy output controls the model view', async t => {
  const invoked = [], reply = { content: [{ type: 'text', text: 'known answer' }], structuredContent: { count: 7 }, isError: false };
  const host = setup(t, ['lookup'], [{ name: 'lookup', executor: 'mcp', mcpResourceId: 'catalog' }], {
    executeMcpTool: async input => { invoked.push(input); return reply; },
  });
  const port = host.gateway.forAgent(host.agent).tools;
  const output = await port.execute(host.request({}, 'lookup'));
  assert.equal(output.status, 'ok'); assert.deepEqual(output.content, reply);
  assert.match(output.context.content, /"structuredContent":\{"count":7\}/);
  assert.equal(invoked[0].resultFormat, 'mcp-result/v1'); assert.equal(invoked[0].resourceId, 'catalog');
  const execute = host.ctx.tools.execute;
  host.ctx.tools.execute = async input => ({ ...await execute(input), content: [{ type: 'text', text: 'Host redacted result' }] });
  const redacted = await port.execute(host.request({}, 'lookup'));
  assert.equal(redacted.context.content, 'Host redacted result'); assert.deepEqual(redacted.content, reply);
  host.deny(); const denied = await port.execute(host.request({}, 'lookup'));
  assert.equal(denied.status, 'error'); assert.equal(invoked.length, 2);
});
test('a known MCP error is an error receipt while a transport failure requires reconciliation', async t => {
  let failed = false;
  const host = setup(t, ['lookup'], [{ name: 'lookup', executor: 'mcp', resourceId: 'catalog' }], {
    executeMcpTool: async () => {
      if (failed) throw new Error('transport lost');
      return { content: [{ type: 'text', text: 'remote refused' }], isError: true };
    },
  });
  const execute = host.ctx.tools.execute;
  host.ctx.tools.execute = async input => {
    try { return await execute(input); } catch { return { isError: true, content: [{ type: 'text', text: 'transport lost' }] }; }
  };
  const port = host.gateway.forAgent(host.agent).tools;
  assert.equal((await port.execute(host.request({}, 'lookup'))).status, 'error');
  failed = true;
  assert.equal((await port.execute(host.request({}, 'lookup'))).status, 'uncertain');
});
test('MCP images enter the attachment policy while its public omission cannot expose raw receipt media', async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const host = setup(t, ['lookup'], [{ name: 'lookup', executor: 'mcp', resourceId: 'catalog' }], {
    executeMcpTool: async () => ({ content: [{ type: 'image', data: png, mimeType: 'image/png' }], structuredContent: { screenshot: png } }),
  });
  let saves = 0;
  const ref = { attachmentId: 'fixture', mediaType: 'image/png', width: 1, height: 1, bytes: Buffer.from(png, 'base64').length };
  host.ctx.get = name => name === 'attachments' ? {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1024, maxMessageImageBytes: 1024, maxImagesPerMessage: 1 },
    saveImages: async images => { saves++; assert.equal(images[0].data.toString('base64'), png); return [ref]; },
  } : undefined;
  const execute = host.ctx.tools.execute;
  host.ctx.tools.execute = async input => {
    const result = await execute(input);
    assert.equal(result.content.some(block => block.type === 'image'), true);
    return { ...result, content: [{ type: 'text', text: 'Host omitted MCP image' }] };
  };
  const output = await host.gateway.forAgent(host.agent).tools.execute(host.request({}, 'lookup'));
  assert.equal(output.status, 'ok'); assert.equal(saves, 1);
  assert.equal(output.context.content, 'Host omitted MCP image'); assert.equal(output.context.media, undefined);
  assert.equal(output.content.content[0].data, png);
});
test('a bound MCP name cannot acquire a same-named workspace builtin schema or safe-read authority', async t => {
  const parameters = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  let calls = 0;
  const host = setup(t, ['read_workspace_file'], [{ name: 'read_workspace_file', executor: 'mcp', resourceId: 'catalog', parameters }], {
    executeMcpTool: async () => { calls++; return { content: [{ type: 'text', text: 'external result' }] }; },
  });
  const definition = host.gateway.definitions(host.agent, [...host.registry.values()])[0];
  assert.deepEqual(definition.parameters, parameters); assert.equal(definition.readOnly, false);
  assert.equal(definition.observationRole, 'none');
  host.postFailure();
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({ query: 'hello' }));
  assert.equal(calls, 1); assert.equal(result.status, 'uncertain');
});

test('an unsupported exact integer is rejected before the DSH pipeline can execute an effect', async t => {
  const host = setup(t), port = host.gateway.forAgent(host.agent).tools;
  for (const numeric of [9007199254740993n, -0, 1000000000000000100.0]) {
    const result = await port.execute(host.request({ path: 'integer.txt', content: 'unsafe', numeric }));
    assert.equal(result.status, 'error'); assert.equal(result.content.code, 'STUDIO_NATIVE_EXACT_NUMBER_UNSUPPORTED');
    assert.equal(result.content.executed, false); assert.equal(host.calls.length, 0);
  }
  assert.equal(existsSync(join(host.workspaceRoot, 'integer.txt')), false);
});
test('negotiated numeric arguments cross the external tool boundary without rounding or wrapper authority', async t => {
  const name = 'mcp__fixture__echo', host = setup(t, [name], [{ name, executor: 'mcp' }],
    { argumentEncodings: ['dsh.raw-json-number/v1'] });
  let effects = 0;
  host.registry.set(name, { name, parameters: { type: 'object' }, execute: async args => { effects++; return JSON.stringify(args); },
    output: { render: (_args, value) => [{ type: 'text', text: value }] } });
  const input = { id: 9007199254740993n, zero: -0, float: 1000000000000000100.0, ordinary: 7, record: { rawJSON: '9007199254740993' } };
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request(input, name));
  assert.equal(host.gateway.argumentEncoding, 'dsh.raw-json-number/v1');
  assert.equal(host.calls[0].argumentEncoding, 'dsh.raw-json-number/v1');
  assert.equal(JSON.isRawJSON(host.calls[0].arguments.id), true);
  assert.equal(JSON.isRawJSON(host.calls[0].arguments.record), false);
  assert.equal(host.calls[0].arguments.ordinary, 7);
  assert.equal(result.status, 'ok');
  assert.equal(result.content[0].text, '{"id":9007199254740993,"zero":-0.0,"float":1.0000000000000001e+18,"ordinary":7,"record":{"rawJSON":"9007199254740993"}}');
  host.deny();
  assert.equal((await host.gateway.forAgent(host.agent).tools.execute(host.request(input, name))).status, 'uncertain');
  assert.equal(effects, 1);
});
test('owned builtins compare the decoded negotiated arguments against the original Native authority', async t => {
  const host = setup(t, ['write_workspace_file'], [], { argumentEncodings: ['dsh.raw-json-number/v1'] });
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({ path: 'exact.txt', content: 'written', id: 9007199254740993n }));
  assert.equal(result.status, 'ok');
  assert.equal(readFileSync(join(host.workspaceRoot, 'exact.txt'), 'utf8'), 'written');
});
test('workspace browser metadata is pinned and DSH denial cannot start its backend', async t => {
  let created = 0;
  const host = setup(t, ['browser_inspect_workspace'], [], { createBrowser: () => { created++; throw new Error('must not start'); } });
  const request = host.request({ path: 'app', wait_ms: 0 });
  assert.equal(request.definition.observationRole, 'browser');
  assert.equal(request.definition.readOnly, false);
  assert.equal(request.definition.timeoutMs, 110000);
  assert.equal(typeof host.gateway.forAgent(host.agent).browser.recoverSessions, 'function');
  const registered = host.registry.get('browser_inspect_workspace');
  await assert.rejects(registered.execute(request.call.arguments, { agent: host.agent,
    callId: 'invented', signal: request.signal }), /studio_native_tool_authority_missing/);
  host.deny();
  const result = await host.gateway.forAgent(host.agent).tools.execute(request);
  assert.equal(result.status, 'error'); assert.equal(result.browserSessionRef, undefined);
  assert.equal(created, 0);
});
test('an MCP tool with the browser name receives no owned browser role or recovery authority', t => {
  const host = setup(t, ['browser_inspect_workspace'], [{ name: 'browser_inspect_workspace', executor: 'mcp' }]);
  assert.equal(host.registry.has('browser_inspect_workspace'), false);
  const [definition] = host.gateway.definitions(host.agent, [{ name: 'browser_inspect_workspace', parameters: { type: 'object' } }]);
  assert.equal(definition.observationRole, 'none');
  assert.equal(host.gateway.forAgent(host.agent).browser, undefined);
});
test('a registry disposal failure still closes all browser resources', async t => {
  const host = setup(t, ['browser_inspect_workspace']); let disposed = 0;
  host.ctx.tools.register = () => () => { throw new Error('registry disposal failed'); };
  const gateway = createNativeDshTools({ ctx: host.ctx, config: { toolBindings: ['browser_inspect_workspace'] },
    workspaceRoot: host.workspaceRoot, stateDir: join(host.workspaceRoot, '..', 'state-disposal'), createBrowser: () => ({
      open() {}, act() {}, recover() {}, restart() {}, close() {}, async dispose() { disposed++; },
    }) });
  await gateway.forAgent(host.agent).browser.recoverSessions({ ...host.request({ path: 'app' }), refs: [] });
  const closing = gateway.close();
  assert.equal(gateway.close(), closing);
  await assert.rejects(closing, /registry disposal failed/);
  assert.equal(disposed, 1);
});
test('Native builtin effects require ledger authority and pass through the registry before real writes', async t => {
  const host = setup(t), registered = host.registry.get('write_workspace_file');
  await assert.rejects(registered.execute({ path: 'escape.txt', content: 'not authorized' },
    { agent: host.agent, callId: 'invented', signal: new AbortController().signal }), /studio_native_tool_authority_missing/);
  assert.equal(existsSync(join(host.workspaceRoot, 'escape.txt')), false);
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request());
  assert.equal(result.status, 'ok'); assert.deepEqual(result.workspaceChangedPaths, ['file.txt']);
  assert.equal(result.content.ok, true); assert.equal(result.content.path, 'file.txt');
  assert.equal(result.content.size, 5);
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
  assert.equal(result.content.ok, true); assert.equal(result.content.path, 'file.txt');
  assert.equal(result.context.content.includes(host.workspaceRoot), false);
  assert.deepEqual(result.context.presentation.content, [{ type: 'text', text: 'Policy-redacted result' }]);
  assert.deepEqual(result.workspaceChangedPaths, ['file.txt']);
});

test('post-policy display cannot replace the canonical builtin error diagnostics', async t => {
  const host = setup(t);
  host.ctx.tools.execute = async input => {
    await host.registry.get(input.name).execute(input.arguments, input);
    return { isError: false, content: [{ type: 'text', text: 'Host display replaced' }],
      additionalContexts: [{ role: 'user', content: [{ type: 'text', text: 'Host follow-up' }] }] };
  };
  const result = await host.gateway.forAgent(host.agent).tools.execute(host.request({ path: '../outside', content: 'no write' }));
  assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'path_escape');
  assert.equal(result.context.content, 'Host display replaced');
  assert.equal(result.additionalContexts[0].content, 'Host follow-up');
  assert.equal(existsSync(join(host.workspaceRoot, '..', 'outside')), false);
});

test('Native ledger keeps the typed builtin receipt while the next model sees only post-policy context', async t => {
  const host = setup(t), request = host.request(), ports = host.gateway.forAgent(host.agent);
  host.ctx.tools.execute = async input => {
    await host.registry.get(input.name).execute(input.arguments, input);
    return { isError: false, content: [{ type: 'text', text: 'Policy-approved view' }] };
  };
  const { config, snapshot } = fixture({ tools: [request.definition] }), store = new MemoryRunStore();
  let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: { ...ports, model: { generate: async input => {
    models++;
    if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [request.call] };
    assert.equal(input.messages.find(message => message.role === 'tool').content, 'Policy-approved view');
    return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
  } } } });
  kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(done.outcome, 'unverified');
  const record = store.load(scope, 'run'), intent = record.intents.find(intent => intent.kind === 'tool');
  const receipt = record.receipts.find(receipt => receipt.operationKey === intent.operationKey);
  assert.equal(receipt.result.results[0].content.ok, true);
  assert.equal(receipt.result.results[0].content.path, 'file.txt');
  assert.equal(done.messages.find(message => message.role === 'tool').content, 'Policy-approved view');
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
