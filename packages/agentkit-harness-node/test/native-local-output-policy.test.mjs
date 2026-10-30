import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  localOutputPolicy, localEnvironmentPolicy, resolveOutputPolicy, resolveEnvironmentPolicy,
  outputPolicyVersion, environmentPolicyVersion, OUTPUT_POLICY_CONTRACT, ENVIRONMENT_POLICY_CONTRACT,
  BASIC_ENVIRONMENT_NAMES,
} from '../src/native/local-output-policy.mjs';
import { runBoundedProcess, buildScriptEnvironment, localControlSettings } from '../src/native/local-process.mjs';
import { LocalCommandStore, commandRequest } from '../src/native/local-background.mjs';
import { digest } from '../src/native/local-command-state.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function workspace(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'native-output-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'native-output-policy-bg-')), ws = join(root, 'workspace');
  mkdirSync(ws);
  const config = { stateRoot: join(root, 'state'), workspaceRoot: ws, sessionId: 'session' };
  const store = new LocalCommandStore(config), handles = [];
  t.after(async () => {
    for (const h of handles) { try { await h.kill(); } catch { /* bounded by wallSeconds */ } }
    rmSync(root, { recursive: true, force: true });
  });
  const input = (command, overrides = {}) => ({ command, cwd: ws, env: buildScriptEnvironment({ PATH: '/bin:/usr/bin' }),
    settings: { wallSeconds: 10 }, ...overrides });
  return { root, ws, config, store, input, handles,
    async start(command, overrides = {}) { const h = await store.start(input(command, overrides)); handles.push(h); return h; } };
}
const policy = (overrides = {}) => ({ version: outputPolicyVersion, ...overrides });
const run = (directory, argv, options = {}) => runBoundedProcess({ cwd: directory, argv,
  env: buildScriptEnvironment({ PATH: '/bin:/usr/bin' }), ...options });

// --- Policy parsing & validation -------------------------------------------------

test('localOutputPolicy null/undefined yields legacy semantics; valid policy is frozen and omits undefined', () => {
  assert.equal(localOutputPolicy(null), null);
  assert.equal(localOutputPolicy(undefined), null);
  assert.equal(localOutputPolicy(), null);
  const p = localOutputPolicy({ version: outputPolicyVersion, previewBytes: 100 });
  assert.deepEqual({ ...p }, { version: outputPolicyVersion, previewBytes: 100 });
  assert.ok(Object.isFrozen(p));
  // Omitted caps stay absent (canonical serialization rejects undefined).
  assert.equal(Object.hasOwn(p, 'persistedBytes'), false);
  const full = localOutputPolicy({ previewBytes: 50, persistedBytes: 1000 });
  assert.deepEqual({ ...full }, { version: outputPolicyVersion, previewBytes: 50, persistedBytes: 1000 });
});
test('localOutputPolicy rejects unknown options, invalid versions and invalid limits', () => {
  for (const input of ['x', 42, []]) assert.throws(() => localOutputPolicy(input), { code: 'invalid_output_policy' });
  assert.throws(() => localOutputPolicy({ unknown: 1 }), { code: 'invalid_output_policy_option' });
  assert.throws(() => localOutputPolicy({ version: 'other/v1' }), { code: 'unsupported_output_policy_version' });
  for (const input of [{ previewBytes: 0 }, { previewBytes: 1.5 }]) assert.throws(() => localOutputPolicy(input), { code: 'invalid_output_policy_preview' });
  assert.throws(() => localOutputPolicy({ persistedBytes: -1 }), { code: 'invalid_output_policy_persisted' });
});
test('localEnvironmentPolicy admits only basic names and omits undefined', () => {
  assert.equal(localEnvironmentPolicy(null), null);
  assert.equal(localEnvironmentPolicy(), null);
  const all = localEnvironmentPolicy({ version: environmentPolicyVersion });
  assert.deepEqual({ ...all }, { version: environmentPolicyVersion, names: [...BASIC_ENVIRONMENT_NAMES] });
  assert.ok(Object.isFrozen(all));
  assert.equal(Object.hasOwn(all, 'names'), true);
  const subset = localEnvironmentPolicy({ names: ['HOME', 'TMPDIR'] });
  assert.deepEqual({ ...subset }, { version: environmentPolicyVersion, names: ['HOME', 'TMPDIR'] });
});
test('localEnvironmentPolicy rejects arbitrary names, credentials and unknown options', () => {
  for (const input of [{ names: 'HOME' }, { names: [42] }])
    assert.throws(() => localEnvironmentPolicy(input), { code: 'invalid_environment_policy_names' });
  for (const names of [['SECRET'], ['PATH'], ['HOME', 'HACK']])
    assert.throws(() => localEnvironmentPolicy({ names }), { code: 'invalid_environment_policy_names' });
  assert.throws(() => localEnvironmentPolicy({ unknown: 1 }), { code: 'invalid_environment_policy_option' });
  assert.throws(() => localEnvironmentPolicy({ version: 'other/v1' }), { code: 'unsupported_environment_policy_version' });
});
test('BASIC_ENVIRONMENT_NAMES is exactly HOME/USER/LOGNAME/TMPDIR/USERPROFILE, never arbitrary', () => {
  assert.deepEqual([...BASIC_ENVIRONMENT_NAMES], ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'USERPROFILE']);
  assert.ok(Object.isFrozen(BASIC_ENVIRONMENT_NAMES));
});
test('resolveOutputPolicy legacy uses maxOutputBytes; persistedStream clamps preview to persisted', () => {
  const settings = localControlSettings({ maxOutputBytes: 2048 });
  assert.deepEqual(resolveOutputPolicy(settings, null), { mode: 'legacy', previewBytes: 2048, persistedBytes: 2048 });
  const r = resolveOutputPolicy(settings, localOutputPolicy(policy({ previewBytes: 1000 })));
  assert.equal(r.mode, 'persistedStream'); assert.equal(r.previewBytes, 1000);
  assert.ok(r.persistedBytes >= 64 * 1024 ** 2);
  // preview can never exceed the persisted cap
  const clamped = resolveOutputPolicy(settings, localOutputPolicy(policy({ previewBytes: 10 ** 9, persistedBytes: 1000 })));
  assert.equal(clamped.previewBytes, 1000); assert.equal(clamped.persistedBytes, 1000);
});

