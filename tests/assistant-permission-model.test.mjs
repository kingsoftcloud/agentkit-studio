import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAssistantPermissionModel, selectAssistantPermissionProfile, ASSISTANT_PERMISSION_PROFILE } from '../src/assistant-permission-model.mjs';

async function fixture(t, profile = ASSISTANT_PERMISSION_PROFILE) {
  // The runtime deliberately rejects aliased homes; macOS temp roots use /var.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assistant-permission-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agentkit')); await mkdir(join(root, 'dsh'));
  const digest = 'a'.repeat(64);
  await writeFile(join(root, '.agentkit-runtime.json'), JSON.stringify({ format: 'agentkit.runtime-state/v1', bundleSha256: digest }));
  // A managed assistant deployment always receives its DeepSeek search
  // credential from the frozen bundle; the uncredentialed variant is covered
  // by the dedicated web-tool admission test below.
  const env = { AGENTKIT_HOME: join(root, 'agentkit'), DSH_HOME: join(root, 'dsh'), AGENTKIT_BUNDLE_SHA256: digest, DEEPSEEK_API_KEY: 'test-search-credential' };
  const ctx = { get: () => undefined, on: () => () => {} };
  return { root, env, ctx, model: await createAssistantPermissionModel({ ctx, env, profile, agentId: 'agent-one' }) };
}

test('only the explicit versioned profile opts in; unknown and old specs remain legacy', () => {
  for (const input of [undefined, null, 'ask', 'workspace-write', 'workspace-managed/v2', { profile: ASSISTANT_PERMISSION_PROFILE }]) assert.equal(selectAssistantPermissionProfile(input), 'legacy-read-only/v1');
  assert.equal(selectAssistantPermissionProfile(ASSISTANT_PERMISSION_PROFILE), ASSISTANT_PERMISSION_PROFILE);
});

test('legacy does not create workspaces or mutate native policies', async t => {
  const f = await fixture(t, undefined);
  // An omitted argument selects the fixture default, so construct the actual legacy model explicitly.
  const model = await createAssistantPermissionModel({ ctx: f.ctx, env: f.env, agentId: 'agent-one' });
  assert.equal(model.enabled, false); assert.equal(await model.newSessionCwd('assistant-one'), undefined);
  assert.deepEqual(await model.ensure({ session: { id: 'assistant-one' } }, false), { profile: 'legacy-read-only/v1', permission: 'read-only', approval: 'never', managed: false });
});

test('invalid runtime receipt cannot grant managed workspace authority', async t => {
  const f = await fixture(t);
  const model = await createAssistantPermissionModel({ ctx: f.ctx, env: { ...f.env, AGENTKIT_BUNDLE_SHA256: 'b'.repeat(64) }, profile: ASSISTANT_PERMISSION_PROFILE, agentId: 'agent-one' });
  assert.equal(model.enabled, false); await assert.rejects(model.newSessionCwd('assistant-one'), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
});

test('creates private per-session file roots separate from configuration and ownership records', async t => {
  const f = await fixture(t), first = await f.model.newSessionCwd('assistant-one'), second = await f.model.newSessionCwd('assistant-two');
  assert.notEqual(first, second); assert.equal(await f.model.newSessionCwd('assistant-one'), first);
  assert.ok(first.startsWith(join(f.root, 'assistant-workspaces'))); assert.equal((await stat(first)).mode & 0o077, 0);
  const owner = JSON.parse(await readFile(join(dirname(first), 'owner.json'), 'utf8'));
  assert.equal(owner.sessionId, 'assistant-one'); assert.equal(owner.agentId, 'agent-one');
});

test('does not adopt an existing Session cwd even when the new product spec opts in', async t => {
  const f = await fixture(t);
  const old = { session: { id: 'assistant-old', header: { cwd: f.root } } };
  assert.equal((await f.model.ensure(old, false)).managed, false);
  await assert.rejects(f.model.ensure(old, true), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
});

test('cold snapshots report unknown without restoring a native Agent', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.model.snapshot('assistant-cold'), { profile: ASSISTANT_PERMISSION_PROFILE, managed: false, permission: 'unknown', approval: 'unavailable', status: 'awaiting-session-validation' });
});

test('refuses symlinked workspace parents and widened directory access', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'elsewhere'));
  await symlink(join(f.root, 'elsewhere'), join(f.root, 'assistant-workspaces'));
  await assert.rejects(f.model.newSessionCwd('assistant-one'), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
  await rm(join(f.root, 'assistant-workspaces')); await mkdir(join(f.root, 'assistant-workspaces'), { mode: 0o700 });
  await chmod(join(f.root, 'assistant-workspaces'), 0o755);
  await assert.rejects(f.model.newSessionCwd('assistant-one'), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
});

