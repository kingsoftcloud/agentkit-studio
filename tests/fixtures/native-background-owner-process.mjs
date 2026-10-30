import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeKernel, BACKGROUND_COMMAND_CONTRACT, emptyUsage, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { digest, scope } from './native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { verifyNativeDshBackgroundOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-background-ownership';

const store = new SqliteRunStore(process.argv[2]);
try {
  const ownership = parseNativeJson(readFileSync(process.argv[3], 'utf8'));
  const { record, source } = await verifyNativeDshBackgroundOwnership(ownership, { store, scope,
    sessionId: 'session', turn: 17, signal: new AbortController().signal });
  const sourceDigest = digest(source);
  let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: `cold-notice-${process.pid}`, ports: {
    model: { generate: async () => { models++; return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }; } },
    tools: { execute: async () => assert.fail('original command cannot run again') },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  const completed = await kernel.runUntilIdle(scope, record.snapshot.runId);
  assert.equal(digest(store.load(scope, source.snapshot.runId)), sourceDigest);
  process.stdout.write(JSON.stringify({ runId: completed.runId, phase: completed.phase, models,
    sourcePhase: source.snapshot.phase, sourceDigest }));
} finally { store.close(); }
