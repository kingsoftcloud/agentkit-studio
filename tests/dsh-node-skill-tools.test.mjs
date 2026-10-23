import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, renameSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip } from '../src/zip.mjs';
import { createNativeSkillConnection } from '../src/providers/native-skill-host.mjs';
import { createDshNodeSkillTools, DSH_NODE_SKILL_READ } from '../src/providers/dsh-node-skill-tools.mjs';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSkillReadTransport, nativeSkillReadToolDefinitions } from '../packages/agentkit-harness/src/native/skill-tools.mjs';

const body = '---\nname: alpha\ndescription: Alpha task\n---\n# Alpha 😀\nRead the JSON; never execute a script during loading.\n';
const script = 'printf forbidden > marker';
const archive = createZip([{ name: 'SKILL.md', data: body }, { name: 'scripts/run.sh', data: script }]);
const sha = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function setup(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-skill-read-'))), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  const requests = [], ports = [], controls = { onRequest: null, contentHash: sha(archive), incomplete: false, publicSpaceId: 'public-a' };
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (controls.onRequest) await controls.onRequest(req, res);
    if (res.destroyed || res.writableEnded) return;
    if (req.url === '/archive') { assert.equal(req.headers.authorization, undefined); res.end(archive); return; }
    assert.equal(req.headers.authorization, 'Bearer pinned-token');
    const url = new URL(req.url, origin), action = url.pathname.split('/').at(-1); let data;
    if (action === 'ListSkillSpaces') data = { SkillSpaces: [{ SkillSpaceId: 'space', SkillSpaceName: 'My space' }] };
    else if (action === 'ListAvailablePremadeSkills') data = { SkillSpaceId: controls.publicSpaceId, TotalCount: 1,
      Skills: [{ SkillId: 'alpha-id', VersionId: 'v1', Name: 'alpha', Description: 'Alpha task', Status: 'active', ContentHash: 'sha256:' + controls.contentHash }] };
    else if (action === 'ListSkillsBySpaceId') {
      assert.equal(url.searchParams.get('SpaceId'), 'space');
      data = { SkillSpaceId: 'space', TotalCount: controls.incomplete ? 2 : 1,
        Skills: [{ SkillId: 'alpha-id', VersionId: 'v1', Name: 'alpha', Description: 'Alpha task', Status: 'active',
          ContentHash: 'sha256:' + controls.contentHash }] };
    } else { assert.equal(action, 'GetSkillDownloadUrl'); data = { DownloadUrl: 'https://archive.example/alpha.zip?private-token=do-not-publish' }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Code: 0, Data: data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const proxy = (value, init) => {
    if (options.fetchGate) return options.fetchGate(value, init);
    const url = new URL(value);
    return fetch(url.hostname === 'archive.example' ? origin + '/archive' : value, init);
  };
  const env = { KSADK_SKILL_SERVICE_URL: origin + '/api/v1', KSADK_SKILL_SERVICE_TOKEN: 'pinned-token' };
  const connection = await createNativeSkillConnection({ configuration: { resolve: async () => ({ values: {} }) }, env, fetchImpl: proxy });
  env.KSADK_SKILL_SERVICE_URL = 'https://foreign.invalid'; env.KSADK_SKILL_SERVICE_TOKEN = 'changed';
  const config = { agentId: 'agent', workspaceRoot, stateDir: join(root, 'state'), connection, skillSpaceIds: ['space'], fetchImpl: proxy, ...options };
  const open = extra => { const port = createDshNodeSkillTools({ ...config, ...extra }); ports.push(port); return port; };
  const port = open(); let serial = 0;
  const exec = (name, args, sessionId = 'session') => ({ agent: { session: { id: sessionId } }, name, arguments: args,
    callId: 'call-' + ++serial, signal: new AbortController().signal });
  t.after(async () => { for (const port of ports) port.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  return { root, origin, workspaceRoot, config, open, port, exec, requests, controls,
    run: (name, args = {}, sessionId = 'session', target = port) => target.execute(name, args, exec(name, args, sessionId)) };
}

test('five formal DSH read tools use the real Node service and exact guarded ZIP loader without script execution', async t => {
  const h = await setup(t); assert.equal(h.port.contract, DSH_NODE_SKILL_READ);
  assert.deepEqual(h.port.definitions.map(tool => tool.name), nativeSkillReadToolDefinitions().map(tool => tool.name));
  assert.equal(h.port.supports('execute_skills'), false);
  assert.equal((await h.run('list_skill_spaces')).content.spaces[0].space_name, 'My space');
  assert.equal((await h.run('list_skills')).content.skills[0].name, 'alpha');
  assert.equal((await h.run('search_skills', { query: 'alpha' })).content.results[0].name, 'alpha');
  const preview = await h.run('preview_skill', { skill_name: 'alpha' });
  assert.equal(preview.content.execution_context, 'manifest_preview');
  assert.equal(h.requests.length, 4); assert.equal(h.requests.some(req => req.url === '/archive'), false);
  const loaded = await h.run('load_skill', { skill_name: 'alpha' });
  assert.equal(loaded.status, 'ok'); assert.equal(loaded.content.instructions, body);
  assert.equal(readFileSync(join(loaded.content.root_dir, 'scripts/run.sh'), 'utf8'), script);
  assert.equal(loaded.content.has_scripts_dir, true); assert.deepEqual(loaded.content.script_files, ['scripts/run.sh']);
  assert.equal(loaded.content.root_dir.startsWith(h.workspaceRoot), false);
  assert.equal(existsSync(join(h.workspaceRoot, 'marker')), false);
  assert.equal(h.requests.length, 7); assert.equal(h.requests.filter(req => req.url === '/archive').length, 1);
  assert.equal(JSON.stringify(loaded).includes('private-token'), false);
});

test('public schemas/binding copies cannot change private admission or redirect the configured service', async t => {
  const h = await setup(t), definition = h.port.definitions.find(tool => tool.name === 'load_skill');
  definition.parameters.required = []; definition.parameters.additionalProperties = true;
  h.port.binding.userSpaceIds.push('foreign');
  assert.equal((await h.run('load_skill', {})).status, 'error');
  assert.equal((await h.run('list_skills', { space_id: 'foreign' })).status, 'error');
  assert.equal((await h.run('list_skills', { service_url: 'https://foreign.invalid' })).status, 'error');
  assert.equal(h.requests.length, 0);
  assert.equal((await h.run('list_skills')).status, 'ok'); assert.equal(h.requests.length, 1);
});

test('public directory must match both configured authority and an explicitly selected Space before download', async t => {
  const h = await setup(t, { skillSpaceIds: [], env: { KSADK_PUBLIC_SKILL_SPACE_IDS: 'public-a,public-b', KSADK_PUBLIC_SKILL_ALLOWLIST: 'alpha' } });
  h.controls.publicSpaceId = 'foreign';
  assert.equal((await h.run('load_skill', { skill_name: 'alpha', space_id: 'public' })).content.error_type, 'SKILL_SPACE_NOT_BOUND');
  h.controls.publicSpaceId = 'public-b';
  assert.equal((await h.run('load_skill', { skill_name: 'alpha', space_id: 'public-a' })).content.error_type, 'SKILL_SPACE_NOT_BOUND');
  assert.equal(h.requests.length, 2); assert.equal(h.requests.some(req => req.url === '/archive'), false);
  const loaded = await h.run('load_skill', { skill_name: 'alpha', space_id: 'public-b' });
  assert.equal(loaded.status, 'ok'); assert.equal(loaded.content.space_id, 'public-b'); assert.equal(loaded.content.instructions, body);
});

test('every Agent/Session owns a distinct private cache and reopening keeps exact content without sharing authority', async t => {
  const h = await setup(t), first = await h.run('load_skill', { skill_name: 'alpha' });
  const second = await h.run('load_skill', { skill_name: 'alpha' }, 'other-session');
  const other = h.open({ agentId: 'other-agent' }), third = await h.run('load_skill', { skill_name: 'alpha' }, 'session', other);
  assert.equal(new Set([first, second, third].map(result => result.content.root_dir)).size, 3);
  h.port.close(); const reopened = h.open();
  const again = await h.run('load_skill', { skill_name: 'alpha' }, 'session', reopened);
  assert.equal(again.content.root_dir, first.content.root_dir); assert.equal(again.content.instructions, body);
  assert.equal(readFileSync(join(again.content.root_dir, 'SKILL.md'), 'utf8'), body);
});

test('a fresh Node process reopens the original DSH Skill cache with Python unavailable', async t => {
  const h = await setup(t), loaded = await h.run('load_skill', { skill_name: 'alpha' });
  h.port.close();
  const childCode = `
    import { createNativeSkillConnection } from ${JSON.stringify(new URL('../src/providers/native-skill-host.mjs', import.meta.url).href)};
    import { createDshNodeSkillTools } from ${JSON.stringify(new URL('../src/providers/dsh-node-skill-tools.mjs', import.meta.url).href)};
    const config = JSON.parse(process.argv[1]);
    const fetchImpl = (value, init) => fetch(new URL(value).hostname === 'archive.example' ? config.origin + '/archive' : value, init);
    const connection = await createNativeSkillConnection({ configuration: { resolve: async () => ({ values: {} }) },
      env: { KSADK_SKILL_SERVICE_URL: config.origin + '/api/v1', KSADK_SKILL_SERVICE_TOKEN: 'pinned-token' }, fetchImpl });
    const port = createDshNodeSkillTools({ ...config, connection, fetchImpl, skillSpaceIds: ['space'] });
    const args = { skill_name: 'alpha' }, result = await port.execute('load_skill', args, {
      agent: { session: { id: 'session' } }, name: 'load_skill', callId: 'fresh-process-read', arguments: args,
      signal: new AbortController().signal });
    port.close(); process.stdout.write(JSON.stringify({ pid: process.pid, result }));
  `;
  const config = { agentId: 'agent', stateDir: h.config.stateDir, workspaceRoot: h.workspaceRoot, origin: h.origin };
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', childCode, JSON.stringify(config)],
    { env: { ...process.env, PATH: '/unavailable', AGENTKIT_KSADK_PYTHON: '/unavailable/python' }, timeout: 10000 });
  const proof = JSON.parse(child.stdout); assert.notEqual(proof.pid, process.pid);
  assert.equal(proof.result.status, 'ok'); assert.equal(proof.result.content.root_dir, loaded.content.root_dir);
  assert.equal(proof.result.content.instructions, body);
  assert.equal(readFileSync(join(proof.result.content.root_dir, 'scripts/run.sh'), 'utf8'), script);
});

test('incomplete directories and hash mismatches are failures and never produce a loaded Skill', async t => {
  const h = await setup(t); h.controls.incomplete = true;
  assert.equal((await h.run('list_skills')).content.error_type, 'SKILL_LISTING_INCOMPLETE');
  assert.equal((await h.run('load_skill', { skill_name: 'alpha' })).status, 'error');
  assert.equal(h.requests.some(req => req.url === '/archive'), false);
  h.controls.incomplete = false; h.controls.contentHash = '0'.repeat(64);
  const mismatch = await h.run('load_skill', { skill_name: 'alpha' });
  assert.equal(mismatch.status, 'error'); assert.match(mismatch.content.error_type, /HASH/);
});

test('closed, aborted, missing and asynchronous lifetime authorities perform no service request', async t => {
  for (const verdict of [true, 'false', undefined, Promise.reject(Error('observed'))]) {
    const h = await setup(t, { isClosed: () => verdict });
    assert.equal((await h.run('list_skills')).status, 'error'); assert.equal(h.requests.length, 0);
  }
  const h = await setup(t), exec = h.exec('list_skills', {}), controller = new AbortController();
  exec.signal = controller.signal; controller.abort();
  assert.equal((await h.port.execute(exec.name, {}, exec)).content.error_type, 'dsh_node_skill_canceled');
  h.port.close(); assert.equal((await h.run('list_skills')).content.error_type, 'dsh_node_skill_closed');
  assert.equal(h.requests.length, 0);
});

test('request identity drift inside the lifetime callback is rejected before cache or network effects', async t => {
  for (const mutate of [exec => { exec.agent.session = { id: 'session' }; }, exec => { exec.callId = 'changed'; },
    exec => { exec.name = 'load_skill'; }, exec => { exec.signal = new AbortController().signal; }, exec => { exec.arguments = { space_id: 'foreign' }; }]) {
    let exec; const h = await setup(t, { isClosed: () => { mutate(exec); return false; } });
    exec = h.exec('list_skills', {});
    assert.equal((await h.port.execute(exec.name, {}, exec)).content.error_type, 'dsh_node_skill_request_drifted');
    assert.equal(h.requests.length, 0); assert.equal(existsSync(join(h.config.stateDir, 'skills')), false);
  }
});

test('drift after a real directory response cannot reach download URL or archive publication', async t => {
  const h = await setup(t), args = { skill_name: 'alpha' }, exec = h.exec('load_skill', args);
  h.controls.onRequest = () => { exec.callId = 'foreign'; };
  const result = await h.port.execute(exec.name, args, exec);
  assert.equal(result.content.error_type, 'dsh_node_skill_request_drifted'); assert.equal(h.requests.length, 1);
});

test('cancel and Host retirement settle a non-cooperative service and observe its late rejection', async t => {
  for (const mode of ['caller', 'host', 'close']) {
    const gate = deferred(), entered = deferred(), owner = new AbortController();
    const h = await setup(t, { signal: owner.signal, fetchGate: () => { entered.resolve(); return gate.promise; } });
    const exec = h.exec('load_skill', { skill_name: 'alpha' }), controller = new AbortController(); exec.signal = controller.signal;
    const pending = h.port.execute(exec.name, exec.arguments, exec); await entered.promise;
    if (mode === 'caller') controller.abort(); if (mode === 'host') owner.abort(); if (mode === 'close') h.port.close();
    const result = await pending; assert.equal(result.status, 'error');
    assert.equal(result.content.error_type, mode === 'caller' ? 'dsh_node_skill_canceled' : 'dsh_node_skill_closed');
    gate.reject(Error('late failure')); await new Promise(resolve => setImmediate(resolve));
  }
});

test('a replaced cache directory is rejected before any later service access', async t => {
  const h = await setup(t); assert.equal((await h.run('list_skills')).status, 'ok');
  const cache = join(h.config.stateDir, 'skills', sha(canonical({ contract: DSH_NODE_SKILL_READ, agentId: 'agent', sessionId: 'session' })));
  renameSync(cache, cache + '-original'); symlinkSync(cache + '-original', cache, 'dir');
  const result = await h.run('load_skill', { skill_name: 'alpha' }); assert.equal(result.status, 'error');
  assert.equal(h.requests.length, 1);
});

test('neutral transport requires strict original authority and has no workflow/Native identity escape', async () => {
  let calls = 0;
  const transport = createSkillReadTransport({ serviceClient: { listSkillsBySpaceId: async () => { calls++; return { activeSkills: [] }; } }, skillSpaceIds: ['space'] });
  const make = () => ({ agentId: 'real-agent', sessionId: 'real-session', call: { callId: 'real-call', name: 'list_skills', arguments: {} },
    signal: new AbortController().signal, assertCurrent: () => true });
  for (const verdict of [false, 'true', Promise.reject(Error('observed'))]) {
    const request = make(); request.assertCurrent = () => verdict;
    assert.equal((await transport.execute(request)).ok, false);
  }
  const request = make(); request.assertCurrent = () => { request.signal = new AbortController().signal; return true; };
  assert.equal((await transport.execute(request)).ok, false); assert.equal(calls, 0);
  const workflow = make(); workflow.call.name = 'execute_skills';
  assert.equal((await transport.execute(workflow)).error_type, 'skill_read_tool_unbound');
  assert.equal((await transport.execute(make())).ok, true); assert.equal(calls, 1);
});
