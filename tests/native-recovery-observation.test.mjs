import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node';
import { nativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { nativeDshRunId } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { fixture } from './fixtures/native-core.mjs';
import { createStudioNativeRecovery } from '../src/host/services/native-recovery.mjs';

for (const openOwner of [false, true]) test(`status uses a read model and control inspection keeps original authority, open=${openOwner}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-observation-')), store = new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(async () => { store.close();await rm(root, { recursive: true, force: true }); });
  const scope = { tenantId: 'local', workspaceId: 'w', userId: 'local-user', agentId: 'agent' };
  const { config, snapshot } = fixture();
  Object.assign(snapshot, { scope, runId: nativeDshRunId(scope, 'session', 1), turnId: '1' });
  store.create(config, snapshot);
  const ownership = nativeDshOwnership({ identity: Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
    .map(k => [k, snapshot[k]])), configuration: config, input: { messages: [{ id: 'message', role: 'user', content: [{ type: 'text', text: 'Task' }] }] },
    source: { provider: 'fixture', model: 'fixture' } });
  const agent = { session: { id: 'session' }, externalTurns: { pending: () => openOwner ? ownership : null } };
  const services = { sessionController: { resolveAgent: async () => ({ agent }) } }, lifetime = new AbortController();
  const make = ledger => createStudioNativeRecovery({ ctx: { get: n => services[n] }, store: ledger,
    workspaceId: 'w', lifetime, active: new Set(), controls: new Map(), controlKey: (a, s) => a + ':' + s, execute: {} });
  const query = { agentId: 'agent', sessionId: 'session', runId: snapshot.runId };
  const originalLoad = store.load.bind(store), originalObservation = store.observation.bind(store);
  const fullStore = new Proxy(store, { get: (target, key) => key === 'observation' ? undefined
    : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
  const expected = await make(fullStore).status(query);
  let loads = 0;store.load = (...args) => { loads++;return originalLoad(...args); };
  const recovery = make(store);
  assert.deepEqual(await recovery.status(query), expected);assert.equal(loads, 0);
  const inspected = await recovery.inspect(query);assert.equal(loads, 1);assert.ok(inspected.record.configuration);
  assert.ok(Array.isArray(inspected.record.receipts));assert.equal(inspected.observation, undefined);
  assert.deepEqual(await recovery.status(query), expected);assert.equal(loads, 1);
  store.observation = (...args) => { const value = originalObservation(...args);value.snapshot.sessionId = 'foreign';return value; };
  await assert.rejects(recovery.status(query), { code: 'studio_native_recovery_identity_mismatch' });
  store.observation = originalObservation;
});
