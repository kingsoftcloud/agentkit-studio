import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, emptyUsage, artifactToolDefinitions, canonical } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeContextPort } from '@kingsoftcloud/agentkit-harness-node/native/context-counter';
import { fixture, tool, scope, digest } from '../fixtures.mjs';
const [mode, root, checkpoint] = process.argv.slice(2), store = new SqliteRunStore(join(root, 'runs.sqlite'));
const context = createNativeContextPort({ protocol: 'openai-chat', model: 'pinned' });
const definition = tool({ name: 'read_source', contextRole: 'workspace_read', sourceObservationPolicy: 'workspace-source-model/v1',
  resultArchivePolicy: 'archived-model-view/v5', parameters: { type: 'object', properties: { path: { type: 'string' } } } });
const data = fixture({ artifactPolicy: 'runtime-artifacts/v1', sourceReadPolicy: 'studio-source-read/v1', tools: [definition, ...artifactToolDefinitions()],
  profile: { ...fixture().config.profile, requestTimeoutMs: 9000, contextWindow: 32000, maxOutputTokens: 1000 },
  contextPolicy: { tokenizerId: context.tokens.tokenizerId, tokenizerDigest: context.tokens.tokenizerDigest, enabled: true,
    triggerRatio: 0.9, targetRatio: 0.6, summaryMaxTokens: 400, maxCompactions: 10,
    maxCompactionsWithoutProgress: 3, minModelTurnsBetween: 0, maxSummaryRetries: 1 },
  limits: { leaseMs: 1000, effectTimeoutMs: 40000, maxParallelTools: 2, maxToolResultBytes: 4096 } });
const calls = Array.from({ length: 6 }, (_, index) => ({ name: definition.name, callId: `read-${index}`, arguments: { path: `${index}.txt` } }));
const response = toolCalls => ({ kind: toolCalls ? 'tool_calls' : 'final_candidate', text: toolCalls ? '' : 'Done',
  toolCalls: toolCalls ?? [], usage: emptyUsage() });
const kernel = new NativeKernel({ store, owner: `source-capacity-${process.pid}`, digest,
  onCheckpoint: async snapshot => {
    const expected = checkpoint === 'quote-committed' ? 0 : 2;
    if (mode === 'run' && snapshot.phase === 'executing_tools' && snapshot.usage.toolCalls === expected
      && snapshot.pendingIntent === null && snapshot.sourceReadQuote?.status === 'ready') {
      process.send({ checkpoint, pid: process.pid }); await new Promise(() => {});
    }
  }, ports: { context,
    model: { generate: async request => {
      appendFileSync(join(root, 'model-calls'), `${process.pid}\n`);
      return request.messages.some(message => message.role === 'tool') ? response() : response(calls);
    } },
    tools: { execute: async request => {
      if (!request.sourceReadBudget) throw Error('missing source capacity');
      appendFileSync(join(root, 'budgets.jsonl'), canonical({ callId: request.call.callId, budget: request.sourceReadBudget }) + '\n');
      return { status: 'ok', content: { read: request.call.arguments.path } };
    } },
  } });
if (mode === 'run') kernel.start(data.snapshot, data.config);
const result = await kernel.runUntilIdle(scope, 'run');
process.send({ done: true, pid: process.pid, phase: result.phase, reason: result.reason, node: process.version });
store.close(); process.disconnect();