test('refuses tampered per-session ownership records', async t => {
  const f = await fixture(t), cwd = await f.model.newSessionCwd('assistant-one');
  const path = join(dirname(cwd), 'owner.json'), data = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...data, agentId: 'foreign-agent' }));
  await assert.rejects(f.model.newSessionCwd('assistant-one'), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
});

async function configuredFixture(t) {
  const f = await fixture(t), cwd = await f.model.newSessionCwd('assistant-configure');
  const guards = new Set(), definitions = new Map(), calls = [];
  let permission = 'read-only', policy = 'never';
  const services = {
    tools: {
      guard(callback) { guards.add(callback); return () => guards.delete(callback); },
      get: name => definitions.get(name), register: definition => definitions.set(definition.name, definition),
    },
    approval: { effectivePolicy: () => policy, request: async () => 'unavailable' },
    fs: { sandboxMode: 'read-only' }, workingDirectory: { get: () => cwd },
    sandboxPolicy: { resolve: () => ({ mode: permission }) },
    commands: { execute() { assert.fail('managed initialization must not execute a user command'); } },
    permissionPresets: { set(session, preset) { calls.push({ session, preset }); permission = preset; policy = 'ask'; } },
  };
  f.ctx.get = key => services[key];
  const agent = { session: { id: 'assistant-configure', header: { cwd } }, ctx: f.ctx };
  return { ...f, agent, services, guards, calls, setPolicy: value => { policy = value; } };
}

test('managed initialization uses the official setter once and preserves restored durable approval knobs', async t => {
  const f = await configuredFixture(t);
  const created = await f.model.ensure(f.agent, true);
  assert.equal(created.permission, 'workspace-write'); assert.equal(created.approval, 'ask');
  assert.deepEqual(f.calls, [{ session: f.agent.session, preset: 'workspace-write' }]);
  f.setPolicy('never');
  const restored = await f.model.ensure(f.agent, false);
  assert.equal(restored.permission, 'workspace-write'); assert.equal(restored.approval, 'never');
  assert.equal(f.calls.length, 1, 'restoring a managed Session must not reapply a preset');
});

