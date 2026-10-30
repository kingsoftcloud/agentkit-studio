import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRunPresentation } from '../src/host/state/native-outcome.mjs';

test('the UI offers recovery only when the authoritative Native control reports it is available', () => {
  const stopped = { runId: 'run', phase: 'interrupted', state: 'failed', canResume: false,
    reason: 'browser_session_unavailable', error: { message: '浏览器会话不可用，请重新建立浏览器连接。' } };
  assert.deepEqual(nativeRunPresentation(stopped), { label: '任务已中断', detail: stopped.error.message });
  const recoverable = { runId: 'run', phase: 'executing_tools', state: 'available', canResume: true };
  assert.match(nativeRunPresentation(recoverable).label, /等待恢复/);
  assert.doesNotMatch(nativeRunPresentation({ ...recoverable, canResume: false }).detail, /恢复原任务后才会继续/);
  const uncertain = nativeRunPresentation({ ...stopped, reason: 'effect_outcome_unknown' });
  assert.match(uncertain.label, /结果待核对/);assert.match(uncertain.detail, /不会自动重跑/);
});
