import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshNodeComponentTools } from '../src/providers/dsh-node-component-tools.mjs';
import { createDshNodeBuiltins } from '../src/providers/dsh-node-builtins.mjs';
import { dshComponentBindings, readDshComponentBindings } from '../src/providers/dsh-component-bindings.mjs';

function execution(args = {}) {
  return { callId: 'status-call', name: 'component_status', arguments: args,
    agent: { session: { id: 'real-session' }, options: { model: 'selected-model' } }, signal: new AbortController().signal };
}
const status = () => ({ summary: { model: 'initial', knowledge_base_bound: true }, workspace: { root: '/workspace', tools: ['read_workspace_file'] } });

test('public component snapshot shares Native validation and follows the actual selected DSH model', async () => {
  const input = status(), port = createDshNodeComponentTools({ agentId: 'agent', status: input });
  input.summary.knowledge_base_bound = false; input.workspace.tools.push('forged');
  const exec = execution();
  const first = await port.execute(exec.name, {}, exec);
  assert.equal(first.status, 'ok'); assert.equal(first.content.summary.model, 'selected-model');
  assert.equal(first.content.summary.knowledge_base_bound, true);
  assert.deepEqual(first.content.workspace.tools, ['read_workspace_file']);
  first.content.workspace.tools.push('mutated');
  const definition = port.definitions[0]; definition.parameters.additionalProperties = true;
  exec.agent.options.model = 'next-model';
  const second = await port.execute(exec.name, {}, exec);
  assert.equal(second.content.summary.model, 'next-model');
  assert.deepEqual(second.content.workspace.tools, ['read_workspace_file']);
  assert.equal(port.definitions[0].parameters.additionalProperties, false);
  port.close(); assert.equal((await port.execute(exec.name, {}, exec)).content.error_type, 'dsh_node_component_closed');
});

test('rejects unknown fields, secrets and bounded-output overflow using the shared snapshot contract', () => {
  for (const value of [{ secret: 'credential' }, { summary: { apiKey: 'credential' } }, { skill_runtime: { isolated: true } },
    { workspace: { tools: Array.from({ length: 4096 }, () => 'x'.repeat(100)) } }]) {
    assert.throws(() => createDshNodeComponentTools({ agentId: 'agent', status: value }), /component_status_/);
  }
});

test('the actual recorded request model takes precedence over construction options and detects header drift', async () => {
  const exec = execution(), header = { config: { model: 'actual-request-model' } };
  exec.agent.session.requestHeader = () => header;
  const port = createDshNodeComponentTools({ agentId: 'agent', status: status() });
  assert.equal((await port.execute('component_status', {}, exec)).content.summary.model, 'actual-request-model');
  const drifting = createDshNodeComponentTools({ agentId: 'agent', status: status(),
    isClosed: () => { header.config.model = 'later-request'; return false; } });
  assert.equal((await drifting.execute('component_status', {}, exec)).content.error_type, 'dsh_node_component_request_drifted');
});

test('rejects missing DSH identities, forged inputs, replaced signals and original cancellation', async () => {
  const port = createDshNodeComponentTools({ agentId: 'agent', status: status() });
  const forged = await port.execute('component_status', { service_url: 'https://model-chosen.invalid' }, execution());
  assert.equal(forged.status, 'error');
  for (const mutate of [exec => { exec.callId = ''; }, exec => { exec.signal = {}; },
    exec => { exec.name = 'another'; }, exec => { exec.agent.session.id = ''; },
    exec => { exec.arguments = { forged: true }; }, exec => { delete exec.agent; }]) {
    const exec = execution(); mutate(exec);
    assert.equal((await port.execute('component_status', {}, exec)).status, 'error');
  }
  const controller = new AbortController(), exec = execution(); exec.signal = controller.signal; controller.abort();
  assert.equal((await port.execute(exec.name, {}, exec)).content.error_type, 'dsh_node_component_canceled');
});

