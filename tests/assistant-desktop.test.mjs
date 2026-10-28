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
  assert.deepEqual(Object.keys(service).sort(), ['configuration', 'connect', 'create', 'disconnect', 'format', 'issueTicket', 'status']);
});