// --- Digest stability -----------------------------------------------------------

test('commandRequest without policy has byte-identical digest to legacy; policy adds only its field', () => {
  const base = { command: 'printf x', cwd: '/tmp', env: { PATH: '/bin' }, settings: { wallSeconds: 10 } };
  const legacy = commandRequest(base);
  assert.deepEqual(Object.keys(legacy), ['command', 'cwd', 'env', 'timeoutMs', 'settings']);
  const d0 = digest(legacy);
  // A request built identically but also offered null policies must not carry them.
  const withNull = commandRequest({ ...base, outputPolicy: null, environmentPolicy: null });
  assert.equal(digest(withNull), d0);
  // Adding a policy changes only the outputPolicy field; settings digest unchanged.
  const withPolicy = commandRequest({ ...base, outputPolicy: policy({ previewBytes: 100, persistedBytes: 1000 }) });
  assert.deepEqual(Object.keys(withPolicy), ['command', 'cwd', 'env', 'timeoutMs', 'settings', 'outputPolicy']);
  assert.notEqual(digest(withPolicy), d0);
  // settings object is byte-identical with or without the policy.
  assert.equal(digest(withPolicy.settings), digest(legacy.settings));
});
test('commandRequest validates raw outputPolicy/environmentPolicy at the entrypoint', () => {
  const base = { command: 'printf x', cwd: '/tmp', env: { PATH: '/bin' }, settings: { wallSeconds: 10 } };
  assert.throws(() => commandRequest({ ...base, outputPolicy: { unknown: 1 } }), { code: 'invalid_output_policy_option' });
  assert.throws(() => commandRequest({ ...base, outputPolicy: { version: 'other/v1' } }), { code: 'unsupported_output_policy_version' });
  assert.throws(() => commandRequest({ ...base, environmentPolicy: { names: ['SECRET'] } }), { code: 'invalid_environment_policy_names' });
  assert.throws(() => commandRequest({ ...base, environmentPolicy: { unknown: 1 } }), { code: 'invalid_environment_policy_option' });
});

// --- persisted-stream/v1: preview overflow completes with exactly one side effect ---

