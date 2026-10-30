import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { MemoryRunStore, NativeKernel, emptyUsage, bindAnthropicReplayInput, projectAnthropicReplay,
  operatorInputView, projectSessionHistory, reduceCommand, plan } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { buildAnthropicRequest, projectMessagesAnthropic } from '../src/native/model-anthropic.mjs';
import { admitAnthropicPolicies, admitProviderCompatibilityPolicy } from '../src/native/model-provider-compat.mjs';
import { profileFingerprint } from '../src/native/model-replay.mjs';
import { createNativeModelPort } from '../src/native/model-port.mjs';

const model = 'claude-fable-5-1';
const policies = admitAnthropicPolicies('anthropic-messages', model);
const profile = { ...fixture().config.profile, providerFamily: 'anthropic-messages',
  providerReplayMode: 'anthropic_content', ...policies, providerCompatibilityPolicy: admitProviderCompatibilityPolicy('permissive') };
const binding = { protocol: 'anthropic-messages', baseUrl: 'http://localhost/v1', apiKey: 'fixture', model };
const tools = [tool()];
const request = (messages, overrides = {}) => ({ profile, messages, tools, finalizationOnly: false, ...overrides });
const blocks = [{ type: 'thinking', thinking: 'PRIVATE', signature: 'ORIGINAL_SIGNATURE' },
  { type: 'tool_use', id: 'provider-id', name: 'read', input: {} }];
const withoutCacheMarkers = messages => messages.map(message => ({ ...message,
  content: Array.isArray(message.content) ? message.content.map(({ cache_control, ...block }) => block) : message.content }));
const result = { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'provider-id', name: 'read', arguments: {} }],
  usage: emptyUsage(), providerReplay: { version: 'model-replay/v2', profileFingerprint: profileFingerprint(profile),
    compatibilityDigest: profile.compatibilityDigest, anthropicContent: blocks } };