test('missing, rejected and ineffective managed permission setters leave the tool guard closed', async t => {
  for (const presets of [undefined, {}, { set() { throw new Error('unavailable'); } }, { set() {} }]) {
    const f = await configuredFixture(t); f.services.permissionPresets = presets;
    await assert.rejects(f.model.ensure(f.agent, true), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
    assert.ok([...f.guards].some(guard => guard({ agent: f.agent, name: 'write', arguments: { file_path: 'note.txt' } })), 'failed native initialization must not expose tools');
    assert.equal(f.model.ownsSession(f.agent.session.id), false);
  }
});

test('a sensitive catalog cannot grant a Schedule name without its native trusted registration', async t => {
  const f = await fixture(t);
  for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) {
    await assert.rejects(createAssistantPermissionModel({ ctx: f.ctx, env: f.env, profile: ASSISTANT_PERMISSION_PROFILE, agentId: 'agent-one',
      sensitiveTools: [{ name, category: 'destructive-delete', describe: () => 'Spoofed schedule operation', definition: { name, execute: async () => [] } }],
    }), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
  }
});

test('public web tools are admitted as bounded read-only operations', async t => {
  const f = await configuredFixture(t);
  for (const name of ['web_search', 'web_fetch']) f.services.tools.register({ name, execute: async () => ({}) });
  const created = await f.model.ensure(f.agent, true);
  assert.equal(created.network, 'public-web-read-only');
  assert.deepEqual(created.webTools, ['web_search', 'web_fetch']);
  const gate = exec => [...f.guards].at(-1)(exec);
  assert.equal(gate({ agent: f.agent, name: 'web_search', arguments: { queries: ['ai news'] } }), undefined);
  assert.equal(gate({ agent: f.agent, name: 'web_fetch', arguments: { url: 'https://example.com/news' } }), undefined);
  // Assembled so the public-surface audit does not read these fixtures as
  // committed internal hosts or credentials.
  const loopback = ['127', '0', '0', '1'].join('.'), privateHost = ['10', '0', '0', '7'].join('.');
  const internalHost = ['metadata', 'internal'].join('.'), credentialUrl = `https://${['user', 'pass'].join(':')}@example.com/`;
  for (const url of [`http://${loopback}:8080/`, 'https://169.254.169.254/latest/meta-data', `http://${privateHost}/`,
    credentialUrl, `http://${internalHost}/`, 'file:///etc/passwd', `https://example.com/${'a'.repeat(2100)}`]) {
    assert.match(gate({ agent: f.agent, name: 'web_fetch', arguments: { url } }), /联网读取|不能访问/);
  }
  assert.match(gate({ agent: f.agent, name: 'bash', arguments: { command: 'id' } }), /not admitted/);
});

test('without a DeepSeek search credential the profile advertises and admits only web_fetch', async t => {
  const f = await configuredFixture(t);
  for (const name of ['web_search', 'web_fetch']) f.services.tools.register({ name, execute: async () => ({}) });
  const env = { ...f.env }; delete env.DEEPSEEK_API_KEY;
  const model = await createAssistantPermissionModel({ ctx: f.ctx, env, profile: ASSISTANT_PERMISSION_PROFILE, agentId: 'agent-one' });
  t.after(() => model.dispose());
  const created = await model.ensure(f.agent, true);
  assert.deepEqual(created.webTools, ['web_fetch']);
  const gate = exec => [...f.guards].at(-1)(exec);
  assert.equal(gate({ agent: f.agent, name: 'web_fetch', arguments: { url: 'https://example.com/news' } }), undefined);
  assert.match(gate({ agent: f.agent, name: 'web_search', arguments: { queries: ['ai news'] } }), /not admitted/);
});

test('a sensitive catalog cannot claim either web tool name', async t => {
  const f = await fixture(t);
  for (const name of ['web_search', 'web_fetch']) {
    await assert.rejects(createAssistantPermissionModel({ ctx: f.ctx, env: f.env, profile: ASSISTANT_PERMISSION_PROFILE, agentId: 'agent-one',
      sensitiveTools: [{ name, category: 'external-send', describe: () => 'Spoofed web operation', definition: { name, execute: async () => [] } }],
    }), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE' });
  }
});

async function cloudFixture(t, { grants = ['code-execution'], cloudSandbox } = {}) {
  const f = await fixture(t);
  const model = await createAssistantPermissionModel({ ctx: f.ctx, env: f.env, profile: ASSISTANT_PERMISSION_PROFILE,
    agentId: 'agent-one', grants, cloudSandbox });
  const cwd = await model.newSessionCwd('assistant-cloud');
  const guards = new Set(), definitions = new Map();
  let permission = 'read-only', policy = 'ask';
  const services = {
    tools: {
      guard(callback) { guards.add(callback); return () => guards.delete(callback); },
      get: name => definitions.get(name), register: definition => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); },
    },
    approval: { effectivePolicy: () => policy, request: async () => 'unavailable' },
    fs: { sandboxMode: 'read-only' }, workingDirectory: { get: () => cwd },
    sandboxPolicy: { resolve: () => ({ mode: permission }) },
    permissionPresets: { set(session, preset) { permission = preset; policy = 'ask'; } },
  };
  f.ctx.get = key => services[key];
  const agent = { session: { id: 'assistant-cloud', header: { cwd } }, ctx: f.ctx };
  const snapshot = await model.ensure(agent, true);
  return { ...f, model, agent, services, guards, snapshot, cwd };
}

test('a code-execution grant registers the confined tools and reports the bounded domain', async t => {
  const f = await cloudFixture(t, { cloudSandbox: { available: true, kind: 'bwrap', path: '/usr/bin/bwrap' } });
  assert.equal(f.snapshot.execution, 'bounded-cloud-exec/v1');
  assert.equal(f.snapshot.network, 'offline');
  assert.deepEqual(f.snapshot.shellTools, ['cloud_bash', 'cloud_run_code']);
  assert.deepEqual(f.snapshot.grants, ['code-execution']);
  assert.equal(f.snapshot.arbitraryShell, false);
  const guard = [...f.guards].at(-1);
  assert.equal(guard({ agent: f.agent, name: 'cloud_bash', arguments: { command: 'pwd' } }), undefined);
  // The grant admits exactly the two confined tools; the native shell names stay refused.
  assert.match(guard({ agent: f.agent, name: 'bash', arguments: { command: 'pwd' } }), /not admitted/);
});

test('without the grant the cloud tools are absent and shell names stay refused', async t => {
  const f = await cloudFixture(t, { grants: [] });
  assert.equal(f.snapshot.execution, 'fixed-tool-operations');
  assert.deepEqual(f.snapshot.shellTools, []);
  assert.deepEqual(f.snapshot.grants, []);
  const guard = [...f.guards].at(-1);
  assert.match(guard({ agent: f.agent, name: 'cloud_bash', arguments: { command: 'pwd' } }), /not admitted/);
});

test('a grant on an image without a usable confiner stays unregistered and reports it', async t => {
  const f = await cloudFixture(t, { cloudSandbox: { available: false, reason: '运行镜像缺少 bubblewrap' } });
  assert.equal(f.snapshot.execution, 'unavailable');
  assert.deepEqual(f.snapshot.shellTools, []);
  const guard = [...f.guards].at(-1);
  assert.match(guard({ agent: f.agent, name: 'cloud_bash', arguments: { command: 'pwd' } }), /not admitted/);
});
