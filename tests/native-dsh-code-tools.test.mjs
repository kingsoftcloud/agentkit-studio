/** Production Native gateway/kernel/SQLite, explicit DSH registry + E2B SDK
 * peer doubles; snippets are real Bash/Node processes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { scope, fixture, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { studioNativeComponentStatus } from '../src/providers/native-component-status.mjs';
import { skillE2BSdk } from './fixtures/native-skill-e2b-sdk.mjs';

function setup(t, { backend = 'e2b', deny = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-node-code-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot); const store = new SqliteRunStore(join(root, 'ledger.sqlite'));
  const registry = new Map(), agent = { session: { id: 'session' } }; let currentRun, loads = 0, admissions = 0;
  const peer = skillE2BSdk(t, { root: join(root, 'peer'), commandPath: `${dirname(process.execPath)}:/usr/bin:/bin`, signalExitCodes: true,
    before(method) { if (method === 'create' || method === 'write' || method === 'run') {
      const saved = store.load(scope, currentRun), intent = saved.intents.find(row => row.operationKey === saved.snapshot.pendingIntent);
      assert.equal(saved.snapshot.phase, 'executing_tools'); assert.equal(intent.status, 'running');
      assert.equal(saved.lease.fence, intent.claimedFence); assert.equal(intent.payload.calls[0].name, 'run_code');
    } } });
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: {
    register(definition) { assert.notEqual(definition.name, 'run_code', 'DSH reserves the PTC transport name');
      registry.set(definition.name, definition); return () => registry.delete(definition.name); },
    async execute(exec) { admissions++; if (deny) return { isError: true, content: [{ type: 'text', text: 'registry denied' }] };
      const definition = registry.get(exec.name), value = await definition.execute(exec.arguments, exec);
      return { isError: false, value, content: definition.output.render(exec.arguments, value) }; },
  } };
  const env = { KSADK_SANDBOX_BACKEND: backend, KSADK_SANDBOX_TIMEOUT: '15', KSADK_SANDBOX_TEMPLATE_ID: 'fixed',
    E2B_API_URL: 'https://fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'never-persist-key' };
  const gateway = createNativeDshTools({ ctx, config: { agentId: scope.agentId, toolBindings: ['run_code'] }, workspaceRoot, stateDir,
    commandEnvironment: env, e2bLoadSdk: async () => { loads++; return peer.sdk; } });
  async function run(args, runId = 'run') {
    currentRun = runId; const tools = gateway.definitions(agent, [...registry.values()]);
    const { config, snapshot } = fixture({ tools, limits: { effectTimeoutMs: Math.max(120000, ...tools.map(tool => tool.timeoutMs + 10000)) } }); let step = 0, observed;
    const kernel = new NativeKernel({ store, digest, owner: 'host', ports: { ...gateway.forAgent(agent, { scope, store }), model: {
      async generate(request) { if (!step++) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
        toolCalls: [{ callId: 'original-code-call', name: 'run_code', arguments: args }] };
        if (!deny) observed = JSON.parse(request.messages.filter(row => row.role === 'tool').at(-1).content);
        return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] }; },
    } } });
    kernel.start({ ...snapshot, runId, turnId: runId }, config); const done = await kernel.runUntilIdle(scope, runId);
    assert.equal(done.phase, 'completed'); return observed;
  }
  t.after(async () => { await gateway.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, workspaceRoot, stateDir, store, gateway, peer, run, registry, get loads() { return loads; }, get admissions() { return admissions; } };
}

test('run_code enters the original Native ledger/registry and preserves real remote source and output', async t => {
  const h = setup(t), args = { code: 'printf x > effect; printf "原始😀"', language: 'sh' };
  assert.equal(h.gateway.commandBinding, null); assert.equal(h.gateway.codeBinding.backend, 'e2b'); assert.equal(h.loads, 0);
  assert.equal(h.gateway.codeBinding.registryName, 'sandbox_run_code'); assert.equal(h.registry.has('sandbox_run_code'), true);
  assert.equal(h.registry.has('run_code'), false);
  const result = await h.run(args); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.stdout, '原始😀');
  assert.equal(result.execution_model, 'snippet_runner'); assert.equal(result.language, 'bash');
  assert.equal(readFileSync(join(h.root, 'peer/skill-peer-1', result.path.slice(1)), 'utf8'), args.code); assert.equal(existsSync(result.path), false);
  const record = h.store.load(scope, 'run'), intent = record.intents.find(row => row.kind === 'tool');
  assert.ok(intent); const receipt = record.receipts.find(row => row.operationKey === intent.operationKey); assert.ok(receipt);
  assert.equal(receipt.status, 'committed'); assert.equal(record.intents.find(row => row.operationKey === receipt.operationKey).payload.calls[0].name, 'run_code');
  const files = readdirSync(h.stateDir, { recursive: true }).filter(path => path.endsWith('/record.json') && path.includes('/background/commands/'));
  assert.equal(files.length, 1); const command = JSON.parse(readFileSync(join(h.stateDir, files[0]), 'utf8'));
  const dispatched = h.peer.calls.filter(row => row.method === 'run'); assert.equal(dispatched.length, 1); assert.match(dispatched[0].command, /chmod 600.*exec bash/u);
  assert.equal(command.requestDigest, digest({ command: dispatched[0].command, cwd: null, env: null, timeoutSeconds: 15 }));
  assert.equal(command.status, 'completed'); assert.equal(command.exitCode, 0);
  const status = studioNativeComponentStatus({ record: { spec: {} }, modelName: 'model', workspaceRoot: h.workspaceRoot,
    tools: [{ name: 'run_code' }], codeBinding: h.gateway.codeBinding }).status;
  assert.equal(status.sandbox.enabled, true); assert.deepEqual(status.sandbox.tools, ['run_code']); assert.equal(status.summary.isolated_execution, 'enabled');
});

test('Native local run_code rejects isolation without loading SDK, creating a code file or entering Python', async t => {
  const h = setup(t, { backend: 'local_process' }), result = await h.run({ code: 'printf forbidden', language: 'bash' });
  assert.equal(result.error_type, 'isolated_sandbox_required'); assert.equal(h.loads, 0); assert.equal(h.peer.calls.length, 0);
  const status = studioNativeComponentStatus({ record: { spec: {} }, modelName: 'model', workspaceRoot: h.workspaceRoot,
    tools: [{ name: 'run_code' }], codeBinding: h.gateway.codeBinding }).status;
  assert.equal(status.sandbox.enabled, false); assert.equal(status.summary.isolated_execution, 'not_enabled');
});

test('real registry denial and unsupported snippet language never enter SDK or command execution', async t => {
  const denied = setup(t, { deny: true }), result = await denied.run({ code: 'printf forbidden', language: 'bash' });
  assert.equal(result, undefined); assert.equal(denied.admissions, 1); assert.equal(denied.loads, 0);
  const h = setup(t), unsupported = await h.run({ code: 'printf forbidden', language: 'ruby' });
  assert.equal(unsupported.error_type, 'unsupported_language'); assert.equal(h.peer.calls.length, 0);
});
