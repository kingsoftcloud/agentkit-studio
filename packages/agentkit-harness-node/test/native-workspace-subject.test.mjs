import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, RESULT_DELIVERY_POLICY, deliveryToolDefinitions, emptyUsage, canonical,
  configure, workspaceObservationSubject } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { captureWorkspaceSubject } from '../src/native/workspace-subject-observer.mjs';
import { fixture, scope, digest, acceptance, verificationReport } from '../../agentkit-harness-core/test/fixtures.mjs';

function setup(t, large = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-subject-'))), workspace = join(root, 'workspace');
  mkdirSync(workspace); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'report.md'), 'delivered report');
  mkdirSync(join(workspace, 'references'));
  if (large) {
    for (let n = 0; n < 2100; n++) writeFileSync(join(workspace, 'references', `${n}.ts`), `reference ${n}`);
    const fd = openSync(join(workspace, 'references', 'large.pack'), 'w'); ftruncateSync(fd, 80 * 1024 * 1024); closeSync(fd);
  }
  const owner = createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir: join(root, 'state'), sessionId: 'session', authorize: async () => 'allow' });
  const subject = artifacts => ({ contract: 'agentkit.delivery-observation-subject/v1', goalRevision: 0, manifestRevision: 1, artifacts });
  const request = { sessionId: 'session', signal: new AbortController().signal };
  return { root, workspace, owner, request, subject };
}

test('declared files bypass unrelated oversized sources while retaining exact content revisions', async t => {
  const h = setup(t, true), subject = h.subject([{ path: 'report.md', kind: 'file' }]);
  assert.equal((await h.owner.observe(h.request)).reason, 'capture_limit_exceeded');
  const first = await h.owner.observe({ ...h.request, subject });
  assert.equal(first.status, 'ok'); assert.deepEqual(first.subject, subject);
  writeFileSync(join(h.workspace, 'references', 'new.ts'), 'unrelated source');
  assert.equal((await h.owner.observe({ ...h.request, subject })).revision, first.revision);
  writeFileSync(join(h.workspace, 'report.md'), 'changed report');
  assert.notEqual((await h.owner.observe({ ...h.request, subject })).revision, first.revision);
  assert.equal((await h.owner.observe(h.request)).status, 'unavailable', 'legacy observation still scans the whole workspace');
});

test('web subjects cover their project dependencies, ignore unrelated projects and bind declaration identity', async t => {
  const h = setup(t); mkdirSync(join(h.workspace, 'game')); mkdirSync(join(h.workspace, 'game', 'node_modules'));
  writeFileSync(join(h.workspace, 'game', 'index.html'), '<script src="node_modules/engine.js"></script>');
  writeFileSync(join(h.workspace, 'game', 'node_modules', 'engine.js'), 'engine v1');
  const subject = h.subject([{ path: 'game/index.html', kind: 'web', root: 'game' }]);
  const capture = value => h.owner.observe({ ...h.request, subject: value ?? subject });
  const first = await capture(); assert.equal(first.status, 'ok');
  writeFileSync(join(h.workspace, 'report.md'), 'outside project'); assert.equal((await capture()).revision, first.revision);
  writeFileSync(join(h.workspace, 'game', 'node_modules', 'engine.js'), 'engine v2');
  assert.notEqual((await capture()).revision, first.revision);
  const current = await capture(); assert.notEqual((await capture({ ...subject, manifestRevision: 2 })).revision, current.revision);
  const text = await capture(h.subject([])); assert.equal(text.status, 'ok');
  writeFileSync(join(h.workspace, 'report.md'), 'another value'); assert.equal((await capture(h.subject([]))).revision, text.revision);
});

test('selected subjects keep shared resource limits, aborts, path boundaries and missing-file failures', async t => {
  const h = setup(t), subject = h.subject([{ path: 'report.md', kind: 'file' }]);
  await assert.rejects(captureWorkspaceSubject({ root: h.workspace, subject, maxBytes: 1 }), /capture_limit_exceeded/);
  writeFileSync(join(h.workspace, 'second.md'), 'second');
  await assert.rejects(captureWorkspaceSubject({ root: h.workspace, maxEntries: 1,
    subject: h.subject([...subject.artifacts, { path: 'second.md', kind: 'file' }]) }), /capture_limit_exceeded/);
  const canceled = new AbortController(); canceled.abort(Error('canceled observation'));
  await assert.rejects(h.owner.observe({ ...h.request, subject, signal: canceled.signal }), /canceled observation/);
  for (const path of ['../outside', '/outside'])
    assert.equal((await h.owner.observe({ ...h.request, subject: h.subject([{ path, kind: 'file' }]) })).status, 'unavailable');
  assert.equal((await h.owner.observe({ ...h.request, subject: h.subject([{ path: 'missing.md', kind: 'file' }]) })).status, 'unavailable');
  writeFileSync(join(h.root, 'private'), 'outside'); symlinkSync(join(h.root, 'private'), join(h.workspace, 'link'));
  const outside = await h.owner.observe({ ...h.request, subject: h.subject([{ path: 'link', kind: 'file' }]) });
  assert.equal(outside.status, 'unavailable'); assert.equal(outside.reason, 'workspace_path_outside_scope');
  symlinkSync(join(h.workspace, 'report.md'), join(h.workspace, 'internal-link'));
  assert.equal((await h.owner.observe({ ...h.request, subject: h.subject([{ path: 'internal-link', kind: 'file' }]) })).reason, 'unsupported_workspace_entry');
});

