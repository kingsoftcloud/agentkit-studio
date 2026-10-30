import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, artifactToolDefinitions, executeArtifactTool, encodeCapturedSource, CAPTURED_SOURCE_MEDIA_TYPE,
  NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { fixture, scope, tool, digest } from './fixtures.mjs';

const context = { scope, runId: 'source-run', sessionId: 'session', turnId: 'turn', buildId: 'build', taskChainId: 'chain',
  parentRunId: null, operationKey: 'source-read', signal: new AbortController().signal };
const { config, snapshot } = fixture({ artifactPolicy: 'runtime-artifacts/v1', tools: artifactToolDefinitions(),
  limits: { maxToolResultBytes: 6000 } });
async function storage(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-source-search-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createNativeArtifactStore({ directory: join(root, 'artifacts'), scope });
}
const search = (refs, artifacts, query, extra = {}) => executeArtifactTool(context, { name: 'ArtifactSearch', callId: 'search',
  arguments: { uris: refs.map(ref => ref.uri), query, ...extra } }, { ...snapshot, artifactRefs: refs }, config, artifacts);
const observation = (content, start = 40) => ({ ok: true, path: '源码/😀.txt', requested_source: {
  path: '源码/😀.txt', content, read_range: { start, end: typeof start === 'bigint' ? start + 1n : start + 1 },
} });

for (const format of ['source-first', 'legacy', 'authorized-view']) test(`${format}: search uses source Unicode offsets and original file lines`, async t => {
  const artifacts = await storage(t), body = '😀 first "quoted"\n目标\\value 😀 tail', raw = observation(body);
  const content = format === 'source-first' ? encodeCapturedSource(raw) : canonical({ status: 'ok', content:
    format === 'legacy' ? raw : { model_content: canonical(raw), media: [] } });
  const ref = await artifacts.write({ ...context, content, metadata: {},
    mediaType: format === 'source-first' ? CAPTURED_SOURCE_MEDIA_TYPE : 'application/vnd.agentkit.tool-result+json' });
  const result = await search([ref], artifacts, '目标\\value', { context_chars: 3 });
  assert.equal(result.status, 'ok'); assert.equal(result.content.complete, true);
  assert.deepEqual(result.content.matches, [{ uri: ref.uri, match: '目标\\value', offset_chars: Array.from(body.split('目标')[0]).length,
    coordinate_space: 'captured_source', source_path: raw.path, source_line: 41, excerpt: 'd"\n目标\\value 😀 ' }]);
  const envelopeOnly = await search([ref], artifacts, 'requested_source');
  assert.deepEqual(envelopeOnly.content.matches, [], 'carrier metadata is not part of source text');
  const page = await executeArtifactTool(context, { name: 'ArtifactRead', callId: 'page', arguments: { uri: ref.uri, limit_chars: 32000 } },
    { ...snapshot, artifactRefs: [ref] }, config, artifacts);
  assert.equal(page.content.content, content, 'ArtifactRead keeps document coordinates and returns the stored document');
});

test('source coordinates preserve integers beyond IEEE-754 and reference newline counting', async t => {
  const artifacts = await storage(t), start = 9007199254740995n;
  const body = '😀 before\rtarget';
  const content = encodeCapturedSource(observation(body, start));
  assert.equal(typeof content, 'string');
  const ref = await artifacts.write({ ...context, content, mediaType: CAPTURED_SOURCE_MEDIA_TYPE, metadata: {} });
  const result = await search([ref], artifacts, 'target');
  assert.equal(result.content.matches[0].source_line, start, 'reference source_line counts LF, while validation uses splitlines');
  assert.equal(result.content.matches[0].offset_chars, 9);
  const crossing = encodeCapturedSource({ ok: true, path: 'crossing', requested_source: { path: 'crossing', content: 'first\ntarget',
    read_range: { start: Number.MAX_SAFE_INTEGER, end: BigInt(Number.MAX_SAFE_INTEGER) + 1n } } });
  const crossingRef = await artifacts.write({ ...context, operationKey: 'crossing', content: crossing, mediaType: CAPTURED_SOURCE_MEDIA_TYPE, metadata: {} });
  const crossingResult = await search([crossingRef], artifacts, 'target');
  assert.equal(crossingResult.content.matches[0].source_line, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
});

test('eight independently granted sources retain paths and rows with one bounded match each', async t => {
  const artifacts = await storage(t), refs = [];
  for (let index = 0; index < 8; index++) {
    const body = `${'ordinary\n'.repeat(132)}state=confirmed delta_cents=${index}`;
    const content = encodeCapturedSource({ ok: true, path: `source-${index}.txt`, requested_source: {
      path: `source-${index}.txt`, content: body, read_range: { start: 1, end: 133 } } });
    refs.push(await artifacts.write({ ...context, operationKey: `capture-${index}`, content, mediaType: CAPTURED_SOURCE_MEDIA_TYPE, metadata: {} }));
  }
  const result = await search(refs, artifacts, 'state=confirmed', { max_matches: 16 });
  assert.equal(result.content.complete, true); assert.equal(result.content.scanned_artifacts, 8);
  assert.equal(result.content.matches.length, 8);
  result.content.matches.forEach((match, index) => {
    assert.equal(match.source_path, `source-${index}.txt`); assert.equal(match.source_line, 133);
    assert.ok(match.excerpt.includes(`delta_cents=${index}`));
  });
  const limited = await search(refs, artifacts, 'state=confirmed', { max_matches: 2 });
  assert.equal(limited.content.complete, false); assert.equal(limited.content.matches.length, 2);
});

test('actual Kernel searches the earned post-policy source archive while retaining the private original receipt', async t => {
  const artifacts = await storage(t), store = new MemoryRunStore();
  const source = tool({ name: 'read_source', contextRole: 'workspace_read' });
  const { config, snapshot } = fixture({ artifactPolicy: 'runtime-artifacts/v1', tools: [source, ...artifactToolDefinitions()],
    limits: { maxToolResultBytes: 1400 } });
  const body = `${'ordinary\n'.repeat(132)}state=confirmed`, raw = { ok: true, path: 'actual-source.txt', requested_source: {
    path: 'actual-source.txt', content: body, read_range: { start: 1, end: 133 } } };
  let turns = 0, reads = 0, searchResult;
  const kernel = new NativeKernel({ store, owner: 'source-search', digest, ports: { artifacts,
    tools: { execute: async () => { reads++; return { status: 'ok', content: { private: 'HOST_ONLY_SECRET' },
      context: { content: canonical(raw) } }; } },
    model: { generate: async request => {
      turns++;
      if (turns === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
        { name: 'read_source', callId: 'source', arguments: {} }] };
      if (turns === 2) {
        const ref = JSON.parse(request.messages.find(message => message.role === 'tool').content).artifact_uri;
        return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
          { name: 'ArtifactSearch', callId: 'search', arguments: { uris: [ref], query: 'state=confirmed' } }] };
      }
      searchResult = JSON.parse(request.messages.find(message => message.role === 'tool' && message.name === 'ArtifactSearch').content);
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } } } });
  kernel.start(snapshot, config);
  const end = await kernel.runUntilIdle(scope, snapshot.runId);
  assert.equal(end.phase, 'completed'); assert.equal(reads, 1);
  assert.equal(searchResult.complete, true); assert.equal(searchResult.matches[0].source_line, 133);
  assert.equal(searchResult.matches[0].source_path, raw.path);
  const receipt = store.load(scope, snapshot.runId).receipts.find(receipt => receipt.result.results)?.result.results[0];
  assert.deepEqual(receipt.content, { private: 'HOST_ONLY_SECRET' });
  const hidden = await search(end.artifactRefs, artifacts, 'HOST_ONLY_SECRET');
  assert.equal(hidden.content.complete, true); assert.deepEqual(hidden.content.matches, []);
});

