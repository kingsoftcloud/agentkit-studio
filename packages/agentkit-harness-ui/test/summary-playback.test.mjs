import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummaryPlayback, latestSummaryLine } from '../src/summary-playback.mjs';

function fixture() {
  let now = 0, timer = null;
  const frames = [];
  const player = createSummaryPlayback({ key: '0', text: 'first' }, frame => frames.push(frame), {
    now: () => now, set(fn, ms) { timer = { fn, at: now + ms }; return timer; }, clear(id) { if (timer === id) timer = null; },
  });
  return { player, frames, advance(drift = 0) { const pending = timer; timer = null; now = pending.at + drift; pending.fn(); }, hasTimer: () => timer !== null };
}
test('latest line uses its normalized line index, including CRLF and trailing blanks', () => {
  assert.deepEqual(latestSummaryLine('one\r\n two \r\n\n'), { key: '1', text: 'two' });
  assert.deepEqual(latestSummaryLine('  \n'), { key: '0', text: '' });
});
test('real text refreshes in place; new lines keep the next and newest pending snapshots', () => {
  const f = fixture(); f.player.update({ key: '0', text: 'first grows' });
  assert.equal(f.frames.at(-1).refresh, true); assert.equal(f.hasTimer(), false);
  for (const key of ['1', '2', '3', '4']) f.player.update({ key, text: key });
  f.player.update({ key: '2', text: 'second refreshed while queued' });
  f.advance(); assert.equal(f.frames.at(-1).current.text, 'second refreshed while queued');
  f.advance(); assert.equal(f.frames.at(-1).current.key, '4');
  f.player.dispose(); assert.equal(f.hasTimer(), false);
});
test('late timers skip stale backlog and reduced motion flushes without replaying lines', () => {
  const f = fixture(); for (const key of ['1', '2', '3']) f.player.update({ key, text: key });
  f.advance(251); assert.equal(f.frames.at(-1).current.key, '3');
  f.player.update({ key: '4', text: 'latest' }, false);
  assert.equal(f.frames.at(-1).animate, false); assert.equal(f.hasTimer(), false);
  f.player.dispose(); f.player.update({ key: '5', text: 'ignored' });
  assert.equal(f.frames.at(-1).current.key, '4');
});