test('strict lifetime hooks cannot authorize via async/truthy values or mutate the original Session/call/model', async () => {
  for (const verdict of [true, 'false', null, undefined, Promise.reject(Error('observed'))]) {
    const port = createDshNodeComponentTools({ agentId: 'agent', status: status(), isClosed: () => verdict });
    assert.equal((await port.execute('component_status', {}, execution())).status, 'error');
  }
  for (const mutate of [exec => { exec.agent = { ...exec.agent }; }, exec => { exec.agent.session = { id: 'real-session' }; },
    exec => { exec.callId = 'other'; }, exec => { exec.signal = new AbortController().signal; },
    exec => { exec.agent.options.model = 'changed'; }, exec => { exec.agent.options = { model: 'selected-model' }; },
    exec => { exec.arguments = { injected: true }; }]) {
    const exec = execution();
    const port = createDshNodeComponentTools({ agentId: 'agent', status: status(), isClosed: () => { mutate(exec); return false; } });
    assert.equal((await port.execute('component_status', {}, exec)).content.error_type, 'dsh_node_component_request_drifted');
  }
});

test('Host lifetime abort wins even when the synchronous lifetime callback returns false', async () => {
  const controller = new AbortController();
  const port = createDshNodeComponentTools({ agentId: 'agent', status: status(), signal: controller.signal,
    isClosed: () => { controller.abort(); return false; } });
  assert.equal((await port.execute('component_status', {}, execution())).content.error_type, 'dsh_node_component_closed');
});

test('resource facts are versioned, independent of secrets, and honor disabled bindings and memory policy', () => {
  const plugin = (kind, id, enabled = true) => ({ enabled, config: { binding: { resource: { kind, id, apiKey: 'never-copy' } } } });
  const spec = { bindings: { plugins: [plugin('knowledge-base', 'kb'), plugin('memory-instance', 'mem'),
    plugin('skill-space', 'z'), plugin('skill-space', 'z'), plugin('skill-space', 'a'), plugin('skill-space', 'hidden', false)] } };
  const facts = dshComponentBindings(spec);
  assert.equal(facts.knowledgeBaseBound, true); assert.equal(facts.longTermMemoryBound, true);
  assert.deepEqual(facts.skillSpaceIds, ['a', 'z']); assert.equal(JSON.stringify(facts).includes('never-copy'), false);
  const pinned = readDshComponentBindings(facts); facts.skillSpaceIds.push('later');
  assert.deepEqual(pinned.skillSpaceIds, ['a', 'z']);
  assert.equal(dshComponentBindings({ ...spec, memory: { enabled: false } }).longTermMemoryBound, false);
  assert.throws(() => readDshComponentBindings({ ...facts, serviceUrl: 'secret' }), /dsh_component_bindings_invalid/);
  assert.throws(() => readDshComponentBindings({ ...facts, contract: 'other' }), /dsh_component_bindings_invalid/);
});

test('composition reports admitted E2B Skill readiness separately from unmounted E2B command tools', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-components-')), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { ctx: {}, workspaceRoot, stateDir: join(root, 'state'), agentId: 'agent',
    toolBindings: ['component_status', 'read_workspace_file', 'run_command', 'execute_skills'],
    componentBindings: dshComponentBindings({ bindings: { plugins: [{ config: { binding: { resource: { kind: 'skill-space', id: 'space' } } } }] } }) };
  for (const backend of ['local_process', 'e2b']) {
    const port = createDshNodeBuiltins({ ...config, env: { KSADK_SANDBOX_BACKEND: backend,
      KSADK_SKILL_RUNTIME_BACKEND: 'e2b', E2B_API_KEY: 'never-copy', KSADK_SANDBOX_TEMPLATE_ID: 'explicit-template',
      E2B_API_URL: 'https://fixture.invalid', E2B_DOMAIN: 'fixture.invalid' },
      skillConnection: { client: { skillAction: () => assert.fail('status cannot call a service') }, bindingDigest: 'b'.repeat(64) } });
    t.after(() => port.close());
    const result = await port.execute('component_status', {}, execution());
    assert.equal(result.status, 'ok'); assert.deepEqual(result.content.workspace.tools, ['read_workspace_file']);
    assert.equal(result.content.summary.model, 'selected-model'); assert.equal(result.content.summary.skill_space_bound, true);
    assert.deepEqual(result.content.skill_space.space_ids, ['space']); assert.deepEqual(result.content.skill_space.tools, ['execute_skills']);
    assert.equal(result.content.skill_runtime.enabled, true); assert.equal(result.content.skill_runtime.backend, 'e2b');
    assert.equal(result.content.skill_runtime.template_bound, true); assert.equal(result.content.summary.isolated_execution, 'enabled');
    assert.equal(result.content.sandbox.enabled, backend === 'local_process');
    assert.deepEqual(result.content.sandbox.tools, backend === 'local_process' ? ['run_command'] : []);
    assert.equal(JSON.stringify(result).includes('never-copy'), false);
  }
});