test('preview overflow does NOT kill a successful process; one side effect, exit 0', async t => {
  const directory = workspace(t), marker = join(directory, 'side-effect');
  const result = await run(directory, ['/bin/sh', '-c',
    `printf "%s" "012345678901234567890123456789" > "${marker}"; printf done`],
    { settings: { wallSeconds: 10 }, outputPolicy: policy({ previewBytes: 8, persistedBytes: 65536 }) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputLimitExceeded, false);
  assert.equal(result.stdout, 'done'); // streamed tail; preview bound is on captured preview
  assert.equal(existsSync(marker), true);
  assert.equal(readFileSync(marker, 'utf8'), '012345678901234567890123456789');
});

// --- Hard persisted cap still enforces ---

test('hard persisted cap stops the process at output_limit (exit 122)', async t => {
  const directory = workspace(t);
  const result = await run(directory, ['/bin/sh', '-c', 'printf "%s" "ABCDEFGHIJKLMNOPQRSTUVWXYZ"'],
    { settings: { wallSeconds: 10 }, outputPolicy: policy({ previewBytes: 4, persistedBytes: 12 }) });
  assert.equal(result.exitCode, 122);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.stdoutPersistedTruncated, true);
});
test('an overcap first chunk still yields a non-empty preview (captured before hard-cap return)', async t => {
  const directory = workspace(t);
  const result = await run(directory, ['/bin/sh', '-c', 'printf "%s" "ABCDEFGHIJKLMNOPQRSTUVWXYZ"'],
    { settings: { wallSeconds: 10 }, outputPolicy: policy({ previewBytes: 8, persistedBytes: 12 }) });
  assert.equal(result.exitCode, 122);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.stdout, 'ABCDEFGH'); // non-empty preview even though first chunk exceeded the cap
});
test('a cap-cut multibyte sequence is dropped, not flushed as replacement bytes beyond the cap', async t => {
  const directory = workspace(t);
  const streamed = [];
  // € is 3 bytes (E2 82 AC); €€ is 6 bytes; persistedBytes=4 cuts mid-second-sequence.
  const result = await run(directory, ['/bin/sh', '-c', "printf '\\342\\202\\254\\342\\202\\253'"],
    { settings: { wallSeconds: 10 }, outputPolicy: policy({ previewBytes: 8, persistedBytes: 4 }),
      onOutput: (ch, text) => streamed.push(text) });
  assert.equal(result.exitCode, 122);
  assert.equal(result.outputLimitExceeded, true);
  // Only the complete first € (3 bytes) is streamed; no replacement char beyond the cap.
  assert.equal(streamed.join(''), '€');
  assert.equal(Buffer.byteLength(streamed.join('')), 3);
  assert.equal(streamed.join('').includes('�'), false);
});

// --- Split UTF-8 across preview/persist boundary decodes correctly ---

test('split UTF-8 stream decodes correctly; preview cut is honest, full stream has no replacement', async t => {
  const directory = workspace(t);
  const streamed = [];
  // € is 3 bytes (E2 82 AC). Emit in two chunks so it spans a chunk boundary.
  const result = await run(directory, ['/bin/sh', '-c', "printf '\\342\\202'; printf '\\254\\342\\202\\254'"],
    { settings: { wallSeconds: 10 }, outputPolicy: policy({ previewBytes: 2, persistedBytes: 65536 }),
      onOutput: (ch, text) => streamed.push(text) });
  assert.equal(result.exitCode, 0);
  // The full stream via onOutput reconstructs both € characters (no replacement char).
  assert.equal(streamed.join(''), '€€');
  assert.ok(Buffer.byteLength(result.stdout) <= 2);
});

test('normalizing invalid UTF-8 cannot expand either preview or persisted output beyond its byte cap', async t => {
  const directory = workspace(t), streamed = [];
  const result = await run(directory, ['/bin/sh', '-c', "printf '\\377\\377\\377\\377'"], {
    outputPolicy: policy({ previewBytes: 3, persistedBytes: 4 }), onOutput: (_channel, text) => streamed.push(text),
  });
  assert.equal(result.outputLimitExceeded, true); assert.equal(result.exitCode, 122);
  assert.ok(Buffer.byteLength(result.stdout) <= 3);
  assert.ok(Buffer.byteLength(streamed.join('')) <= 4);
});

