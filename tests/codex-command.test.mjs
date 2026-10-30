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
test('Windows launches the bundled native Codex binary instead of the console-spawning wrapper', () => {
  const script = 'C:\\Product\\resources\\app.asar\\dsh\\node_modules\\@openai\\codex\\bin\\codex.js';
  const native = 'C:\\Product\\resources\\app.asar.unpacked\\dsh\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const resolved = resolveCodexCommand({
    env: {}, platform: 'win32', arch: 'x64', node: 'C:\\Product\\AgentKit Studio.exe',
    resolve: spec => { if (spec === '@openai/codex/bin/codex.js') return script; throw new Error('unused'); },
    exists: value => value === native,
  });
  assert.deepEqual(resolved, { executable: native, prefixArgs: [] });
});
test('Windows arm64 resolves the arm64 native binary', () => {
  const script = 'C:\\Product\\resources\\app.asar\\dsh\\node_modules\\@openai\\codex\\bin\\codex.js';
  const native = 'C:\\Product\\resources\\app.asar.unpacked\\dsh\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe';
  const resolved = resolveCodexCommand({
    env: {}, platform: 'win32', arch: 'arm64', node: 'C:\\Product\\AgentKit Studio.exe',
    resolve: spec => { if (spec === '@openai/codex/bin/codex.js') return script; throw new Error('unused'); },
    exists: value => value === native,
  });
  assert.deepEqual(resolved, { executable: native, prefixArgs: [] });
});
test('Windows keeps the wrapper fallback only when no native binary is packaged', () => {
  const script = 'C:\\Program Files\\AgentKit\\resources\\app.asar\\dsh\\node_modules\\@openai\\codex\\bin\\codex.js';
  const resolved = resolveCodexCommand({
    env: {}, platform: 'win32', arch: 'x64', node: 'C:\\Program Files\\AgentKit\\AgentKit Studio.exe',
    resolve: () => script, exists: () => false,
  });
  assert.deepEqual(resolved, { executable: 'C:\\Program Files\\AgentKit\\AgentKit Studio.exe', prefixArgs: [script] });
});