for (const mutation of ['none', 'references', 'delivery']) test(`SQLite Kernel binds the atomic final subject and detects terminal ${mutation} changes`, async t => {
  const h = setup(t, true), file = join(h.root, 'runs.sqlite'), store = new SqliteRunStore(file); t.after(() => store.close());
  const { config, snapshot } = fixture({ workspaceCapturePolicy: 'declared-subjects/v1', deliveryScopePolicy: RESULT_DELIVERY_POLICY,
    tools: deliveryToolDefinitions(RESULT_DELIVERY_POLICY), contract: { objective: 'Deliver report.md', acceptance: [acceptance()] }, limits: { maxRepairs: 0 } });
  let models = 0, checks = 0;
  const kernel = new NativeKernel({ store, owner: 'subject', digest, ports: { workspace: h.owner,
    model: { generate: async () => { models++; return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'final', name: 'submit_final_output', arguments: { answer: 'Report ready.', artifacts: [{ path: 'report.md', kind: 'file' }] } }] }; } },
    verification: { verify: async request => {
      checks++; assert.equal(readFileSync(join(h.workspace, 'report.md'), 'utf8'), 'delivered report');
      assert.equal(request.candidate.workspaceRevision, request.snapshot.workspaceRevision);
      assert.equal(request.candidate.workspaceSubject, digest(workspaceObservationSubject(request.snapshot, config)));
      assert.ok(request.candidate.workspaceRevision); assert.equal(request.candidate.workspaceSubject, request.snapshot.workspaceObservationSubject);
      const report = verificationReport(request, { workspaceDependency: 'required' });
      if (mutation !== 'none') writeFileSync(join(h.workspace, mutation === 'delivery' ? 'report.md' : 'references/changed.ts'), 'changed after verification');
      return report;
    } } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(models, 1); assert.equal(checks, 1);
  assert.equal(done.outcome, mutation === 'delivery' ? 'unverified' : 'verified');
  assert.equal(done.reason, mutation === 'delivery' ? 'candidate_workspace_changed' : 'required_acceptance_verified');
  assert.equal(store.load(scope, 'run').events.filter(event => event.kind === 'verification.subject_observed').length, 1);
});

test('SQLite restart retains the declared observation baseline and cannot silently renegotiate its policy', async t => {
  const h = setup(t), file = join(h.root, 'runs.sqlite'); let store = new SqliteRunStore(file); t.after(() => store.close());
  const { config, snapshot } = fixture({ workspaceCapturePolicy: 'declared-subjects/v1', deliveryScopePolicy: RESULT_DELIVERY_POLICY,
    tools: deliveryToolDefinitions(RESULT_DELIVERY_POLICY), contract: { objective: 'Deliver report.md', acceptance: [acceptance()] } });
  let models = 0, paused = false, checks = 0;
  const ports = { workspace: h.owner, model: { generate: async () => { models++; return { kind: 'tool_calls', text: '', usage: emptyUsage(),
    toolCalls: [{ callId: 'final', name: 'submit_final_output', arguments: { answer: 'Ready.', artifacts: [{ path: 'report.md', kind: 'file' }] } }] }; } },
    verification: { verify: async request => { checks++; return verificationReport(request, { workspaceDependency: 'required' }); } } };
  let kernel = new NativeKernel({ store, owner: 'first', digest, ports, onCheckpoint: async state => {
    if (!paused && state.phase === 'verifying' && state.candidate?.workspaceRevision) {
      paused = true; kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
    }
  } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'paused');
  const before = store.load(scope, 'run'); assert.ok(before.snapshot.candidate.workspaceSubject); assert.equal(checks, 0);
  store.close(); store = new SqliteRunStore(file); kernel = new NativeKernel({ store, owner: 'cold', digest, ports });
  kernel.attach(scope, 'run'); kernel.submit(scope, 'run', { commandId: 'resume', kind: 'resume', payload: {} });
  assert.equal((await kernel.runUntilIdle(scope, 'run')).outcome, 'verified'); assert.equal(models, 1); assert.equal(checks, 1);
  assert.equal(store.load(scope, 'run').events.filter(event => event.kind === 'verification.subject_observed').length, 1);
  assert.equal(canonical(configure(config)), canonical(config));
  const legacy = { ...config }; delete legacy.workspaceCapturePolicy;
  assert.equal(canonical(configure(legacy)), canonical(legacy));
});

test('a workspace port ignoring the declared subject cannot qualify a workspace-dependent pass', async t => {
  const h = setup(t), store = new SqliteRunStore(join(h.root, 'runs.sqlite')); t.after(() => store.close());
  const { config, snapshot } = fixture({ workspaceCapturePolicy: 'declared-subjects/v1', deliveryScopePolicy: RESULT_DELIVERY_POLICY,
    tools: deliveryToolDefinitions(RESULT_DELIVERY_POLICY), contract: { objective: 'Report', acceptance: [acceptance()] } });
  const kernel = new NativeKernel({ store, digest, owner: 'old-port', ports: {
    workspace: { observe: async () => ({ status: 'ok', revision: 'unscoped-revision', changedPaths: [], reason: null }) },
    model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'final', name: 'submit_final_output',
      arguments: { answer: 'Ready.', artifacts: [{ path: 'report.md', kind: 'file' }] } }] }) },
    verification: { verify: async request => verificationReport(request, { workspaceDependency: 'required' }) } } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.outcome, 'unverified'); assert.equal(done.candidate.workspaceRevision, null); assert.equal(done.repairs, 0);
  assert.ok(store.load(scope, 'run').events.some(event => event.kind === 'workspace.observation_unavailable' && event.payload.reason === 'workspace_subject_mismatch'));
});
