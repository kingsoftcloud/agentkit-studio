import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, tool, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeModelPort } from '@kingsoftcloud/agentkit-harness-node/native/model-port';
import { estimateNativeText, estimateNativeWireInput } from '@kingsoftcloud/agentkit-harness-node/native/context-counter';
import { bindNativeContext } from '../src/providers/native-context.mjs';

test('production counter admits real HTTP summaries and SQLite recovery keeps one workspace effect', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-context-live-')), filename = join(directory, 'runs.sqlite');
  let store = new SqliteRunStore(filename), tasks = 0, summaries = 0, writes = 0, interrupted = false;
  const requests = [], failures = [], fragments = [];
  const summaryText = 'PRIVATE-CONTEXT-NOTES' + '中文摘要'.repeat(12);
  assert.ok(estimateNativeText(summaryText) > 64);
  const description = { protocol: 'openai-chat', modelName: 'pinned', contextWindow: 6000, maxOutputTokens: 256, parameters: {} };
  const binding = bindNativeContext({ description, context: { compaction: { thresholdRatio: .5, targetRatio: .2,
    summaryMaxTokens: 64, minModelTurnsBetween: 0 } } });
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      assert.equal(request.url, '/v1/chat/completions');
      assert.ok(estimateNativeWireInput(body) + body.max_tokens <= description.contextWindow);
      const quote = body.messages.find(message => typeof message.content === 'string' && message.content.includes('agentkit.native-summary-quote/v1'));
      let delta, finish_reason = 'stop';
      if (quote) {
        summaries++; assert.equal(body.tools, undefined); assert.equal(body.max_tokens, 64);
        const source = JSON.parse(quote.content); assert.equal(source.trust, 'untrusted'); fragments.push(source.source);
        delta = { content: summaryText }; finish_reason = 'length';
      } else if (++tasks === 1) {
        delta = { tool_calls: [{ index: 0, id: 'publication', type: 'function', function: { name: 'write', arguments: '{}' } }] };
        finish_reason = 'tool_calls';
      } else {
        assert.ok(body.messages.some(message => typeof message.content === 'string' && message.content.includes('PRIVATE-CONTEXT-NOTES')));
        delta = { content: 'Publication completed' };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      response.end(`data: ${JSON.stringify({ id: `response-${requests.length}`, choices: [{ index: 0, delta, finish_reason }],
        usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { failures.push(error); response.writeHead(401); response.end('Test protocol failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ profile: { profileId: 'production-test', profileVersion: '1', providerFamily: 'openai-chat',
    compatibilityDigest: 'bound', ...binding.profile }, contextPolicy: binding.policy,
  tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
  const evidence = 'Observed publication evidence 中文 '.repeat(1400);
  const ports = () => ({ context: bindNativeContext({ description, context: { compaction: { thresholdRatio: .5, targetRatio: .2,
    summaryMaxTokens: 64, minModelTurnsBetween: 0 } } }).port,
  model: createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat', model: 'pinned',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'not-persisted' }) }),
  tools: { execute: async () => { writes++; await writeFile(join(directory, 'published.txt'), 'Published once');
    return { status: 'ok', content: { publication: true }, context: { content: evidence } }; } } });
  const first = new NativeKernel({ store, digest, owner: 'first', ports: ports(), onCheckpoint: async current => {
    if (!interrupted && current.contextState?.history) { interrupted = true; throw Error('Disconnected after sealed summary'); }
  } });
  first.start(snapshot, config);
  await assert.rejects(first.runUntilIdle(scope, 'run'), /Disconnected after sealed summary/);
  assert.equal(writes, 1); assert.ok(summaries > 1); assert.equal(tasks, 1);
  const requestCount = requests.length, before = store.load(scope, 'run');
  assert.ok(before.snapshot.contextState.history.summary.includes('PRIVATE-CONTEXT-NOTES'));
  store.close(); store = new SqliteRunStore(filename);
  const restarted = new NativeKernel({ store, digest, owner: 'replacement', ports: ports() });
  const result = await restarted.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Publication completed');
  assert.equal(requests.length, requestCount + 1); assert.equal(tasks, 2); assert.equal(writes, 1);
  assert.equal(await readFile(join(directory, 'published.txt'), 'utf8'), 'Published once');
  assert.equal(result.messages.find(message => message.role === 'tool').content, evidence);
  assert.equal(result.usage.inputTokens, requests.length * 5); assert.equal(result.usage.outputTokens, requests.length * 7);
  assert.deepEqual(failures, []);
  assert.equal(fragments[0].start, 0); assert.equal(fragments.at(-1).stop, fragments.at(-1).length);
  fragments.forEach((fragment, index) => assert.equal(fragment.start, index ? fragments[index - 1].stop : 0));
  const source = JSON.parse(fragments.map(fragment => fragment.text).join(''));
  assert.equal(source.find(entry => entry.message.role === 'tool').message.content, evidence);
  const fixedRequests = requests.length;
  await restarted.runUntilIdle(scope, 'run'); assert.equal(requests.length, fixedRequests); assert.equal(writes, 1);
  assert.equal(JSON.stringify(store.load(scope, 'run')).includes('not-persisted'), false);
});
