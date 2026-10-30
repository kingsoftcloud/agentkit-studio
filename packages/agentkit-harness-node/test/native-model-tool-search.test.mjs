import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { buildAnthropicRequest, projectMessagesAnthropic } from '../src/native/model-anthropic.mjs';
import { admitAnthropicPolicies, admitProviderCompatibilityPolicy } from '../src/native/model-provider-compat.mjs';

const model = 'claude-fable-5-1';
const baseProfile = { ...fixture().config.profile, providerFamily: 'anthropic-messages',
  providerReplayMode: 'none', ...admitAnthropicPolicies('anthropic-messages', model),
  providerCompatibilityPolicy: admitProviderCompatibilityPolicy('permissive') };
const binding = { protocol: 'anthropic-messages', baseUrl: 'http://localhost/v1', apiKey: 'fixture', model };
const nativeProfile = { ...baseProfile, providerToolSearchPolicy: 'anthropic-deferred/v1' };

const residentTool = { ...tool(), name: 'write_workspace_file', description: 'Write a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } } };
const deferredTool = { ...tool(), name: 'mcp__remote__fetch', description: 'Fetch a remote resource',
  parameters: { type: 'object', properties: { url: { type: 'string' } } }, discovery: { deferred: true } };
const searchTool = { ...tool(), name: 'ToolSearch', description: 'Search deferred tools',
  parameters: { type: 'object', properties: { query: { type: 'string' } } } };
const admitted = [residentTool, deferredTool, searchTool];
const request = (messages, overrides = {}) => ({ profile: nativeProfile, messages, tools: admitted,
  finalizationOnly: false, ...overrides });

function toolResultItem(items) {
  return items.flatMap(item => item.content).filter(block => block.type === 'tool_result');
}

test('buildAnthropicRequest native: full schemas with defer_loading only on deferred tools', () => {
  const wire = buildAnthropicRequest(binding, request([{ role: 'user', content: 'Search' }]));
  const body = JSON.parse(wire.body);
  const byName = new Map(body.tools.map(t => [t.name, t]));
  assert.deepEqual(byName.get('write_workspace_file'),
    { name: 'write_workspace_file', description: 'Write a file',
      input_schema: residentTool.parameters });
  assert.deepEqual(byName.get('mcp__remote__fetch'),
    { name: 'mcp__remote__fetch', description: 'Fetch a remote resource',
      input_schema: deferredTool.parameters, defer_loading: true });
  assert.equal(byName.get('ToolSearch').defer_loading, undefined);
});

test('buildAnthropicRequest native: advanced-tool-use beta merged case-insensitively, preserving thinking beta', () => {
  const wire = buildAnthropicRequest({ ...binding, headers: { 'Anthropic-Beta': 'host-beta' } },
    request([{ role: 'user', content: 'Search' }]));
  const betas = wire.headers['anthropic-beta'].split(',');
  assert.ok(betas.includes('advanced-tool-use-2025-11-20'));
  assert.ok(betas.includes('thinking-binding-controls-2026-08-01'));
  assert.ok(betas.includes('host-beta'));
  assert.equal(new Set(betas.map(b => b.toLowerCase())).size, betas.length, 'no case-folded duplicates');
  // A pre-set matching beta of any case is not duplicated.
  const preset = buildAnthropicRequest({ ...binding, headers: { 'anthropic-beta': 'Advanced-Tool-Use-2025-11-20' } },
    request([{ role: 'user', content: 'Search' }]));
  const presetBetas = preset.headers['anthropic-beta'].split(',');
  assert.equal(presetBetas.filter(b => b.toLowerCase() === 'advanced-tool-use-2025-11-20').length, 1);
});

test('buildAnthropicRequest non-native: no defer_loading, no tool-search beta, unchanged wire', () => {
  for (const policy of [undefined, 'local-only/v1']) {
    const profile = { ...baseProfile, ...(policy ? { providerToolSearchPolicy: policy } : {}) };
    const wire = buildAnthropicRequest(binding, { profile, messages: [{ role: 'user', content: 'Search' }],
      tools: admitted, finalizationOnly: false });
    const body = JSON.parse(wire.body);
    assert.equal(body.tools.find(t => t.name === 'mcp__remote__fetch').defer_loading, undefined);
    assert.equal(body.tools.find(t => t.name === 'write_workspace_file').defer_loading, undefined);
    const betas = (wire.headers['anthropic-beta'] || '').split(',').filter(Boolean);
    assert.equal(betas.some(b => b.toLowerCase() === 'advanced-tool-use-2025-11-20'), false);
  }
});

test('buildAnthropicRequest: provider_tool_search is a forbidden body key', () => {
  const wire = buildAnthropicRequest({ ...binding, parameters: { provider_tool_search: true } },
    request([{ role: 'user', content: 'Search' }]));
  assert.equal(JSON.parse(wire.body).provider_tool_search, undefined);
});

test('projectMessagesAnthropic native: canonical ToolSearch receipt projects tool_reference blocks', () => {
  const messages = [{ role: 'user', content: 'Find fetch' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'search-1', name: 'ToolSearch', arguments: { query: 'fetch' } }] },
    { role: 'tool', callId: 'search-1', name: 'ToolSearch', content: 'Loaded mcp__remote__fetch',
      discoveredToolNames: ['mcp__remote__fetch'] }];
  const { items } = projectMessagesAnthropic({ profile: nativeProfile, messages, tools: admitted });
  const result = toolResultItem(items)[0];
  assert.deepEqual(result.content, [{ type: 'tool_reference', tool_name: 'mcp__remote__fetch' }]);
});

