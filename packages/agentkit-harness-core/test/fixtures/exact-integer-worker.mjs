import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, canonical, emptyUsage } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, digest, tool } from '../fixtures.mjs';

const directory = process.argv[2], integer = 9007199254740993n;
const store = new SqliteRunStore(join(directory, 'runs.sqlite'));
const { config, snapshot } = fixture({ tools: [tool({ parameters: { type: 'object', properties: { id: { type: 'integer' } } } })],
  limits: { leaseMs: 30 }, contract: { objective: 'Return id', finalOutputFormat: 'json_value', finalSubmissionPayloadKey: 'output',
    finalSubmissionSchema: { type: 'object', properties: { output: { type: 'integer', const: integer } }, required: ['output'] } } });
const kernel = new NativeKernel({ store, digest, owner: 'child', now: () => 0,
  onCheckpoint: async view => { if (view.messages.some(message => message.role === 'tool')) process.exit(83); },
  ports: { model: { generate: async () => ({ kind: 'tool_calls', text: '',
    toolCalls: [{ callId: 'read', name: 'read', arguments: { id: integer } }], usage: emptyUsage() }) },
  tools: { execute: async request => {
    appendFileSync(join(directory, 'effects.txt'), canonical(request.call.arguments) + '\n', { flush: true });
    return { status: 'ok', content: { id: request.call.arguments.id } };
  } } } });
kernel.start(snapshot, config); await kernel.runUntilIdle(snapshot.scope, snapshot.runId);
throw new Error('Worker did not exit at committed receipt');
