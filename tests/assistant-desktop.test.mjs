import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantDesktop, ASSISTANT_DESKTOP_SERVICE, assistantDesktopService } from '../src/assistant-desktop.mjs';

const GATEWAY = 'https://pa-desktop-dev.agent-pre.kspmas.ksyun.com';
const AGENT = 'ar-20261026143422-edd563a1';
const KEY = `ak-${'0123456789abcdef'.repeat(2)}`;
const future = () => Math.floor(Date.now() / 1000) + 45;

function ticketFetch({ status = 200, expiresAt = future(), agent = AGENT, bot = '__directory__', wsPath = 'personal-assistant/desktop/ws' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = JSON.parse(init.body);
    const code = body.AgentId === agent && status === 200;
    return {
      ok: status === 200 && code, status: code ? 200 : (status === 200 ? 401 : status),
      json: async () => (code ? { Code: 0, Data: { Ticket: 't'.repeat(43), ExpiresAt: expiresAt,
        AgentId: body.AgentId, BotId: body.BotId, WsPath: wsPath, Protocol: 'agentkit.personal-assistant.desktop.v1', LeaseId: null } }
        : { Code: 401, Message: 'Invalid API Key' }),
    };
  };
  return { fetchImpl, calls };
}

const agents = [{ AgentId: AGENT, Name: '我的个人助理', Framework: 'personal-assistant', Status: 'RUNNING', Endpoint: `https://${AGENT}.agent-pre.kspmas.ksyun.com`, CreatedAt: '2026-10-26T06:34:22Z' }];

function harness({ clientOverrides = {}, fetchOptions = {}, store } = {}) {
  const dir = store || null;
  const { fetchImpl, calls } = ticketFetch(fetchOptions);
  const client = { action: async (name) => {
    if (name === 'ListAgents') return { data: { Agents: agents } };
    if (name === 'CreateAgentApiKey') {
      if (clientOverrides.failKey) throw Object.assign(new Error('platform'), { status: 500 });
      return { data: { ApiKey: KEY } };
    }
    throw new Error(`unexpected action ${name}`);
  } };
  return { calls, client, options: { fetchImpl, getClient: async () => client, configuration: { resolve: async () => ({ values: { cloudRegion: 'pre-online' } }) }, ...(dir ? { storeDir: dir } : {}) } };
}

test('the Studio proxy discovers the account assistant and binds it without any plugin config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options } = harness({ store: dir });
  const service = createAssistantDesktop(options);
  assert.deepEqual(await service.configuration({}), { configured: true, agentId: AGENT });
  const saved = JSON.parse(await readFile(join(dir, 'assistant-binding.json'), 'utf8'));
  assert.equal(saved.format, 'agentkit.studio-assistant-binding/v1');
  assert.equal(saved.agentId, AGENT);
  assert.equal(saved.apiKey, KEY);
  assert.equal((await stat(join(dir, 'assistant-binding.json'))).mode & 0o777, 0o600);
});

test('the plugin call convention status(input, signal) stays a readable snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options } = harness({ store: dir });
  const service = createAssistantDesktop(options);
  // The standalone plugin calls every binding method as (input, signal); status
  // must tolerate the positional input object instead of treating it as an
  // AbortSignal and degrading to ASSISTANT_GATEWAY_UNREACHABLE.
  const status = await service.status({}, AbortSignal.timeout(5_000));
  assert.equal(status.configured, true);
  assert.equal(status.agentId, AGENT);
  assert.equal(status.reason, '');
  assert.equal(status.candidates.length, 1);
});

test('issueTicket returns the normalized public authorization only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options, calls } = harness({ store: dir });
  const service = createAssistantDesktop(options);
  const ticket = await service.issueTicket({ agentId: AGENT, botId: '__directory__', mode: 'read' });
  assert.equal(ticket.agentId, AGENT);
  assert.equal(ticket.botId, '__directory__');
  assert.equal(ticket.protocol, 'agentkit.personal-assistant.desktop.v1');
  assert.equal(ticket.readOnly, true);
  assert.equal(ticket.wsUrl, 'wss://pa-desktop-dev.agent-pre.kspmas.ksyun.com/personal-assistant/desktop/ws');
  assert.ok(Math.abs(Date.parse(ticket.expiresAt) - (future() * 1000)) < 120_000);
  assert.equal(ticket.leaseId, null);
  assert.equal(calls.at(-1).init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(JSON.stringify(ticket).includes(KEY), false);
});