test('Anthropic projection: exact catalog, adaptive binding and independent beta tokens', () => {
  for (const name of [model, 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    const admitted = admitAnthropicPolicies('anthropic-messages', name);
    const wire = buildAnthropicRequest({ ...binding, model: name, headers: { 'Anthropic-Beta': 'host-beta' } },
      request([{ role: 'user', content: 'Question' }], { profile: { ...profile, ...admitted } }));
    assert.deepEqual(JSON.parse(wire.body).thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    assert.equal(wire.headers['anthropic-beta'], 'host-beta,thinking-binding-controls-2026-08-01');
    assert.equal(wire.headers['Anthropic-Beta'], undefined);
  }
  for (const name of ['claude-fable-5-2', 'alias-claude-fable-5-1']) {
    assert.equal(admitAnthropicPolicies('anthropic-messages', name).anthropicPolicy.midSystem, false);
  }
  const legacy = buildAnthropicRequest(binding, request([{ role: 'user', content: 'Question' }], {
    profile: { ...profile, anthropicPolicy: { contract: 'anthropic-wire/v1', midSystem: false, blockBinding: 'disabled' } } }));
  assert.equal(JSON.parse(legacy.body).thinking, undefined);
  const haiku = buildAnthropicRequest({ ...binding, model: 'claude-haiku-5-5', parameters: { reasoning_effort: 'low' } },
    request([{ role: 'user', content: 'Question' }]));
  assert.deepEqual(JSON.parse(haiku.body).thinking, { type: 'disabled' });
  const enabled = buildAnthropicRequest({ ...binding, parameters: { thinking: { type: 'enabled', budget_tokens: 1024 } } },
    request([{ role: 'user', content: 'Question' }]));
  assert.deepEqual(JSON.parse(enabled.body).thinking, { type: 'enabled', budget_tokens: 1024,
    block_binding: { prefix_mismatch_behavior: 'drop_block' } });
});

test('Anthropic projection: preserve mid-system order, original signed tool ids and detached blocks', () => {
  const source = [{ role: 'system', content: 'Fixed' }, { role: 'user', content: 'Question' },
    { role: 'system', content: 'Current constraint' }];
  const bound = bindAnthropicReplayInput(result, source, tools, profile, digest);
  const assistant = { role: 'assistant', content: '', toolCalls: [{ callId: 'canonical-id', name: 'read', arguments: {} }],
    providerReplay: bound.providerReplay, replayToolIds: { 'provider-id': 'canonical-id' } };
  const messages = [...source, assistant, { role: 'tool', callId: 'canonical-id', content: '42' },
    { role: 'system', content: 'Remaining budget' }];
  const original = structuredClone(messages);
  const first = projectMessagesAnthropic(request(source));
  const next = projectMessagesAnthropic(request(messages));
  assert.equal(next.system, 'Fixed');
  assert.deepEqual(next.items.slice(0, first.items.length), first.items);
  assert.deepEqual(next.items.map(item => item.role), ['user', 'system', 'assistant', 'user', 'system']);
  assert.deepEqual(next.items[2].content, blocks);
  assert.equal(next.items[3].content[0].tool_use_id, 'provider-id');
  next.items[2].content[1].input.detached = true;
  assert.deepEqual(messages, original);
  assert.throws(() => projectMessagesAnthropic(request([{ role: 'assistant', content: 'Answer' },
    { role: 'system', content: 'Misplaced' }])), /system section must follow/);
  const legacy = projectMessagesAnthropic(request(source, { profile: { ...profile, anthropicPolicy: undefined } }));
  assert.equal(legacy.system, 'Fixed\n\nCurrent constraint');
});

test('Anthropic projection: input/header edits abandon thinking monotonically without rewriting receipts', () => {
  const source = [{ role: 'system', content: 'Fixed' }, { role: 'user', content: 'Question' }];
  const bound = bindAnthropicReplayInput(result, source, tools, profile, digest);
  const messages = [...source, { role: 'assistant', content: '', toolCalls: result.toolCalls, providerReplay: bound.providerReplay },
    { role: 'tool', callId: 'provider-id', content: '42' }];
  const original = structuredClone(messages);
  assert.deepEqual(projectAnthropicReplay(messages, tools, profile, [], digest).abandoned, []);
  const edited = structuredClone(messages); edited[1].content = 'Compacted question';
  const discarded = projectAnthropicReplay(edited, tools, profile, [], digest);
  assert.equal(discarded.abandoned.length, 1);
  const restored = projectAnthropicReplay(messages, tools, profile, discarded.abandoned, digest);
  assert.equal(restored.abandoned.length, 1);
  const wire = projectMessagesAnthropic(request(restored.messages));
  assert.deepEqual(wire.items[1].content, blocks.filter(block => block.type !== 'thinking'));
  assert.equal(wire.items[2].content[0].tool_use_id, 'provider-id');
  assert.deepEqual(messages, original);
  assert.equal(projectAnthropicReplay(messages, [tool({ description: 'Changed schema header' })], profile, [], digest).abandoned.length, 1);
  const forged = structuredClone(restored.messages); forged[2].providerReplayProjection.originalContentDigest = '0'.repeat(64);
  assert.throws(() => projectMessagesAnthropic(request(forged)), /replay_projection_mismatch/);
});

test('Anthropic projection: guide input quotes only its bound unanswered journal frame', () => {
  const { config, snapshot } = fixture({ profile, guidancePolicy: 'boundary-guide/v1' });
  const initial = { ...snapshot, phase: 'preparing_context' };
  const staged = plan(initial, config, { context: false, workspace: false, verification: false }, digest).snapshot;
  assert.equal(staged.messages.at(-1).kind, 'host_request_guidance');
  const frame = structuredClone(staged.messages.at(-1));
  const guided = reduceCommand(staged, { kind: 'guide', commandId: 'guide-1', payload: { text: 'New direction', expectedGoalRevision: 0 } },
    null, { configuration: config }).snapshot;
  const view = operatorInputView(guided.messages, profile, digest);
  assert.equal(view.at(-2).kind, 'historical_operator_guidance');
  assert.deepEqual(guided.messages.at(-2), frame);
  assert.equal(view.at(-1).content, 'New direction');
  assert.equal(guided.messages.at(-1).operatorInputHistory.frames[0].key, frame.operatorGuidance.key);
});

test('Anthropic projection HTTP/kernel: journaled prefixes and stable catalog survive id collisions and finalization', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'message', id: `message-${requests.length}`, role: 'assistant',
      content: requests.length < 3 ? blocks : [{ type: 'text', text: 'Done' }],
      stop_reason: requests.length < 3 ? 'tool_use' : 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { config, snapshot } = fixture({ profile: { ...profile, streaming: false }, tools,
    limits: { maxModelCalls: 3, finalizationReserveModelCalls: 1 }, instructions: 'Fixed instructions',
    contextPolicy: { tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1', enabled: false,
      triggerRatio: .7, targetRatio: .4, summaryMaxTokens: 80, maxCompactions: null,
      maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 } });
  const store = new MemoryRunStore(); store.create(config, snapshot);
  let executions = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'anthropic-worker', ports: {
    model: createNativeModelPort({ resolveProfile: async () => ({ ...binding, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }) }),
    tools: { execute: async () => { executions++; return { status: 'ok', content: { value: 42 } }; } },
    context: { tokens: { tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1',
      countRequest: async ({ messages, tools }) => Math.ceil(JSON.stringify({ messages, tools }).length / 4),
      countText: async ({ text }) => Math.ceil(text.length / 4) } },
  } });
  const completed = await kernel.runUntilIdle(scope, 'run');
  assert.equal(completed.finalText, 'Done'); assert.equal(requests.length, 3); assert.equal(executions, 2);
  assert.deepEqual(withoutCacheMarkers(requests[1].messages.slice(0, requests[0].messages.length)), withoutCacheMarkers(requests[0].messages));
  assert.deepEqual(withoutCacheMarkers(requests[2].messages.slice(0, requests[1].messages.length)), withoutCacheMarkers(requests[1].messages));
  for (const req of requests) {
    assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
    const lastConversation = req.messages.findLast(message => message.role !== 'system');
    assert.deepEqual(lastConversation.content.at(-1).cache_control, { type: 'ephemeral' });
    assert.ok(req.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'thinking').every(block => block.cache_control === undefined));
  }
  assert.deepEqual(requests.map(req => req.tools.map(tool => tool.name)), [['read'], ['read'], ['read']]);
  for (const req of requests.slice(1)) {
    const receipts = req.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
    assert.ok(receipts.every(block => block.tool_use_id === 'provider-id'));
  }
  assert.equal(completed.messages.filter(message => message.kind === 'host_request_guidance').length, 3);
  assert.equal(completed.abandonedReplayDigests.length, 0);
  assert.notEqual(completed.messages.filter(message => message.toolCalls?.length)[1].toolCalls[0].callId, 'provider-id');
});