test('malformed carriers stay artifact text and a complete document must match its granted digest and byte size', async t => {
  const artifacts = await storage(t), malformed = canonical({ version: 'captured-source-artifact/v1',
    path: 'not-a-workspace-grant', content: 'target', read_range: { start: 1, end: 2 } });
  const ref = await artifacts.write({ ...context, content: malformed, mediaType: CAPTURED_SOURCE_MEDIA_TYPE, metadata: {} });
  const fallback = await search([ref], artifacts, 'target');
  assert.equal(fallback.content.complete, true); assert.equal(fallback.content.matches.length, 1);
  assert.equal(fallback.content.matches[0].coordinate_space, undefined);
  assert.equal(fallback.content.matches[0].offset_chars, malformed.indexOf('target'));
  for (const tampered of [{ ...ref, sizeBytes: ref.sizeBytes + 1 }, { ...ref, digest: `sha256:${'0'.repeat(64)}` }]) {
    const result = await search([tampered], { read: async () => ({ content: malformed, nextOffset: null }) }, 'target');
    assert.equal(result.status, 'error'); assert.equal(result.content.code, 'artifact_read_unavailable');
  }
});

test('legacy float range tokens are not promoted to source integers; unrelated diagnostic floats remain allowed', async t => {
  const artifacts = await storage(t), raw = observation('first\nsecond', 31);
  for (const wrapped of [false, true]) {
    for (const token of ['31', '31.0', '31e0']) {
      const observationText = canonical({ ...raw, diagnostics: { elapsed: 1.25 } }).replace('"start":31', `"start":${token}`);
      const content = wrapped ? canonical({ content: { model_content: observationText, media: [] } })
        : `{"content":${observationText}}`;
      const ref = await artifacts.write({ ...context, operationKey: `${wrapped}-${token}`, content, mediaType: 'application/json', metadata: {} });
      const result = await search([ref], artifacts, 'second');
      assert.equal(result.content.matches[0].coordinate_space, token === '31' ? 'captured_source' : undefined);
    }
  }
});

test('an oversized capture is rejected before storage I/O and cannot prove a complete source search', async t => {
  const artifacts = await storage(t), body = `target${'x'.repeat(1_100_000)}\nlast`;
  const content = encodeCapturedSource(observation(body));
  const ref = await artifacts.write({ ...context, content, mediaType: CAPTURED_SOURCE_MEDIA_TYPE, metadata: {} });
  let reads = 0;
  const result = await search([ref], { read: async () => { reads++; } }, 'target');
  assert.equal(result.content.complete, false); assert.deepEqual(result.content.matches, []);
  assert.equal(reads, 0);
  const rejected = await executeArtifactTool(context, { name: 'ArtifactSearch', callId: 'denied',
    arguments: { uris: [ref.uri, 'artifact://unearned'], query: 'target' } }, { ...snapshot, artifactRefs: [ref] },
    config, { read: async () => { reads++; } });
  assert.equal(rejected.status, 'error'); assert.equal(reads, 0);
});
