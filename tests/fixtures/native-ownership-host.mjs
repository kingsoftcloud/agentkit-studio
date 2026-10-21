import assert from 'node:assert/strict';

/** Unit-only ownership carrier for tests which already use a synthetic Session.
 * It does not simulate public Agent lifecycle or authorize recovery. Those
 * boundaries are verified separately with actual maintained DSH Agents.
 */
export function nativeOwnershipHost(session, events) {
  return { contract: 'dsh.external-turn-host/v1',
    pending() {
      const start = events.findLastIndex(event => event.type === 'turn/start');
      const tail = events.slice(start + 1);
      if (tail.some(event => event.type === 'turn/end')) return null;
      return structuredClone(tail.find(event => event.type === 'turn/owner')?.data ?? null);
    },
    claim(ownership) {
      const start = events.findLast(event => event.type === 'turn/start');
      assert.equal(ownership.turn, start.data.turn);
      const previous = this.pending();
      if (previous) assert.deepEqual(ownership, previous);
      else session.append('turn/owner', ownership);
    },
    resume() { throw Error('Synthetic ownership carrier cannot prove or authorize recovery'); },
  };
}
