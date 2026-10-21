import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeKernel, MemoryRunStore, canonical, configure, emptyUsage, reduceVerification } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeArtifactStore } from '../packages/agentkit-harness/src/native/artifact-store.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeVerification, nativeGoalContract } from '../src/providers/native-verification.mjs';

const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const cleanBrowser = overrides => ({ status: 'ok', complete: true, statusCode: 200, errorCode: null,
  screenshot: { contentRef: 'host-owned-browser-image' }, controls: [], console: [], pageErrors: [], pageErrorLocations: [], networkFailures: [], ...overrides });

async function fixture(t, { goal = 'Finish the requested work.', text = 'Done', browser = cleanBrowser(), web = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-verification-')), workspace = join(directory, 'workspace');
  const evidenceDirectory = join(directory, 'evidence');
  await mkdir(workspace); await writeFile(join(workspace, 'index.html'), '<button>Start</button>');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contract = nativeGoalContract({ sessionId: 'session', goal }), browserCalls = [];
  const identity = { scope, runId: 'run', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain' };
  const candidate = { candidateId: 'candidate', text, goalRevision: 1, workspaceRevision: 'revision',
    binding: { subjectDigest: digest(text), subjectContextDigest: 'context', environmentDigest: 'host' } };
  const snapshot = { ...identity, candidate, goalRevision: 1, repairs: 0, messages: [],
    workspaceModifiedPaths: web ? ['index.html'] : [], lastWebMutationToolCall: web ? 3 : null,
    lastBrowserObservation: web ? { entryPath: 'index.html', toolCall: 3, goalRevision: 1 } : null,
    unresolvedInteractionObservation: null };
  const request = { ...identity, operationKey: 'verify', signal: new AbortController().signal, snapshot, candidate, contract };
  const verification = await createNativeVerification({ scope, sessionId: 'session', workspaceRoot: workspace, evidenceDirectory,
    verifyBrowserPage: async request => { browserCalls.push(request); if (browser instanceof Error) throw browser; return browser; } });
  const inspect = async report => {
    const ref = report.checks[0].evidence.artifact;
    const reopened = await createNativeArtifactStore({ directory: evidenceDirectory, scope });
    const result = await reopened.read({ ...request, ref, offset: 0, limit: 32000 });
    assert.equal(digest(JSON.parse(result.content)), ref.digest.slice('sha256:'.length));
    return JSON.parse(result.content);
  };
  return { directory, workspace, evidenceDirectory, request, verification, browserCalls, inspect };
}

test('Studio goal contracts pin general evidence authority, output schemas and literal files', () => {
  const goal = 'Return only a JSON object.';
  const first = nativeGoalContract({ sessionId: 's', goal }), again = nativeGoalContract({ sessionId: 's', goal });
  assert.deepEqual(first, again); assert.equal(first.acceptance[0].verifierRef, 'studio.delivery-evidence-rejection');
  assert.equal(first.acceptance[0].required, true); assert.equal(first.finalSubmissionPayloadKey, 'output');
  assert.equal(first.finalOutputFormat, 'json_object');
  assert.equal(nativeGoalContract({ sessionId: 's', goal: '在工作区创建 config.txt，内容恰好是 ready。' }).acceptance.length, 2);
  assert.notEqual(first.revision, nativeGoalContract({ sessionId: 's', goal: goal + ' Now.' }).revision);
  assert.notEqual(first.revision, nativeGoalContract({ sessionId: 'other', goal }).revision);
  assert.notEqual(first.revision, nativeGoalContract({ sessionId: 's', parentRunId: 'parent', goal }).revision);
});

test('an ordinary response remains not_run with durable, readable scoped evidence', async t => {
  const f = await fixture(t), report = await f.verification.verify(f.request);
  assert.equal(report.checks[0].status, 'not_run'); assert.equal(report.status, 'unverified');
  assert.equal(report.repairable, false); assert.deepEqual(report.binding, f.request.candidate.binding);
  const facts = await f.inspect(report); assert.equal(facts.candidate.text, 'Done');
  const config = { contract: f.request.contract, limits: { maxRepairs: 3 } };
  assert.equal(reduceVerification(f.request.snapshot, report, config).outcome, 'unverified');
  await assert.rejects(f.verification.verify({ ...f.request, scope: { ...scope, userId: 'other' } }), /scope_mismatch/);
  await assert.rejects(f.verification.verify({ ...f.request, sessionId: 'other' }), /scope_mismatch/);
  await assert.rejects(f.verification.verify({ ...f.request, candidate: { ...f.request.candidate, text: 'forged' } }), /candidate_mismatch/);
});

test('a checkpoint observes work without requiring a final-answer shape', async t => {
  const f = await fixture(t, { goal: 'Return only a Python list literal.', text: '' });
  f.request.candidate.purpose = 'checkpoint';
  const report = await f.verification.verify(f.request);
  assert.equal(report.checks[0].status, 'not_run'); assert.equal(report.repairable, false);
  assert.equal((await f.inspect(report)).facts.shapeFailure, null);
});

test('a malformed final answer produces evidence-backed bounded repair feedback', async t => {
  const f = await fixture(t, { goal: 'Return only a Python list literal.', text: 'Here is [1,2]' });
  const report = await f.verification.verify(f.request), check = report.checks[0];
  assert.equal(check.status, 'failed'); assert.equal(report.repairable, true); assert.ok(report.failureFingerprint);
  const reduced = reduceVerification(f.request.snapshot, report, { contract: f.request.contract, limits: { maxRepairs: 3 } });
  assert.equal(reduced.phase, 'preparing_context'); assert.equal(reduced.repairs, 1);
  assert.equal(reduced.messages.at(-1).kind, 'verification_feedback'); assert.equal(reduced.candidate, null);
  assert.equal((await f.inspect(report)).facts.shape, 'python_list');
  f.request.snapshot.repairs = 3;
  assert.equal(reduceVerification(f.request.snapshot, report, { contract: f.request.contract, limits: { maxRepairs: 3 } }).reason, 'repair_budget_exhausted');
});

test('clean cold browser evidence does not approve semantics or replace the model observation', async t => {
  const f = await fixture(t, { web: true }), report = await f.verification.verify(f.request);
  assert.equal(report.checks[0].status, 'not_run'); assert.equal(f.browserCalls.length, 1);
  assert.equal(f.browserCalls[0].entryPath, 'index.html'); assert.equal(f.browserCalls[0].candidateId, 'candidate');
  assert.equal(report.workspaceDependency, 'required'); assert.equal((await f.inspect(report)).facts.entryPath, 'index.html');
  f.request.operationKey = 'stale'; f.request.snapshot.lastBrowserObservation.toolCall = 2;
  const stale = await f.verification.verify(f.request);
  assert.equal(stale.checks[0].status, 'failed'); assert.match(stale.checks[0].safeSummary, /latest web file change/);
});

for (const [name, observation, status, summary] of [
  ['HTTP error', cleanBrowser({ statusCode: 404 }), 'failed', /404/],
  ['duplicate controls', cleanBrowser({ status: 'error', errorCode: 'browser_launch_control_ambiguous' }), 'failed', /multiple visible/],
  ['incomplete capture', cleanBrowser({ complete: false }), 'blocked', /incomplete host/],
  ['unknown result', cleanBrowser({ status: 'unknown' }), 'blocked', /incomplete host/],
  ['missing screenshot', cleanBrowser({ screenshot: null }), 'blocked', /incomplete host/],
  ['unavailable Host', new Error('Browser missing'), 'blocked', /Restore the host/],
  ['network policy', cleanBrowser({ networkFailures: ['network_denied: https://outside/'] }), 'failed', /authorized local origin/],
  ['local asset', cleanBrowser({ networkFailures: ['asset_http_error: missing.js 404'] }), 'failed', /missing.js/],
  ['page error', cleanBrowser({ pageErrors: ['boom'], pageErrorLocations: ['app.js:5'] }), 'failed', /app.js:5.*boom/],
  ['console assertion', cleanBrowser({ console: ['assert: failed'] }), 'failed', /assert: failed/],
]) test(`browser ${name} is independently classified`, async t => {
  const f = await fixture(t, { web: true, browser: observation }), report = await f.verification.verify(f.request);
  assert.equal(report.checks[0].status, status); assert.match(report.checks[0].safeSummary, summary);
  assert.equal(report.repairable, status === 'failed'); await f.inspect(report);
});

test('only the precise headless pointer-lock warning is ignored', async t => {
  const warning = 'The root document of this element is not valid for pointer lock.';
  const f = await fixture(t, { web: true, browser: cleanBrowser({ pageErrors: [warning], console: ['error: ' + warning, 'warning: harmless'] }) });
  assert.equal((await f.verification.verify(f.request)).checks[0].status, 'not_run');
});

test('a successful cold smoke does not clear an unresolved interaction failure', async t => {
  const f = await fixture(t, { web: true });
  f.request.snapshot.unresolvedInteractionObservation = { toolName: 'browser_inspect_workspace', entryPath: 'index.html', error: 'click exploded', digest: 'error', toolCall: 4 };
  const report = await f.verification.verify(f.request);
  assert.equal(report.checks[0].status, 'failed'); assert.match(report.checks[0].safeSummary, /click exploded/);
  assert.equal((await f.inspect(report)).facts.unresolvedInteractionObservation.digest, 'error');
});

test('entry ambiguity blocks before browser dispatch and cannot request delivery changes', async t => {
  const f = await fixture(t, { web: true }); await writeFile(join(f.workspace, 'other.html'), '<p>Other</p>');
  f.request.snapshot.workspaceModifiedPaths.push('other.html');
  const report = await f.verification.verify(f.request);
  assert.equal(report.checks[0].status, 'blocked'); assert.equal(report.repairable, false); assert.equal(f.browserCalls.length, 0);
});

test('literal UTF-8 file bytes can qualify only the exact-file item, never the whole task', async t => {
  const f = await fixture(t, { goal: '在工作区创建 note.txt，内容恰好是 你好。' });
  assert.equal(f.request.contract.acceptance.length, 2);
  await writeFile(join(f.workspace, 'note.txt'), '你好');
  const report = await f.verification.verify(f.request);
  assert.deepEqual(report.checks.map(check => check.status), ['not_run', 'passed']);
  assert.equal(reduceVerification(f.request.snapshot, report, { contract: f.request.contract, limits: { maxRepairs: 3 } }).outcome, 'partial');
  assert.equal((await f.inspect(report)).facts.exactFile.digest, 'sha256:' + createHash('sha256').update('你好').digest('hex'));
  await writeFile(join(f.workspace, 'note.txt'), '你好\n'); f.request.operationKey = 'file-changed';
  const changed = await f.verification.verify(f.request);
  assert.deepEqual(changed.checks.map(check => check.status), ['failed', 'failed']);
  assert.match(changed.checks[1].safeSummary, /byte 6/);
});

test('exact-file verification refuses an outside symlink and reports a missing literal file', async t => {
  const f = await fixture(t, { goal: '在工作区创建 note.txt，内容恰好是 ready。' });
  await writeFile(join(f.directory, 'outside'), 'ready'); await symlink(join(f.directory, 'outside'), join(f.workspace, 'note.txt'));
  const report = await f.verification.verify(f.request);
  assert.equal(report.checks[1].status, 'failed'); assert.match(report.checks[1].safeSummary, /outside/);
  await rm(join(f.workspace, 'note.txt')); f.request.operationKey = 'missing';
  assert.match((await f.verification.verify(f.request)).checks[1].safeSummary, /missing or unreadable/);
});

test('an unavailable evidence store blocks all checks without inventing an evidence reference', async t => {
  const f = await fixture(t);
  await rename(f.evidenceDirectory, f.evidenceDirectory + '-old'); await writeFile(f.evidenceDirectory, 'not a directory');
  const report = await f.verification.verify(f.request);
  assert.equal(report.reason, 'studio_evidence_storage_blocked'); assert.equal(report.checks[0].status, 'blocked');
  assert.deepEqual(report.checks[0].evidenceRefs, []); assert.equal(report.repairable, false);
});

test('cancellation cannot publish a browser verdict or seal late evidence', async t => {
  const f = await fixture(t, { web: true }), controller = new AbortController(); controller.abort(new Error('Canceled'));
  await assert.rejects(f.verification.verify({ ...f.request, signal: controller.signal }), /Canceled/);
  assert.equal(f.browserCalls.length, 0);
});

test('verification evidence is rejected when placed inside the model workspace', async t => {
  const f = await fixture(t);
  await assert.rejects(createNativeVerification({ scope, sessionId: 'session', workspaceRoot: f.workspace,
    evidenceDirectory: join(f.workspace, 'evidence') }), /evidence_inside_workspace/);
});

test('the real Native loop repairs malformed final text, persists evidence and terminates unverified', async t => {
  const f = await fixture(t, { goal: 'Return only a Python list literal.' }), store = new MemoryRunStore();
  const config = configure({ contract: f.request.contract, hostBindingDigest: 'host',
    profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'test', compatibilityDigest: 'test' },
    limits: { maxModelCalls: 3, maxRepairs: 2 } });
  let calls = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'owner', ports: { verification: f.verification,
    model: { generate: async request => {
      calls++;
      if (calls === 2) {
        const feedback = request.messages.find(message => message.kind === 'verification_feedback');
        assert.ok(feedback); assert.equal(JSON.parse(feedback.content).failed[0].id, 'current_user_goal');
        assert.equal(JSON.parse(feedback.content).failed[0].repairable, true);
        assert.equal(feedback.content.includes('native-artifact:'), false);
      }
      return { kind: 'final_candidate', text: calls === 1 ? 'Here is [1]' : '[1]', toolCalls: [], usage: emptyUsage() };
    } } } });
  kernel.start({ scope, runId: 'kernel', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config);
  const result = await kernel.runUntilIdle(scope, 'kernel');
  assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'unverified');
  assert.equal(result.repairs, 1); assert.equal(calls, 2); assert.equal(result.finalText, '[1]');
  const record = store.load(scope, 'kernel'), verificationKeys = record.intents.filter(intent => intent.kind === 'verify').map(intent => intent.operationKey);
  assert.equal(record.receipts.filter(receipt => verificationKeys.includes(receipt.operationKey)).length, 2);
});