test('Anthropic caching: stable and dynamic system boundaries stay separate without mutating source messages', () => {
  const messages = [{ role: 'system', content: 'Stable instructions' }, { role: 'system', content: 'Dynamic environment A' },
    { role: 'user', content: 'Task' }];
  const original = structuredClone(messages);
  const payload = JSON.parse(buildAnthropicRequest(binding, request(messages)).body);
  const updated = JSON.parse(buildAnthropicRequest(binding, request([messages[0],
    { ...messages[1], content: 'Dynamic environment B' }, messages[2]])).body);
  assert.deepEqual(payload.system[0], { type: 'text', text: 'Stable instructions', cache_control: { type: 'ephemeral' } });
  assert.deepEqual(payload.system[0], updated.system[0]);
  assert.notEqual(payload.system[1].text, updated.system[1].text);
  assert.deepEqual(payload.system[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(payload.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(messages, original);
});

test('Anthropic caching: legacy absence remains wire-identical and invalid policies are rejected', () => {
  const messages = [{ role: 'system', content: 'Fixed' }, { role: 'user', content: 'Task' }];
  const old = JSON.parse(buildAnthropicRequest(binding, request(messages, { profile: { ...profile, promptCachePolicy: undefined } })).body);
  assert.equal(old.system, 'Fixed');
  assert.equal(JSON.stringify(old).includes('cache_control'), false);
  assert.throws(() => fixture({ profile: { ...profile, promptCachePolicy: 'unknown' } }), /invalid_prompt_cache_policy/);
  assert.throws(() => fixture({ profile: { ...profile, providerFamily: 'openai-chat' } }), /invalid_prompt_cache_policy/);
});

test('Anthropic caching: temporary compaction sources have no conversation-tail write marker', () => {
  const payload = JSON.parse(buildAnthropicRequest(binding, request([
    { role: 'system', content: 'Summarize safely' }, { role: 'user', content: 'Unique source chunk' },
  ], { purpose: 'compaction' })).body);
  assert.deepEqual(payload.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(payload.messages[0].content[0].cache_control, undefined);
});

test('Anthropic caching: signed thinking is immutable and tool arguments named cache_control are preserved', () => {
  const input = { cache_control: 'application data' };
  const content = [{ type: 'thinking', thinking: 'PRIVATE', signature: 'SIGNED' },
    { type: 'tool_use', id: 'call', name: 'read', input, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  const messages = [{ role: 'user', content: 'Task' }, { role: 'assistant', content: '',
    toolCalls: [{ callId: 'call', name: 'read', arguments: input }], providerReplay: { version: 'model-replay/v2',
      profileFingerprint: profileFingerprint(profile), compatibilityDigest: profile.compatibilityDigest, anthropicContent: content } },
    { role: 'tool', callId: 'call', name: 'read', content: 'Result' }];
  const original = structuredClone(messages);
  const payload = JSON.parse(buildAnthropicRequest(binding, request(messages)).body);
  assert.deepEqual(payload.messages[1].content[0], content[0]);
  assert.equal(payload.messages[1].content[1].cache_control, undefined);
  assert.deepEqual(payload.messages[1].content[1].input, input);
  assert.deepEqual(payload.messages[2].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(messages, original);
});

test('Anthropic caching: Host automatic caching retains ownership of the moving tail', () => {
  const payload = JSON.parse(buildAnthropicRequest({ ...binding, parameters: { cache_control: { type: 'ephemeral' } } },
    request([{ role: 'system', content: 'Stable' }, { role: 'user', content: 'Task' }])).body);
  assert.deepEqual(payload.cache_control, { type: 'ephemeral' });
  assert.deepEqual(payload.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(payload.messages[0].content[0].cache_control, undefined);
});

test('Anthropic projection kernel: stable catalog never authorizes a tool during finalization', async () => {
  const { config, snapshot } = fixture({ profile, tools, limits: { maxModelCalls: 2, finalizationReserveModelCalls: 1 } });
  const store = new MemoryRunStore(); store.create(config, snapshot);
  let attempts = 0, executions = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'admission-worker', ports: {
    model: { generate: async req => { attempts++; assert.deepEqual(req.tools.map(tool => tool.name), ['read']);
      assert.equal(req.finalizationOnly, attempts === 2); return structuredClone(result); } },
    tools: { execute: async () => { executions++; return { status: 'ok', content: '42' }; } },
  } });
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(attempts, 2); assert.equal(executions, 1);
  assert.equal(done.reason, 'tool_call_after_finalization_reserve');
});

test('Anthropic projection: imported guide history carries no old operator binding into a changed profile', () => {
  const { config, snapshot } = fixture({ profile, guidancePolicy: 'boundary-guide/v1' });
  const staged = plan({ ...snapshot, phase: 'preparing_context' }, config,
    { context: false, workspace: false, verification: false }, digest).snapshot;
  const guided = reduceCommand(staged, { kind: 'guide', commandId: 'guide-1', payload: { text: 'New direction', expectedGoalRevision: 0 } },
    null, { configuration: config }).snapshot;
  const parent = { configuration: config, snapshot: { ...guided, phase: 'canceled' } };
  const imported = projectSessionHistory(parent, { ...config, profile: { ...profile, compatibilityDigest: 'changed-profile' } }, digest);
  assert.equal(imported.find(message => message.content === 'New direction').operatorInputHistory, undefined);
});
