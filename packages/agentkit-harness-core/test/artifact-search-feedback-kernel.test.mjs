import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, artifactToolDefinitions, encodeCapturedSource, CAPTURED_SOURCE_MEDIA_TYPE,
  emptyUsage, parseNativeJson } from '../dist/index.mjs';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { createNativeContextPort } from '@kingsoftcloud/agentkit-harness-node/native/context-counter';
import { fixture, scope, digest } from './fixtures.mjs';

test('Kernel searches each earned artifact independently and clips feedback before sealing its complete next request', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-search-feedback-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = await createNativeArtifactStore({ directory: join(root, 'artifacts'), scope });
  const context = createNativeContextPort({ protocol: 'openai-chat', model: 'source-model' });
  const { config, snapshot } = fixture({ artifactPolicy: 'runtime-artifacts/v1', sourceReadPolicy: 'studio-source-read/v1',
    tools: artifactToolDefinitions(), profile: { ...fixture().config.profile, contextWindow: 64000, maxOutputTokens: 1000 },
    contextPolicy: { tokenizerId: context.tokens.tokenizerId, tokenizerDigest: context.tokens.tokenizerDigest, enabled: true,
      triggerRatio: .9, targetRatio: .6, summaryMaxTokens: 400, maxCompactions: 10,
      maxCompactionsWithoutProgress: 3, minModelTurnsBetween: 0, maxSummaryRetries: 1 },
    limits: { maxToolResultBytes: 1900 } });
  const port = { ...snapshot, operationKey: 'fixture-source', signal: new AbortController().signal };
  const source = 'before\nneedle ' + '中文😀'.repeat(300);
  const contents = [encodeCapturedSource({ ok: true, path: 'source.txt', requested_source: {
    path: 'source.txt', read_range: { start: 55, end: 56 }, content: source } }),
  'x'.repeat(400) + 'needle' + 'z'.repeat(400), 'No match here', 'x'.repeat(1024 * 1024 + 1), 'storage failure'];
  for (const [index, content] of contents.entries()) snapshot.artifactRefs.push(await artifacts.write({ ...port,
    operationKey: `fixture-${index}`, content, mediaType: index === 0 ? CAPTURED_SOURCE_MEDIA_TYPE : 'text/plain', metadata: {} }));
  const refs = snapshot.artifactRefs, readUris = [], store = new MemoryRunStore(); let turns = 0, observedResult;
  store.create(config, snapshot);
  const kernel = new NativeKernel({ owner: 'feedback', digest, store, ports: { context,
    tools: { execute: async () => assert.fail('Reserved search must bypass business tools') },
    artifacts: { ...artifacts, read: async request => {
      readUris.push(request.ref.uri);
      if (request.ref.uri === refs[4].uri) throw Error('injected storage outage');
      return artifacts.read(request);
    } }, model: { generate: async request => {
      if (++turns === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'search', name: 'ArtifactSearch',
        arguments: { uris: refs.map(ref => ref.uri), query: 'needle', max_matches: 16, context_chars: 256 } }] };
      const result = parseNativeJson(request.messages.find(message => message.role === 'tool').content);
      observedResult = result;
      assert.equal(result.observation_type, 'scoped-artifact-search/v1'); assert.equal(result.capacity_limited, true);
      assert.deepEqual(result.results.map(row => row.uri), refs.map(ref => ref.uri));
      assert.equal(result.results[0].source_path, 'source.txt'); assert.equal(result.results[0].coordinate_space, 'captured_source');
      assert.equal(result.results[0].matches[0].source_line, 56); assert.equal(result.results[0].matches[0].excerpt_truncated, true);
      assert.deepEqual(result.results[2].matches, []); assert.equal(result.results[2].complete, true);
      assert.equal(result.results[3].code, 'artifact_search_too_large'); assert.equal(result.results[4].code, 'artifact_search_failed');
      assert.equal(result.complete, false); assert.ok(!readUris.includes(refs[3].uri));
      return { kind: 'final_candidate', text: 'Inspected bounded scoped results', usage: emptyUsage(), toolCalls: [] };
    } } } });
  kernel.attach(scope, snapshot.runId, config); const end = await kernel.runUntilIdle(scope, snapshot.runId);
  assert.equal(end.phase, 'completed', JSON.stringify({ reason: end.reason, turns, observedResult })); assert.equal(turns, 2);
});
