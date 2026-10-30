import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, deliveryTaskMessages, canonical } from '../dist/index.mjs';
import { fixture, tool, scope, digest } from './fixtures.mjs';
const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });

for (const version of [undefined, 1, 2, 3, 7]) test(`actual summary request retains policy output ceiling: ${version ?? 'existing TS'}`, async () => {
  const contextPolicy = { tokenizerId: 'policy-counter', tokenizerDigest: 'policy-counter/v1', enabled: true,
    triggerRatio: .99, targetRatio: .45, summaryMaxTokens: 128, maxCompactions: 4,
    maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 };
  const { config, snapshot } = fixture({ tools: [tool()], contextPolicy,
    ...(version ? { wallDeliveryPolicy: `deadline-delivery/v${version}` } : {}),
    profile: { ...fixture().config.profile, contextWindow: 12000, maxOutputTokens: 256 } });
  const store = new MemoryRunStore(); let tasks = 0, summaries = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'summary-policy', ports: {
    model: { generate: async request => {
      if (request.messages[0]?.kind === 'compaction_instructions') {
        summaries++; assert.equal(request.profile.maxOutputTokens, version === 1 || version === 2 ? 256 : 128);
        return final('Observed source; acceptance is unavailable.');
      }
      tasks++;
      if (tasks <= 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: `source-${tasks}`, name: 'read', arguments: {} }] };
      return tasks === 3 ? { kind: 'context_overflow', text: '', toolCalls: [], usage: emptyUsage() } : final('Unverified delivery.');
    } }, tools: { execute: async () => ({ status: 'ok', content: 'Actual source observation '.repeat(20) }) },
    context: { tokens: { tokenizerId: contextPolicy.tokenizerId, tokenizerDigest: contextPolicy.tokenizerDigest,
      countRequest: async request => Math.ceil(canonical({ messages: request.messages, tools: request.tools }).length / 4),
      countText: async request => Math.ceil(request.text.length / 4) } },
  } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed', result.reason); assert.equal(summaries, 1);
  assert.equal(result.contextState.compactions, 1); assert.equal(result.usage.modelCalls, 5);
});

test('v7 alone rewrites continuation hints while earlier policy receipts and existing TS defaults retain their contracts', () => {
  const read = tool({ contextRole: 'workspace_read', deliveryArtifactRole: 'read', parameters: { type: 'object',
    properties: { path: { type: 'string' }, start_line: { type: 'integer' } } } });
  const { snapshot, config } = fixture({ tools: [read], limits: { maxWallMs: 600000, finalizationReserveWallMs: 60000 } });
  const head = { ...snapshot, deliveryArtifacts: { goalRevision: 0, paths: ['report.md'] }, executionBudgetObservation: {
    policy: 'prepared-execution-budget/v1', runId: snapshot.runId, sourceRevision: 0, goalRevision: 0,
    modelCallsClaimed: 0, toolCallsClaimed: 0, wallMsRemaining: 59000 } };
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ callId: 'read', name: 'read', arguments: { path: 'report.md' } }] },
    { role: 'tool', callId: 'read', content: canonical({ status: 'ok', content: { ok: true, path: 'report.md', content: 'Visible source',
      partial: true, start_line: 1, end_line: 2, total_lines: 4, suggested_action: 'Use ArtifactRead' } }) }];
  const original = canonical(messages);
  for (const version of [undefined, 1, 2, 3, 4, 5, 6, 7]) {
    const view = deliveryTaskMessages(head, { ...config, ...(version ? { wallDeliveryPolicy: `deadline-delivery/v${version}` } : {}) }, messages);
    assert.equal(view[1].content.includes('start_line=3'), version === undefined || version === 7);
  }
  assert.equal(canonical(messages), original);
  for (const wallDeliveryPolicy of ['deadline-delivery/v8', false, 7])
    assert.throws(() => fixture({ wallDeliveryPolicy }), /invalid_wall_delivery_policy/);
  assert.equal(Object.hasOwn(config, 'wallDeliveryPolicy'), false);
});