test('workspace changes during Studio verification invalidate the candidate and require a new answer', async t => {
  const f = await fixture(t), store = new MemoryRunStore();
  const config = configure({ contract: f.request.contract, hostBindingDigest: 'host',
    profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'test', compatibilityDigest: 'test' },
    limits: { maxModelCalls: 3, maxRepairs: 1 } });
  let observations = 0, models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'owner', ports: { verification: f.verification,
    workspace: { observe: async () => ({ status: 'ok', revision: ++observations <= 2 ? 'before' : 'after', changedPaths: [], reason: null }) },
    model: { generate: async request => {
      if (++models === 2) assert.ok(request.messages.some(message => message.kind === 'verification_feedback' && message.content.includes('workspace changed')));
      return { kind: 'final_candidate', text: models === 1 ? 'Old answer' : 'Rechecked answer', toolCalls: [], usage: emptyUsage() };
    } } } });
  kernel.start({ scope, runId: 'drift', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config);
  const result = await kernel.runUntilIdle(scope, 'drift');
  assert.equal(models, 2); assert.equal(result.repairs, 1); assert.equal(result.finalText, 'Rechecked answer');
  assert.equal(result.candidate.workspaceRevision, 'after'); assert.equal(result.outcome, 'unverified');
});

for (const [goal, output, text] of [
  ['Return only the total.', 42, '42'],
  ['Return only the integer.', 42, '42'],
  ['只回复 JSON 布尔值。', true, 'true'],
  ['Return only a JSON object.', { result: 'value' }, '{"result":"value"}'],
  ['Return only a JSON array.', [1, 2], '[1,2]'],
  ['Return only the sentence.', 'Ready.', 'Ready.'],
]) test(`Studio structured submission preserves the declared final value: ${goal}`, async t => {
  const f = await fixture(t, { goal }), store = new MemoryRunStore();
  assert.ok(f.request.contract.finalSubmissionSchema);
  const config = configure({ contract: f.request.contract, hostBindingDigest: 'host',
    profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'test', compatibilityDigest: 'test' } });
  const kernel = new NativeKernel({ store, digest, owner: 'owner', ports: { verification: f.verification,
    model: { generate: async request => {
      assert.equal(request.tools.at(-1).name, 'submit_final_output');
      return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'final', name: 'submit_final_output', arguments: { output } }], usage: emptyUsage() };
    } } } });
  kernel.start({ scope, runId: 'structured', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config);
  const result = await kernel.runUntilIdle(scope, 'structured');
  assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'unverified'); assert.equal(result.finalText, text);
  assert.equal(store.load(scope, 'structured').intents.some(intent => intent.kind === 'tool'), false);
});