// --- Restricted env default excludes HOME/secrets; explicit local env includes basic names ---

test('default (no environmentPolicy) excludes HOME and secrets from the script environment', () => {
  const env = buildScriptEnvironment({ HOME: '/tmp/native-home', SECRET_KEY: 'leak', PATH: '/bin', API_TOKEN: 'x' },
    { settings: localControlSettings({}) });
  assert.equal(env.HOME, undefined);
  assert.equal(env.SECRET_KEY, undefined);
  assert.equal(env.API_TOKEN, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CI, '1');
});
test('local-development environmentPolicy admits only the basic names, never full process.env', () => {
  const source = { HOME: '/tmp/native-home', USER: 'me', LOGNAME: 'me', TMPDIR: '/tmp', USERPROFILE: '/tmp/native-profile',
    SECRET_KEY: 'leak', PATH: '/bin', NODE_OPTIONS: 'injected' };
  const env = buildScriptEnvironment(source,
    { settings: localControlSettings({}), environmentPolicy: { version: environmentPolicyVersion } });
  assert.equal(env.HOME, '/tmp/native-home');
  assert.equal(env.USER, 'me');
  assert.equal(env.LOGNAME, 'me');
  assert.equal(env.TMPDIR, '/tmp');
  assert.equal(env.USERPROFILE, '/tmp/native-profile');
  assert.equal(env.SECRET_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PATH, '/bin');
});
test('environmentPolicy with a subset of names admits only that subset', () => {
  const source = { HOME: '/tmp/native-home', USER: 'me', TMPDIR: '/tmp', LOGNAME: 'me', USERPROFILE: '/u' };
  const env = buildScriptEnvironment(source,
    { settings: localControlSettings({}), environmentPolicy: { names: ['HOME', 'TMPDIR'] } });
  assert.equal(env.HOME, '/tmp/native-home');
  assert.equal(env.TMPDIR, '/tmp');
  assert.equal(env.USER, undefined);
  assert.equal(env.LOGNAME, undefined);
  assert.equal(env.USERPROFILE, undefined);
});
test('buildScriptEnvironment validates raw environmentPolicy at the entrypoint', () => {
  assert.throws(() => buildScriptEnvironment({}, { environmentPolicy: { names: ['SECRET'] } }), { code: 'invalid_environment_policy_names' });
  assert.throws(() => buildScriptEnvironment({}, { environmentPolicy: { unknown: 1 } }), { code: 'invalid_environment_policy_option' });
});

// --- Cancellation and errors preserved under the new policy ---

test('cancellation under persisted-stream reports canceled, not masked by preview truncation', async t => {
  const directory = workspace(t), controller = new AbortController();
  const running = run(directory, ['/bin/sleep', '60'],
    { settings: { wallSeconds: 10 }, outputPolicy: policy({ previewBytes: 8, persistedBytes: 65536 }),
      signal: controller.signal });
  await pause(150); controller.abort();
  const result = await running;
  assert.equal(result.canceled, true);
  assert.equal(result.outputLimitExceeded, false);
});
test('a real command failure under persisted-stream reports the nonzero exit, not a preview artifact', async t => {
  const directory = workspace(t);
  const result = await run(directory, ['/bin/sh', '-c', 'printf "%s" "data"; exit 7'],
    { settings: { wallSeconds: 10 }, outputPolicy: policy({ previewBytes: 8, persistedBytes: 65536 }) });
  assert.equal(result.exitCode, 7);
  assert.equal(result.outputLimitExceeded, false);
});

// --- Full output cursor after supervisor publication AND after cold store re-open ---

