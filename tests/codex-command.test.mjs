import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexCommand } from '../src/providers/codex-command.mjs';
test('the bundled official CLI runs using the Host Node binary', () => {
  assert.deepEqual(resolveCodexCommand({ env: {}, node: '/runtime/node', resolve: () => '/bundled/codex/bin/codex.js' }), { executable: '/runtime/node', prefixArgs: ['/bundled/codex/bin/codex.js'] });
});
test('an explicit executable takes precedence over the pinned package', () => {
  assert.deepEqual(resolveCodexCommand({ env: { AGENTKIT_CODEX_BIN: '/custom/codex' }, resolve: () => { throw new Error('unused'); } }), { executable: '/custom/codex', prefixArgs: [] });
});
test('legacy profiles without the optional bundled CLI keep their system fallback', () => {
  assert.deepEqual(resolveCodexCommand({ env: {}, resolve: () => { throw new Error('missing'); } }), { executable: 'codex', prefixArgs: [] });
});
test('packaged CLI launch uses the real unpacked path for its native executable', () => {
  const resolved = resolveCodexCommand({ env: {}, node: '/product/node', resolve: () => '/product/Resources/app.asar/dsh/node_modules/@openai/codex/bin/codex.js', exists: path => path.includes('app.asar.unpacked') });
  assert.match(resolved.prefixArgs[0], /app\.asar\.unpacked/);
});
