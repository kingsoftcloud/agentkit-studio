import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { admitInlineReasoningPolicy, inlineReasoningMarker, createInlineReasoningProjector,
  projectInlineReasoning } from '../src/native/model-inline-reasoning.mjs';
import { createNativeModelPort } from '../src/native/model-port.mjs';
import { fixture } from '../../agentkit-harness-core/test/fixtures.mjs';

const policy = admitInlineReasoningPolicy('zai'), marker = inlineReasoningMarker(policy);
const legacy = admitInlineReasoningPolicy('zai', { contract: 'profiled-content/v1' });
const configured = inlineReasoningPolicy => fixture({ profile: { profileId: 'framing', profileVersion: '1',
  providerFamily: 'openai-compatible', compatibilityDigest: 'framing-test', inlineReasoningPolicy,
  providerReplayMode: 'reasoning_content' } });

test('content framing is frozen and ordinary prose is live before settlement', () => {
  const modern = createInlineReasoningProjector(marker, policy);
  assert.equal(modern.push('第一段'), '第一段');
  assert.equal(modern.push('第二段'), '第二段');
  assert.equal(modern.seal(), '');
  const old = createInlineReasoningProjector(marker, legacy);
  assert.equal(old.push('第一段'), '');assert.equal(old.push('第二段'), '');
  assert.equal(old.seal(), '第一段第二段');
  assert.equal(configured(policy).config.profile.inlineReasoningPolicy.contract, 'profiled-content/v2');
  assert.equal(configured(legacy).config.profile.inlineReasoningPolicy.contract, 'profiled-content/v1');
});

test('all chunk boundaries preserve framing, public markup and withheld reasoning', () => {
  for (const [wire, expected] of [
    ['普通正文，含中文和 emoji 🪐', '普通正文，含中文和 emoji 🪐'],
    ['\n<think>private details</think>公开正文', '公开正文'],
    ['</think>公开正文', '公开正文'],
    ['正文中的 </think> 和 <think> 是示例', '正文中的 </think> 和 <think> 是示例'],
    ['<thinking>普通标签</thinking>', '<thinking>普通标签</thinking>'],
    ['\u0085<think>unfinished', ''], ['<thi', ''], ['  ', '  '],
  ]) {
    assert.equal(projectInlineReasoning(wire, marker, policy), expected);
    for (let cut = 0; cut <= wire.length; cut++) {
      const p = createInlineReasoningProjector(marker, policy);
      assert.equal(p.push(wire.slice(0, cut)) + p.push(wire.slice(cut)) + p.seal(), expected, `${wire}/${cut}`);
    }
    const p = createInlineReasoningProjector(marker, policy);
    assert.equal([...wire].map(ch => p.push(ch)).join('') + p.seal(), expected);
  }
  assert.equal(projectInlineReasoning('opaque private</think>public', marker, legacy), 'public');
  assert.equal(projectInlineReasoning('opaque private</think>public', marker, policy), 'opaque private</think>public');
});

test('reasoning streams keep only the possible delimiter suffix before public text', () => {
  const p = createInlineReasoningProjector(marker, policy);
  assert.equal(p.push('<think>'), '');
  for (let i = 0; i < 1000; i++) assert.equal(p.push('private '.repeat(100)), '');
  assert.equal(p.push('</thi'), '');assert.equal(p.push('nk>公开'), '公开');
  assert.equal(p.seal(), '');
});

for (const prefix of ['', '<think>private</think>']) test(`real SSE releases prose before server finish (${prefix ? 'tagged' : 'separate reasoning'})`, async t => {
  let firstVisible, continueServer;
  const visible = new Promise(resolve => { firstVisible = resolve; });
  const gate = new Promise(resolve => { continueServer = resolve; });
  let finished = false;
  const frame = delta => `data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });res.flushHeaders();
    res.write(frame({ reasoning_content: 'separate private reasoning' }));
    res.write(frame({ content: prefix + '第一段' }));
    await gate;
    if (res.destroyed) return;
    res.write(frame({ content: '第二段' }));finished = true;
    res.end(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(() => { continueServer();server.closeAllConnections();server.close(); });
  const port = createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'glm-5.2', apiKey: 'fake' }) });
  const { config } = configured(policy);
  const events = [], signal = AbortSignal.timeout(3000);
  const generating = port.generate({ profile: config.profile, messages: [{ role: 'user', content: 'test' }], tools: [], signal }, e => {
    events.push(e);if (e.kind === 'text') firstVisible();
  });
  try {
    await Promise.race([visible, generating.then(() => { throw Error('response ended before live text'); })]);
    assert.equal(finished, false, 'the server cannot finish until the first public delta reaches the client');
    assert.deepEqual(events.filter(e => e.kind === 'text').map(e => e.text), ['第一段']);
    continueServer();
    const result = await generating;
    assert.equal(result.kind, 'final_candidate');assert.equal(result.text, '第一段第二段');
    assert.deepEqual(events.filter(e => e.kind === 'text').map(e => e.text), ['第一段', '第二段']);
    assert.equal(events.filter(e => e.kind === 'text').some(e => e.text.includes('private')), false);
  } finally { continueServer();await generating.catch(() => {}); }
});