test('a process crash after evidence sealing cannot replay verification or promote an uncommitted verdict', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-verification-crash-'));
  let store;
  t.after(() => { store?.close(); return rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, 'workspace')); await writeFile(join(directory, 'workspace/note.txt'), 'ready');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/native-verification-crash.mjs', import.meta.url)), directory],
    { encoding: 'utf8', env: { ...process.env, PATH: '/no-programs' }, timeout: 10000 });
  assert.equal(child.status, 83, child.stderr); assert.equal(child.signal, null);
  store = new SqliteRunStore(join(directory, 'runs.sqlite'));
  const stored = store.load(scope, 'crash'), pending = stored.intents.find(intent => intent.operationKey === stored.snapshot.pendingIntent);
  assert.equal(pending.kind, 'verify'); assert.equal(pending.status, 'running');
  assert.equal(stored.receipts.some(receipt => receipt.operationKey === pending.operationKey), false);
  const evidence = await createNativeArtifactStore({ directory: join(directory, 'evidence'), scope });
  const context = { scope, runId: 'crash', operationKey: 'inspect', signal: new AbortController().signal };
  const refs = await evidence.search({ ...context, query: 'studio.delivery-evidence-rejection', limit: 10 });
  assert.equal(refs.length, 1);
  const proof = JSON.parse((await evidence.read({ ...context, ref: refs[0], offset: 0, limit: 32000 })).content);
  assert.equal(proof.results.find(check => check.id === 'exact_workspace_file').status, 'passed');
  const kernel = new NativeKernel({ store, digest, owner: 'replacement', now: () => Date.now() + stored.configuration.limits.leaseMs + 1000,
    ports: { verification: { verify: async () => assert.fail('Unknown verification must never be replayed') },
      model: { generate: async () => assert.fail('Recovery must not ask for a replacement candidate') } } });
  const recovered = await kernel.runUntilIdle(scope, 'crash');
  assert.equal(recovered.phase, 'interrupted'); assert.equal(recovered.reason, 'effect_outcome_unknown');
  assert.equal(recovered.outcome, 'unverified'); assert.equal(recovered.verification, null);
});