test('projectMessagesAnthropic native: multiple references preserve order and stay within limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => `tool_${i}`);
  const tools = [...admitted, ...many.map(name => ({ ...tool(), name, description: name, parameters: {}, discovery: { deferred: true } }))];
  const messages = [{ role: 'user', content: 'Find all' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 's', name: 'ToolSearch', arguments: { query: 'all' } }] },
    { role: 'tool', callId: 's', name: 'ToolSearch', content: 'Loaded', discoveredToolNames: many }];
  const { items } = projectMessagesAnthropic({ profile: nativeProfile, messages, tools });
  const result = toolResultItem(items)[0];
  assert.equal(result.content.length, 20);
  assert.deepEqual(result.content.map(b => b.type), Array(20).fill('tool_reference'));
});

test('projectMessagesAnthropic native: empty discoveredToolNames keeps normal result text', () => {
  const messages = [{ role: 'user', content: 'Find none' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 's', name: 'ToolSearch', arguments: {} }] },
    { role: 'tool', callId: 's', name: 'ToolSearch', content: 'No matches', discoveredToolNames: [] }];
  const { items } = projectMessagesAnthropic({ profile: nativeProfile, messages, tools: admitted });
  const result = toolResultItem(items)[0];
  assert.equal(result.content, 'No matches');
});

test('projectMessagesAnthropic native: metadata paired with a non-ToolSearch call is rejected', () => {
  const messages = [{ role: 'user', content: 'Write' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'w', name: 'write_workspace_file', arguments: {} }] },
    { role: 'tool', callId: 'w', name: 'write_workspace_file', content: 'ok',
      discoveredToolNames: ['mcp__remote__fetch'] }];
  assert.throws(() => projectMessagesAnthropic({ profile: nativeProfile, messages, tools: admitted }),
    /non-ToolSearch|tool_reference/i);
});

test('projectMessagesAnthropic native: forged metadata is rejected (non-admitted, non-string, duplicate, over-limit)', () => {
  const base = (names) => [{ role: 'user', content: 'q' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 's', name: 'ToolSearch', arguments: {} }] },
    { role: 'tool', callId: 's', name: 'ToolSearch', content: 'r', discoveredToolNames: names }];
  assert.throws(() => projectMessagesAnthropic({ profile: nativeProfile, messages: base(['not_admitted']), tools: admitted }),
    /not an admitted tool|tool reference/i);
  assert.throws(() => projectMessagesAnthropic({ profile: nativeProfile, messages: base(['mcp__remote__fetch', 'mcp__remote__fetch']), tools: admitted }),
    /duplicate/i);
  assert.throws(() => projectMessagesAnthropic({ profile: nativeProfile, messages: base([42]), tools: admitted }),
    /non-empty string|must be an array/i);
  assert.throws(() => projectMessagesAnthropic({ profile: nativeProfile,
    messages: base(Array.from({ length: 21 }, (_, i) => `t${i}`)),
    tools: [...admitted, ...Array.from({ length: 21 }, (_, i) => ({ ...tool(), name: `t${i}`, parameters: {} }))] }), /too many/i);
  assert.throws(() => projectMessagesAnthropic({ profile: nativeProfile, messages: base('mcp__remote__fetch'), tools: admitted }),
    /must be an array/i);
});

