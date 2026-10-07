import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const fragment = await readFile(new URL('../src/client-fragments/08-settings-and-entry.js', import.meta.url), 'utf8');
const source = fragment.slice(0, fragment.indexOf('    function apply(ctx)'));
async function renderSettings(remote) {
  let state, effect;
  const h = (type, props, ...children) => ({ type, props, children });
  const Component = new Function('h','useState','useEffect','hostRemote','BRAND','SectionHeading','SettingsRow','STUDIO_VERSION','DSH_VERSION',source+'; return StudioSettingsSection;')(h, initial => [state ??= initial, value => { state = value; }], cb => { effect ??= cb; }, remote, {}, 'heading', 'row', '0.0.1', '0.2.0-rc.2');
  Component(); effect?.(); await new Promise(resolve => setImmediate(resolve));
  return JSON.stringify(Component());
}
test('Studio settings report a successful Host RPC as connected', async () => {
  const output = await renderSettings({ settings: async () => ({ defaultProfileId: 'profile-a' }) });
  assert.match(output,/已连接/); assert.doesNotMatch(output,/尚未连接|尚未接入|保持只读|开启结构化/);
});
test('Studio settings show an actual Host error without claiming readiness', async () => {
  const output = await renderSettings({ settings: async () => { throw new Error('E2E Host unreachable'); } });
  assert.match(output,/E2E Host unreachable/); assert.doesNotMatch(output,/已连接/);
});