test('a stale key is re-acquired from the platform instead of asking the user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  await writeFile(join(dir, 'assistant-binding.json'), JSON.stringify({ format: 'agentkit.studio-assistant-binding/v1',
    gatewayUrl: GATEWAY, agentId: AGENT, apiKey: `ak-${'deadbeef'.repeat(4)}`, updatedAt: new Date().toISOString() }));
  const { options } = harness({ store: dir, fetchOptions: { status: 401 } });
  // First ticket probe is refused; the fake fetch also refuses the freshly
  // minted key, so the service reports the environment gap without losing the
  // page state.
  const service = createAssistantDesktop(options);
  const status = await service.status();
  assert.equal(status.configured, false);
  assert.equal(status.reason, 'credential-unavailable');
  assert.equal(status.candidates.length, 1);
});

test('closing the assistant needs the instance id echoed back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options } = harness({ store: dir });
  const calls = [];
  options.getDeploymentClient = async () => ({ forAgent: id => ({ remove: async () => { calls.push(id); return { Data: { deleted: true } }; } }) });
  const service = createAssistantDesktop(options);
  await service.configuration({});
  await assert.rejects(service.destroy({}), error => error.code === 'ASSISTANT_DELETE_CONFIRMATION_REQUIRED' && error.status === 409);
  await assert.rejects(service.destroy({ confirmAgentId: 'ar-00000000000000-00000000' }),
    error => error.code === 'ASSISTANT_DELETE_CONFIRMATION_REQUIRED' && error.status === 409);
  assert.deepEqual(calls, []);
});

test('closing the assistant removes the cloud runtime and drops the binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options } = harness({ store: dir });
  const calls = [];
  options.getDeploymentClient = async () => ({ forAgent: id => ({ remove: async () => { calls.push(id); return { Data: { deleted: true } }; } }) });
  const service = createAssistantDesktop(options);
  assert.equal((await service.configuration({})).configured, true);
  const closed = await service.destroy({ confirmAgentId: AGENT });
  assert.deepEqual(closed, { configured: false, agentId: AGENT, closed: true });
  assert.deepEqual(calls, [AGENT]);
  await assert.rejects(readFile(join(dir, 'assistant-binding.json'), 'utf8'), error => error.code === 'ENOENT');
});

test('closing without a binding is refused instead of deleting anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options } = harness({ store: dir });
  let touched = false;
  options.getDeploymentClient = async () => ({ forAgent: () => ({ remove: async () => { touched = true; } }) });
  const service = createAssistantDesktop(options);
  await assert.rejects(service.destroy({ confirmAgentId: AGENT }), error => error.code === 'ASSISTANT_NOT_CREATED' && error.status === 409);
  assert.equal(touched, false);
});

test('no cloud assistant yet reports the create state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options } = harness({ store: dir });
  options.getClient = async () => ({ action: async () => ({ data: { Agents: [] } }) });
  const service = createAssistantDesktop(options);
  const status = await service.status();
  assert.deepEqual(status, { configured: false, agentId: undefined, gatewayUrl: undefined, reason: 'needs-create', candidates: [] });
});

test('a mismatched agent is refused without binding it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options, calls } = harness({ store: dir });
  const service = createAssistantDesktop(options);
  await assert.rejects(() => service.issueTicket({ agentId: 'ar-20260101000000-aaaaaaaa', botId: '__directory__', mode: 'read' }),
    error => error.status === 403);
  // Auto-binding may probe the bound instance, but must never sign a ticket
  // for the caller-supplied agent.
  assert.ok(calls.every(call => JSON.parse(call.init.body).AgentId === AGENT));
});

test('an invalid ticket window is rejected as a gateway contract violation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options } = harness({ store: dir, fetchOptions: { expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
  const service = createAssistantDesktop(options);
  await assert.rejects(() => service.issueTicket({ agentId: AGENT, botId: '__directory__', mode: 'read' }),
    error => error.status === 502 && error.code === 'ASSISTANT_TICKET_INVALID');
});

test('a corrupt binding fails closed instead of silently re-binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  await writeFile(join(dir, 'assistant-binding.json'), '{not json');
  const { options } = harness({ store: dir });
  const service = createAssistantDesktop(options);
  await assert.rejects(() => service.issueTicket({ agentId: AGENT, botId: '__directory__', mode: 'read' }),
    error => error.code === 'ASSISTANT_BINDING_CORRUPT');
});