test('supervisor persisted-stream: full output is cursor-readable; receipt preview is bounded', async t => {
  const f = fixture(t);
  const h = await f.start('printf "%s" "0123456789012345678901234567890123456789"',
    { outputPolicy: policy({ previewBytes: 8, persistedBytes: 65536 }) });
  const waited = await h.wait({ timeoutMs: 5000 });
  assert.equal(waited.status, 'completed'); assert.equal(waited.exitCode, 0);
  // Full output lives in the streamed file; cursor reads reconstruct it.
  assert.equal(waited.stdout, '0123456789012345678901234567890123456789');
  assert.equal(waited.stdoutCursor, 40);
  // A bounded window returns only the first previewBytes bytes.
  const window = h.readOutput({ maxBytes: 8 });
  assert.equal(window.stdout, '01234567');
  assert.equal(window.stdoutCursor, 8);
  assert.equal(window.outputMayBeTruncated, true);
  // Continuing from the cursor reads the rest.
  const rest = h.readOutput({ stdoutCursor: 8, maxBytes: 65536 });
  assert.equal(rest.stdout, '89012345678901234567890123456789');
  assert.equal(rest.stdoutCursor, 40);
  assert.equal(rest.outputMayBeTruncated, false);
});
test('supervisor persisted-stream full output survives a cold store re-open via cursors', async t => {
  const f = fixture(t);
  const h = await f.start('printf "%s" "ABCDEF"',
    { outputPolicy: policy({ previewBytes: 4, persistedBytes: 65536 }) });
  await h.wait({ timeoutMs: 5000 });
  // Reopen the store (fresh process) and read the full output by cursor.
  const reopened = new LocalCommandStore(f.config).connect(h.commandId);
  const first = reopened.readOutput({ maxBytes: 4 });
  assert.equal(first.stdout, 'ABCD');
  const full = reopened.readOutput({ stdoutCursor: 4, maxBytes: 65536 });
  assert.equal(full.stdout, 'EF');
  assert.equal(full.status, 'completed'); assert.equal(full.exitCode, 0);
});
test('supervisor persisted-stream hard cap records output_limit and the file holds only the cap', async t => {
  const f = fixture(t);
  const h = await f.start('printf "%s" "ABCDEFGHIJKLMNOPQRSTUVWXYZ"',
    { outputPolicy: policy({ previewBytes: 4, persistedBytes: 12 }) });
  const waited = await h.wait({ timeoutMs: 5000 });
  assert.equal(waited.status, 'output_limit'); assert.equal(waited.exitCode, 122);
  assert.equal(readFileSync(join(h.directory, 'stdout')).length, 12);
  assert.equal(waited.outputMayBeTruncated, true);
});
test('supervisor persisted-stream does NOT overwrite full streamed files with the preview', async t => {
  const f = fixture(t);
  const h = await f.start('printf "%s" "0123456789012345678901234567890"',
    { outputPolicy: policy({ previewBytes: 6, persistedBytes: 65536 }) });
  await h.wait({ timeoutMs: 5000 });
  // The streamed file must hold the FULL output (30 bytes), not the 6-byte preview.
  assert.equal(readFileSync(join(h.directory, 'stdout'), 'utf8'), '0123456789012345678901234567890');
});
test('supervisor persisted-stream preview overflow completes without killing; marker proves one side effect', async t => {
  const f = fixture(t), marker = join(f.ws, 'marker');
  const h = await f.start('printf "%s" "012345678901234567890123456789" > marker; printf done',
    { outputPolicy: policy({ previewBytes: 8, persistedBytes: 65536 }) });
  const waited = await h.wait({ timeoutMs: 5000 });
  assert.equal(waited.status, 'completed'); assert.equal(waited.exitCode, 0);
  assert.equal(existsSync(marker), true);
  assert.equal(readFileSync(marker, 'utf8'), '012345678901234567890123456789');
});

// --- Legacy mode preserved when policy absent (regression guard) ---

test('legacy runBoundedProcess (no policy) still kills at maxOutputBytes with exit 122', async t => {
  const directory = workspace(t);
  const result = await run(directory, ['/bin/sh', '-c', 'printf "%s" "ABCDEFGHIJKLMNOPQRSTUVWXYZ"'],
    { settings: { maxOutputBytes: 8, wallSeconds: 10 } });
  assert.equal(result.exitCode, 122);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.stdout, 'ABCDEFGH');
  assert.equal('stdoutPersistedTruncated' in result, false);
  assert.equal('previewBytes' in result, false);
});
test('legacy supervisor (no policy) publishes complete bytes via atomicPrivate, exact old contract', async t => {
  const f = fixture(t);
  const h = await f.start('printf "%s" "hello"; printf "%s" "diag" >&2; exit 7');
  const result = await h.wait({ timeoutMs: 5000 });
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'hello'); assert.equal(result.stderr, 'diag');
});
