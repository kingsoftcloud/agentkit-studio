import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const source = await readFile(new URL('../src/client-fragments/06-automation-and-operations.js', import.meta.url), 'utf8');
test('editing a scheduled instant preserves its local wall clock time', () => {
  const helper = source.slice(source.indexOf('    function localDateTimeValue'), source.indexOf('    function scheduleLabel'));
  const value = execFileSync(process.execPath, ['-e', `${helper}; process.stdout.write(localDateTimeValue('2026-10-07T05:00:00.000Z'));`], {env:{...process.env,TZ:'Asia/Shanghai'},encoding:'utf8'});
  assert.equal(value,'2026-10-07T13:00');
});
test('a blank one-time schedule is refused instead of silently selecting one hour later', async () => {
  const body = source.slice(source.indexOf('      const save = async () =>'), source.indexOf('      const startEdit ='));
  const errors = [];
  const save = new Function('form','setError',`${body}; return save;`)({agentId:'agent-a',displayName:'Test',prompt:'Test',kind:'once',at:''},message=>errors.push(message));
  await save();
  assert.deepEqual(errors,['请选择未来的执行时间。']);
});