test('creating an assistant waits for the instance and binds its credential', async () => {
  const NEW_AGENT = 'ar-20261028090000-bbbbbbbb';
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { options } = harness({ store: dir, fetchOptions: { agent: NEW_AGENT } });
  let created = false;
  options.getClient = async () => ({ action: async name => {
    if (name === 'CreateAgent') { created = true; return { data: { AgentId: NEW_AGENT } }; }
    if (name === 'ListAgents') return { data: { Agents: created ? [{ AgentId: NEW_AGENT, Name: 'personal-assistant-x',
      Framework: 'personal-assistant', Status: 'RUNNING', CreatedAt: '2026-10-28T01:00:00Z' }] : [] } };
    if (name === 'CreateAgentApiKey') return { data: { ApiKey: KEY } };
    throw new Error(name);
  } });
  const service = createAssistantDesktop(options);
  const result = await service.create({}, undefined);
  assert.deepEqual(result, { configured: true, agentId: NEW_AGENT });
  const saved = JSON.parse(await readFile(join(dir, 'assistant-binding.json'), 'utf8'));
  assert.equal(saved.agentId, NEW_AGENT);
});

test('the provided service keeps only the documented surface', () => {
  const service = assistantDesktopService(createAssistantDesktop({ storeDir: '/tmp/unused', configuration: { resolve: async () => ({ values: {} }) } }));
  assert.equal(service.format, ASSISTANT_DESKTOP_SERVICE);
  assert.deepEqual(Object.keys(service).sort(), ['configuration', 'connect', 'create', 'destroy', 'disconnect', 'format', 'issueTicket', 'settings', 'settingsUpdate', 'settingsVersions', 'status']);
});

function settingsHarness({ store, manifest = null, detail, failDetail = null, failUpdate = null, catalog = null } = {}) {
  const binding = { format: 'agentkit.studio-assistant-binding/v1', gatewayUrl: GATEWAY, agentId: AGENT, apiKey: KEY,
    label: '我的个人助理', updatedAt: new Date().toISOString(), ...(manifest ? { manifest } : {}) };
  const updates = [];
  const options = {
    storeDir: store,
    fetchImpl: async () => { throw new Error('settings must not open the desktop gateway'); },
    configuration: { resolve: async () => ({ values: { cloudRegion: 'pre-online' } }) },
    getDeploymentClient: async () => ({
      forAgent: id => ({
        get: async () => { if (failDetail) throw failDetail; return { Data: detail ?? {
          Basic: { Name: 'pa-cloud-session-x', Status: 'RUNNING', UpdatedAt: '2026-10-27T07:58:47Z' },
          Deployment: { DeploymentType: 'ManagedRuntime', RuntimeConfig: { Name: 'personal-assistant', Version: '0.1.37', ImageDigest: 'hub/x@sha256:abc' } },
          Advanced: { EnvironmentVariables: [
            { Key: 'OPENAI_BASE_URL', Value: 'https://kspmas.ksyun.com/v1', IsSensitive: false },
            { Key: 'OPENAI_API_KEY', Value: 'sk-secret', IsSensitive: true },
          ] },
        } }; },
        update: async payload => { if (failUpdate) throw failUpdate; updates.push({ id, payload }); return { Data: { accepted: true } }; },
      }),
      getBootstrapConfig: async () => ({ data: { Configs: catalog ? { 'runtime.catalog': catalog } : {} } }),
    }),
  };
  return { binding, updates, options };
}

const RECORDED_MANIFEST = 'name: pa-cloud-session-x\nframework: personal-assistant\nartifact_type: ManagedRuntime\nmodel: deepseek-v4.1-flash-1017\nprompt: 请用中文完成用户任务。\nruntime:\n  name: personal-assistant\n  version: 0.1.37\n';

test('settings reads the platform instance and never returns a stored secret value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { binding, options } = settingsHarness({ store: dir, manifest: RECORDED_MANIFEST });
  await writeFile(join(dir, 'assistant-binding.json'), JSON.stringify(binding));
  const service = createAssistantDesktop(options);
  const snapshot = await service.settings({});
  assert.equal(snapshot.agentId, AGENT);
  assert.equal(snapshot.name, 'pa-cloud-session-x');
  assert.equal(snapshot.runtime.version, '0.1.37');
  assert.equal(snapshot.model, 'deepseek-v4.1-flash-1017');
  assert.equal(snapshot.recordSource, 'studio');
  const secret = snapshot.environmentVariables.find(row => row.key === 'OPENAI_API_KEY');
  assert.equal(secret.sensitive, true);
  assert.equal(secret.value, '');
  assert.equal(snapshot.environmentVariables.find(row => row.key === 'OPENAI_BASE_URL').value, 'https://kspmas.ksyun.com/v1');
});

test('settings reports a legacy instance without a recorded manifest instead of guessing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { binding, options } = settingsHarness({ store: dir });
  await writeFile(join(dir, 'assistant-binding.json'), JSON.stringify(binding));
  const service = createAssistantDesktop(options);
  const snapshot = await service.settings({});
  assert.equal(snapshot.recordSource, 'missing');
  assert.equal(snapshot.model, '');
});

