import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeConversationForkSeed } from '../src/providers/native-conversation-fork.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';

function setup(prefix) {
  const controller = new AbortController(); let disposed = 0, reads = 0;
  const parentEvents = structuredClone(prefix);
  const session = { id: 'child', header: { isSeeded: true, parentSession: 'source' },
    snapshotEvents: () => [...prefix, { seq: prefix.length, type: 'session/end-seed', data: { inherited: true } }],
    isOwnSeq: seq => seq >= prefix.length };
  const observed = { header: { id: 'source' }, events: parentEvents, [Symbol.dispose]() { disposed++; } };
  const request = { ctx: { get: () => ({ observeSession: async () => observed }) }, agent: { session },
    store: { sessionHead: () => null, load: () => { reads++; assert.fail('Unproven prefix cannot read the source checkpoint'); } },
    signal: controller.signal };
  return { request, controller, observed, session, disposed: () => disposed, reads: () => reads };
}
const start = { seq: 0, type: 'turn/start', data: { turn: 1 } };
const owner = { seq: 1, type: 'turn/owner', data: { engine: NATIVE_DSH_TURN_CONTRACT } };

test('an open prefix does not import the source Run which may already have advanced past the cut', async () => {
  const f = setup([start, owner]);
  await assert.rejects(nativeConversationForkSeed(f.request), { code: 'native_conversation_fork_open_boundary' });
  assert.equal(f.disposed(), 1); assert.equal(f.reads(), 0);
});

test('fork-of-an-open-fork synthetic closers are not proof that its original Native Run ended at that boundary', async () => {
  const f = setup([start, owner, { seq: 2, type: 'session/end-seed', data: { inherited: true } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'forked' } } }]);
  await assert.rejects(nativeConversationForkSeed(f.request), { code: 'native_conversation_fork_open_boundary' });
  assert.equal(f.disposed(), 1); assert.equal(f.reads(), 0);
});

test('source observation cancellation and Session replacement never admit imported history', async () => {
  for (const kind of ['abort', 'session', 'parent', 'prefix']) {
    const f = setup([start, owner]);
    f.request.ctx.get = () => ({ observeSession: async () => {
      if (kind === 'abort') f.controller.abort(new Error('Stopped during source query'));
      if (kind === 'session') f.request.agent.session = { id: 'foreign' };
      if (kind === 'parent') f.session.header.parentSession = 'foreign-parent';
      if (kind === 'prefix') f.session.snapshotEvents = () => [{ ...start, data: { turn: 7 } }, owner];
      return f.observed;
    } });
    await assert.rejects(nativeConversationForkSeed(f.request), kind === 'abort' ? /Stopped during source query/ : { code: 'native_conversation_fork_session_changed' });
    assert.equal(f.disposed(), 1); assert.equal(f.reads(), 0);
  }
});
