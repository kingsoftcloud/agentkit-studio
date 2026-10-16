import test from 'node:test';
import assert from 'node:assert/strict';
import { observeComputerConnection } from '../src/client/state/computer-connection.mjs';
import { createHostRoutes } from '../src/host/routes/host.mjs';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(read) {
  let next = 0; const timers = new Map(), states = [], events = new EventTarget();
  const close = observeComputerConnection({ read, publish: state => states.push(state), events,
    setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id) });
  return { timers, states, events, close, tick() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); } };
}
test('a failed device probe removes the connected state and disposal clears all timers', async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw Error('offline'); return { name: 'Test Mac', cloudDelegation: false }; });
  await flush(); assert.equal(f.states.at(-1).status, 'connected');
  fail = true; f.tick(); await flush(); assert.equal(f.states.at(-1).status, 'disconnected');
  f.close(); assert.equal(f.timers.size, 0);
});
test('late device replies cannot revive a closed component or overwrite its replacement', async () => {
  const replies = []; const f = fixture(signal => new Promise(resolve => replies.push({ resolve, signal })));
  f.events.dispatchEvent(new Event('agentkit-studio:connection-reset'));
  assert.equal(replies[0].signal.aborted, true);
  replies[1].resolve({ name: 'Current Mac' }); await flush();
  replies[0].resolve({ name: 'Old Mac' }); await flush();
  assert.equal(f.states.at(-1).computer.name, 'Current Mac');
  const length = f.states.length; f.close(); await flush();
  assert.equal(f.states.length, length); assert.equal(f.timers.size, 0);
});
test('device response reports actual Host facts and never grants cloud execution', async () => {
  const routes = createHostRoutes({ hostCompatibility: { inspect: () => ({ features: { 'agent-presets': { available: true } } }) },
    computer: { hostname: () => 'Test Mac', platform: () => 'darwin', arch: () => 'arm64', release: () => 'fixture' } });
  const reply = await routes('host/computer');
  assert.equal(reply.value.localSessions, true); assert.equal(reply.value.cloudDelegation, false);
  assert.equal(reply.value.name, 'Test Mac'); assert.equal(reply.value.platform, 'darwin');
});
