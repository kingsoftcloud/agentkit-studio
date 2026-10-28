// Presentation scheduling for provider-supplied lines. Never generates text.
export const SUMMARY_ROLL_TRANSITION_MS = 300;
export const SUMMARY_ROLL_TOTAL_MS = 800;
export function latestSummaryLine(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return { key: String(i), text: lines[i].trim() };
  return { key: '0', text: '' };
}
export function createSummaryPlayback(initial, publish, clock = {
  now: () => performance.now(), set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id),
}) {
  let current = initial, queue = [], timer = null, disposed = false;
  const clear = () => { if (timer !== null) clock.clear(timer); timer = null; };
  const promote = next => {
    const previous = current; current = next; publish({ current, previous, animate: true });
    const expected = clock.now() + SUMMARY_ROLL_TOTAL_MS;
    timer = clock.set(() => {
      timer = null;
      if (disposed) return;
      if (clock.now() - expected > 250 && queue.length > 1) queue = queue.slice(-1);
      const next = queue.shift(); if (next) promote(next);
    }, SUMMARY_ROLL_TOTAL_MS);
  };
  return {
    update(next, animate = true) {
      if (disposed) return;
      if (!animate) { clear(); queue = []; current = next; publish({ current, previous: null, animate: false }); return; }
      if (current.key === next.key) {
        if (current.text !== next.text) { current = next; publish({ current, animate: false, refresh: true }); }
        return;
      }
      if (timer === null && queue.length === 0) { promote(next); return; }
      const index = queue.findIndex(item => item.key === next.key);
      if (index >= 0) queue[index] = next;
      else queue = queue.length === 0 ? [next] : [queue[0], next];
    },
    dispose() { disposed = true; clear(); queue = []; },
  };
}
