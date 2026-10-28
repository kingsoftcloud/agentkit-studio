import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, artifactToolDefinitions, emptyUsage, parseNativeJson } from '../dist/index.mjs';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { createNativeContextPort } from '@kingsoftcloud/agentkit-harness-node/native/context-counter';
import { fixture, scope, digest, tool } from './fixtures.mjs';

for (const summary of [false, true]) test(`single immutable page reaches ${summary ? 'one complete summary' : 'the complete task request'} without quota clipping`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-single-page-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = await createNativeArtifactStore({ directory: join(root, 'artifacts'), scope });
  const context = createNativeContextPort({ protocol: 'openai-chat', model: 'source-model' });
  const { config, snapshot } = fixture({ artifactPolicy: 'runtime-artifacts/v1', sourceReadPolicy: 'studio-source-read/v1',
    tools: [...artifactToolDefinitions(), tool({ name: 'unused', description: summary ? 'x'.repeat(5000) : 'Unused' })],
    profile: { ...fixture().config.profile, contextWindow: summary ? 5000 : 6000, maxOutputTokens: 128 },
    contextPolicy: { tokenizerId: context.tokens.tokenizerId, tokenizerDigest: context.tokens.tokenizerDigest, enabled: true,
      triggerRatio: .9, targetRatio: .45, summaryMaxTokens: 128, maxCompactions: 5, maxCompactionsWithoutProgress: 3,
      minModelTurnsBetween: 2, maxSummaryRetries: 1, readWorkingSetCount: 8, readWorkingSetMaxTokens: summary ? 1 : 6000,
      readWorkingSetTotalMaxTokens: 16000 }, limits: { maxToolResultBytes: 50000 } });
  const page = 'SOURCE_BEGIN:' + 'abcdefg '.repeat(1100) + ':SOURCE_END';
  const port = { ...snapshot, operationKey: 'capture-source', signal: new AbortController().signal };
  const ref = await artifacts.write({ ...port, content: page, mediaType: 'text/plain', metadata: {} });
  snapshot.artifactRefs.push(ref);
  let turns = 0, summaries = 0, reads = 0;
  const store = new MemoryRunStore(); store.create(config, snapshot);
  const kernel = new NativeKernel({ owner: 'single-page', digest, store, ports: { context,
    tools: { execute: async () => assert.fail('Reserved read cannot enter business tools') },
    artifacts: { ...artifacts, read: request => { reads++; return artifacts.read(request); } },
    model: { generate: async request => {
      if (request.messages[0]?.kind === 'compaction_instructions') {
        summaries++;
        const quote = parseNativeJson(request.messages[1].content);
        assert.equal(quote.source.start, 0); assert.equal(quote.source.stop, quote.source.length);
        assert.ok(quote.source.text.includes('SOURCE_BEGIN:')); assert.ok(quote.source.text.includes(':SOURCE_END'));
        return { kind: 'final_candidate', text: 'The complete immutable page was inspected.', usage: emptyUsage(), toolCalls: [] };
      }
      if (++turns === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'page',
        name: 'ArtifactRead', arguments: { uri: ref.uri, limit_chars: 32000 } }] };
      if (summary) assert.ok(request.messages.some(message => message.kind === 'compaction_summary'));
      else {
        const result = parseNativeJson(request.messages.find(message => message.callId === 'page').content);
        assert.equal(result.content, page); assert.equal(result.result_truncated, false); assert.equal(result.next_offset, null);
      }
      return { kind: 'final_candidate', text: 'Inspected the complete page.', usage: emptyUsage(), toolCalls: [] };
    } } } });
  kernel.attach(scope, snapshot.runId, config);
  const end = await kernel.runUntilIdle(scope, snapshot.runId);
  assert.equal(end.phase, 'completed', JSON.stringify({ reason: end.reason, turns, summaries }));
  assert.equal(turns, 2); assert.equal(summaries, summary ? 1 : 0); assert.equal(reads, 1);
  const result = parseNativeJson(end.messages.find(message => message.callId === 'page').content);
  assert.equal(result.content, page); assert.equal(result.result_truncated, false);
});
