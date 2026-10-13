/** Opt-in, real Codex + configured Responses provider verification. No fixture model. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { dshModelRoute } from '../src/agent-preset-admission.mjs';
import { resolveConfiguredCodexModel } from '../src/providers/codex-configured-models.mjs';
import { createCodexRuntime } from '../src/providers/codex-runtime.mjs';

if (!process.argv.includes('--execute')) {
  console.log('Use --execute [--profile ID] [--model ID] [--api responses|chat-completions] to verify the configured gateway with real Codex inference. This consumes model usage.');
} else {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const models = createModelService({ configuration: createGlobalConfiguration(), credentials: { resolve: async name => ({ value: process.env[name] }) } });
  const profile = await models.profile(option('--profile'));
  const selection = await resolveConfiguredCodexModel({ provider: dshModelRoute(profile), model: option('--model') || profile.modelName }, models);
  if (option('--api')) {
    assert.ok(['responses', 'chat-completions'].includes(option('--api')));
    selection.modelProvider.api = option('--api');
  }
  const home = await mkdtemp(join(tmpdir(), 'studio-codex-model-'));
  const nonce = randomUUID(), events = [], calls = [];
  const started = Date.now();
  try {
    // No OpenAI login or personal plugins are copied into this isolated home.
    const runtime = createCodexRuntime({ cwd: home, env: { CODEX_HOME: home }, sandbox: 'read-only', timeoutMs: 120000 });
    for await (const event of runtime.stream({
      ...selection,
      input: '查询 T9 卡片的状态，给我结论。',
      systemPrompt: '查询卡片必须调用 lookup_card 工具。回答用 JSON，固定包含 route_tag:"MAPLE-83"、卡片状态和工具返回的核验码。',
      dynamicTools: [{ name: 'lookup_card', description: 'Read the actual state and verification code of a card.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
      toolHandler: async call => {
        assert.equal(call.name, 'lookup_card'); assert.equal(call.arguments.id, 'T9');
        calls.push(call.name); return { status: 'ready', verification: nonce };
      },
    })) events.push(event);
    const text = events.filter(event => event.type === 'text').map(event => event.text).join('');
    assert.ok(text.includes('MAPLE-83'), 'system-only instruction must reach the model');
    assert.ok(text.includes(nonce), 'model must return the live tool output');
    assert.ok(calls.length > 0);
    assert.ok(events.some(event => event.type === 'tool' && event.phase === 'completed'));
    assert.ok(events.filter(event => event.type === 'text').length > 1, 'text must stream');
    console.log(JSON.stringify({ passed: true, model: selection.model, api: selection.modelProvider.api || 'responses', milliseconds: Date.now() - started, toolCalls: calls.length,
      textDeltas: events.filter(event => event.type === 'text').length, reasoningDeltas: events.filter(event => event.type === 'reasoning').length,
      systemInstructionVerified: true, liveToolResultVerified: true, isolatedCodexHome: true }));
  } finally { await rm(home, { recursive: true, force: true }); }
}