test('settings update submits one managed-runtime declaration with the edited model, prompt and environment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { binding, updates, options } = settingsHarness({ store: dir, manifest: RECORDED_MANIFEST });
  await writeFile(join(dir, 'assistant-binding.json'), JSON.stringify(binding));
  const service = createAssistantDesktop(options);
  const result = await service.settingsUpdate({ model: 'deepseek-v4.1-flash-1017', prompt: '请简洁回答', runtimeVersion: '0.1.37',
    environmentVariables: [{ key: 'AGENTKIT_FEATURE_FLAG', value: '1', sensitive: false }], deleteKeys: ['OLD_FLAG'] });
  assert.equal(result.saved, true);
  assert.equal(result.status, 'updating');
  assert.equal(updates.length, 1);
  const payload = updates[0].payload;
  assert.equal(payload.AgentId, AGENT);
  assert.equal(payload.ManagedRuntimeConfig.RuntimeName, 'personal-assistant');
  assert.equal(payload.ManagedRuntimeConfig.RuntimeVersion, '0.1.37');
  assert.match(payload.ManagedRuntimeConfig.Manifest, /name: pa-cloud-session-x/);
  assert.match(payload.ManagedRuntimeConfig.Manifest, /prompt: 请简洁回答/);
  assert.deepEqual(payload.EnvironmentVariablePatch, { Upsert: [{ Key: 'AGENTKIT_FEATURE_FLAG', Value: '1' }], Delete: ['OLD_FLAG'] });
  const saved = JSON.parse(await readFile(join(dir, 'assistant-binding.json'), 'utf8'));
  assert.match(saved.manifest, /prompt: 请简洁回答/);
});

test('settings update explains the preprod platform gap instead of surfacing a raw 400', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { binding, options } = settingsHarness({ store: dir, manifest: RECORDED_MANIFEST,
    failUpdate: Object.assign(new Error('ManagedRuntime requires Framework=codex/harness/dsh-native and a matching RuntimeName'), { status: 400 }) });
  await writeFile(join(dir, 'assistant-binding.json'), JSON.stringify(binding));
  const service = createAssistantDesktop(options);
  await assert.rejects(() => service.settingsUpdate({ model: 'deepseek-v4.1-flash-1017' }),
    error => error.code === 'ASSISTANT_SETTINGS_UNSUPPORTED' && error.status === 409);
});

test('settings update refuses a legacy binding without the recorded declaration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { binding, options } = settingsHarness({ store: dir });
  await writeFile(join(dir, 'assistant-binding.json'), JSON.stringify(binding));
  const service = createAssistantDesktop(options);
  await assert.rejects(() => service.settingsUpdate({ runtimeVersion: '0.1.37', model: 'deepseek-v4.1-flash-1017' }),
    error => error.code === 'ASSISTANT_SETTINGS_MANIFEST_MISSING' && error.status === 409);
});

test('settings versions reads the published personal-assistant catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const catalog = { 'personal-assistant': { versions: {
    '0.1.37': { image: 'hub/x@sha256:aaa', capabilities: ['personal-assistant/v1'] },
    '0.1.40': { image: 'hub/x@sha256:bbb', capabilities: ['personal-assistant/v1'] },
  } } };
  const { binding, options } = settingsHarness({ store: dir, manifest: RECORDED_MANIFEST, catalog });
  await writeFile(join(dir, 'assistant-binding.json'), JSON.stringify(binding));
  const service = createAssistantDesktop(options);
  const result = await service.settingsVersions({});
  assert.equal(result.currentVersion, '0.1.37');
  assert.deepEqual(result.versions.map(row => row.version), ['0.1.37', '0.1.40']);
  assert.equal(result.catalogAvailable, true);
});

test('settings degrades to the recorded declaration when the platform detail call fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-desktop-'));
  const { binding, options } = settingsHarness({ store: dir, manifest: RECORDED_MANIFEST,
    failDetail: Object.assign(new Error("KeyError: 'health_check'"), { status: 500 }) });
  await writeFile(join(dir, 'assistant-binding.json'), JSON.stringify(binding));
  const service = createAssistantDesktop(options);
  const snapshot = await service.settings({});
  assert.equal(snapshot.detailAvailable, false);
  assert.equal(snapshot.recordSource, 'studio');
  assert.equal(snapshot.model, 'deepseek-v4.1-flash-1017');
  assert.equal(snapshot.runtime.version, '0.1.37');
  assert.match(snapshot.detailNote, /云端平台暂时没有返回实例详情/u);
});
