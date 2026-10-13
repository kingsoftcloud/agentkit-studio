import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dshPresetId } from '../src/agent-preset-admission.mjs';
const source = readFileSync(new URL('../src/client-fragments/01-loader-and-primitives.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('    function agentFromSessionPreset('), source.indexOf('    function writeConversationAgent('));
const resolve = runInNewContext(`${helper}\nagentFromSessionPreset`);
test('Agent identity follows the durable preset after workspace cancellation and reload', () => {
  const agents = [{ metadata: { id: 'blind-b' } }, { id: '测试/Agent' }];
  assert.equal(resolve(dshPresetId('blind-b', 3, 'frozen-build'), agents), 'blind-b');
  assert.equal(resolve(dshPresetId('测试/Agent', 2), agents), '测试/Agent');
  assert.equal(resolve('standard', agents), null);
  assert.equal(resolve(undefined, agents), null);
});