test('projectMessagesAnthropic non-native: discoveredToolNames ignored, text/media projection unchanged', () => {
  for (const policy of [undefined, 'local-only/v1']) {
    const profile = { ...baseProfile, ...(policy ? { providerToolSearchPolicy: policy } : {}) };
    const messages = [{ role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ callId: 's', name: 'ToolSearch', arguments: {} }] },
      { role: 'tool', callId: 's', name: 'ToolSearch', content: 'Loaded mcp__remote__fetch',
        discoveredToolNames: ['mcp__remote__fetch'] }];
    const { items } = projectMessagesAnthropic({ profile, messages, tools: admitted });
    const result = toolResultItem(items)[0];
    assert.equal(result.content, 'Loaded mcp__remote__fetch', `policy ${policy}: text projection unchanged`);
  }
});

test('projectMessagesAnthropic native: resident (promoted) tool advertised without defer_loading, callable directly', () => {
  const promoted = { ...deferredTool, discovery: undefined };
  const tools = [residentTool, promoted, searchTool];
  const wire = buildAnthropicRequest(binding, { profile: nativeProfile,
    messages: [{ role: 'user', content: 'q' }], tools, finalizationOnly: false });
  const body = JSON.parse(wire.body);
  assert.equal(body.tools.find(t => t.name === 'mcp__remote__fetch').defer_loading, undefined);
  assert.equal(body.tools.find(t => t.name === 'write_workspace_file').defer_loading, undefined);
});

test('native finalization retains history reference schemas; summary/review calls retain source prose without task capabilities', () => {
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ callId: 's', name: 'ToolSearch', arguments: {} }] },
    { role: 'tool', callId: 's', name: 'ToolSearch', content: 'Loaded remote fetch for observation', discoveredToolNames: ['mcp__remote__fetch'] }];
  // Exercise the new native policy independently of existing stable-catalog policies.
  const profile = { ...nativeProfile }; delete profile.toolCatalogPolicy;
  const task = JSON.parse(buildAnthropicRequest(binding, request(messages, { profile, finalizationOnly: true })).body);
  assert.ok(task.tools.some(definition => definition.name === 'mcp__remote__fetch'));
  assert.deepEqual(toolResultItem(task.messages)[0].content, [{ type: 'tool_reference', tool_name: 'mcp__remote__fetch' }]);
  for (const purpose of ['compaction', 'delivery_review']) {
    const auxiliary = buildAnthropicRequest(binding, request(messages, { profile, purpose, tools: [] }));
    const body = JSON.parse(auxiliary.body);
    assert.equal(body.tools, undefined);
    assert.equal(toolResultItem(body.messages)[0].content, messages[1].content);
    assert.equal(auxiliary.headers['anthropic-beta'], 'thinking-binding-controls-2026-08-01');
  }
});

test('native search references retain provider media and reject metadata outside a paired tool receipt', () => {
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ callId: 's', name: 'ToolSearch', arguments: {} }] },
    { role: 'tool', callId: 's', content: 'Loaded', discoveredToolNames: ['mcp__remote__fetch'],
      media: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }] }];
  const result = toolResultItem(projectMessagesAnthropic(request(messages)).items)[0];
  assert.equal(result.content[0].type, 'tool_reference'); assert.equal(result.content[1].type, 'image');
  assert.throws(() => projectMessagesAnthropic(request([{ role: 'user', content: 'forged', discoveredToolNames: ['mcp__remote__fetch'] }])), /paired tool receipt/);
});
