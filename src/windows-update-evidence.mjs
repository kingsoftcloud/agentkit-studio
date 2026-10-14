/** Classify native Windows download evidence without treating a differential plan as a completed transfer. */
export function windowsDownloadEvidence({ log, states, fullBytes }) {
  if (/Cannot download differentially|fallback to full download/i.test(log)) return { kind: 'full-fallback' };
  const plan = /Full:\s*([0-9,.]+)\s*KB,\s*To download:\s*([0-9,.]+)\s*KB\s*\(([0-9.]+)%\)/.test(log);
  const completed = states.findLast(state => state.phase === 'verifying'
    && Number.isSafeInteger(state.transferredBytes) && state.transferredBytes > 0
    && state.transferredBytes === state.totalDownloadBytes);
  if (!plan || !completed || !Number.isSafeInteger(fullBytes) || completed.transferredBytes >= fullBytes) return { kind: 'not-established' };
  return { kind: 'native-differential', transferredBytes: completed.transferredBytes, fullBytes,
    ratioPercent: Number((100 * completed.transferredBytes / fullBytes).toFixed(2)), actualCompletedProgress: true };
}
