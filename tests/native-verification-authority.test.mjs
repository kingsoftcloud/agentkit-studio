import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { NativeKernel, RESULT_DELIVERY_POLICY, deliveryToolDefinitions, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { NativePlaywrightBrowser } from '@kingsoftcloud/agentkit-harness-node/native/browser-playwright';
import { resolveNativeBrowserExecutable } from '@kingsoftcloud/agentkit-harness-node/native/browser-availability';
import { createNativeVerificationAuthority } from '@kingsoftcloud/agentkit-harness-node/native/verification-authority';
import { createNativeToolAuthority } from '@kingsoftcloud/agentkit-harness-node/native/tool-authority';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { createNativeVerification, nativeGoalContract } from '../src/providers/native-verification.mjs';
import { installNativeBoundPolicy } from '../src/providers/native-bound-policy.mjs';
import { HOST_PREFLIGHT_DEFER } from '../src/providers/native-durable-approval.mjs';
import { fixture, scope, digest } from './fixtures/native-core.mjs';

// Actual Chromium, loopback file owner, SQLite/Kernel and registry body. The
// registry/permissions and model peer are controlled; no remote model is used.
for (const disposition of ['allow', 'deny', 'lost-lease', 'bound-policy']) test(`governed browser verification uses its own claim through the real pipeline: ${disposition}`, async t => {
  const executablePath = resolveNativeBrowserExecutable({ env: process.env });
  assert.ok(executablePath, 'actual browser verification requires an installed Chromium executable');
  const { chromium } = await import('playwright-core');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-verification-authority-'))), workspace = join(root, 'workspace');
  mkdirSync(workspace); writeFileSync(join(workspace, 'index.html'), '<!doctype html><title>Native verification</title><p>Observed page</p>');
  const store = new SqliteRunStore(join(root, 'runs.sqlite')), registry = new Map(), calls = [], actions = [];
  let models = 0, released = false, verifications = 0;
  const agent = { session: { id: 'session' } };
  const images = new Map(), attachments = {
    imageLimits: { maxImageBytes: 2 * 1024 * 1024, maxImagesPerMessage: 8, maxMessageImageBytes: 16 * 1024 * 1024,
      mediaTypes: ['image/png'] },
    async saveImages(input) { return input.map(image => {
      const size = PNG.sync.read(image.data), attachmentId = `image-${images.size + 1}`;
      images.set(attachmentId, image);
      return { attachmentId, mediaType: image.mediaType, bytes: image.data.length, width: size.width, height: size.height };
    }); },
    async readImageRequest(ref) { return images.get(ref.attachmentId); },
  };
  const guards = new Set(), dispatchGuards = new Set();let preExecute;
  const ctx = { get: key => key === 'attachments' ? attachments : undefined,
    on: (_name, listener) => { preExecute = listener; return () => { preExecute = undefined; }; },
    effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: {
    resultRetentions: ['caller/v1'], preflightDeferContract: HOST_PREFLIGHT_DEFER,
    guard: callback => { guards.add(callback); return () => guards.delete(callback); },
    dispatchGuard: callback => { dispatchGuards.add(callback); return () => dispatchGuards.delete(callback); },
    register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    async execute(input) {
      calls.push(input.callId);
      try {
        if (preExecute) {
          const decision = await preExecute(input, async () => ({ kind: 'allow' }));
          if (decision.kind !== 'allow') return { isError: true, content: [{ type: 'text', text: 'Host policy denied' }] };
        }
        for (const guard of [...guards, ...dispatchGuards]) {
          const denied = guard(input);if (denied) return { isError: true, content: [{ type: 'text', text: denied }] };
        }
      if (input.callId.startsWith('ak-native-verify-')) {
        if (disposition === 'deny') return { isError: true, content: [{ type: 'text', text: 'Host policy denied' }] };
        if (disposition === 'lost-lease' && !released) {
          released = true; store.release(scope, 'run', store.authority(scope, 'run').lease);
        }
      }
      const tool = registry.get(input.name), value = await tool.execute(input.arguments, input);
      return { isError: false, value, content: tool.output.render(input.arguments, value) };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    },
  } };
  const gateway = createNativeDshTools({ ctx, config: { agentId: scope.agentId, toolBindings: ['browser_inspect_workspace'],
    nativeEngineContract: 'agentkit.native-dsh-turn/v1',
    ...(disposition === 'bound-policy' ? { boundToolPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'loose', rules: {} } } : {}) }, workspaceRoot: workspace, stateDir: join(root, 'state'),
    createBrowser: options => {
      const browser = new NativePlaywrightBrowser({ ...options, launchBrowser: () => chromium.launch({ headless: true, executablePath }) });
      const act = browser.act.bind(browser);
      browser.act = (...args) => { actions.push({ runId: args[0].runId, kind: args[1].kind }); return act(...args); };
      return browser;
    } });
  t.after(async () => { await gateway.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  if (disposition === 'bound-policy') t.after(installNativeBoundPolicy(ctx,
    { contract: 'agentkit.native-agent-policy/v1', mode: 'loose', rules: {} },
    (agent, name) => gateway.policyDefinition(agent, name), gateway.durableApproval));
  const definitions = gateway.definitions(agent, [...registry.values()], {
    ...(disposition === 'bound-policy' ? { approvalPolicy: gateway.durableApprovalContract } : {}) });
  const { config, snapshot } = fixture({ workspaceCapturePolicy: 'declared-subjects/v1', deliveryScopePolicy: RESULT_DELIVERY_POLICY,
    tools: [...definitions, ...deliveryToolDefinitions(RESULT_DELIVERY_POLICY)], contract: nativeGoalContract({ sessionId: 'session', goal: 'Inspect the current local page.' }),
    limits: { maxRepairs: 0, maxModelCalls: 3 } });
  const verification = await createNativeVerification({ scope, sessionId: 'session', workspaceRoot: workspace,
    deliveryScopePolicy: RESULT_DELIVERY_POLICY, evidenceDirectory: join(root, 'verification-evidence'),
    verifyBrowserPage: (request) => gateway.verifyBrowserPage(agent, request, { scope, store }) });
  const allowed = createNativeVerificationAuthority({ scope, sessionId: 'session', store, toolName: 'browser_inspect_workspace' });
  const toolAllowed = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const ports = gateway.forAgent(agent, { scope, store });
  const kernel = new NativeKernel({ store, owner: 'verification', digest, ports: { ...ports,
    model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: ++models === 1
      ? [{ callId: 'inspect', name: 'browser_inspect_workspace', arguments: { path: 'index.html', wait_ms: 0 } }]
      : [{ callId: 'final', name: 'submit_final_output', arguments: { answer: 'Observed page; semantics remain unverified.',
        artifacts: [{ path: 'index.html', kind: 'web', root: '.' }] } }] }) },
    verification: { verify: async request => {
      verifications++;
      const probe = { ...request, entryPath: 'index.html', candidateId: request.candidate.candidateId };
      assert.equal(allowed(probe), true); assert.equal(toolAllowed(probe), false, 'a verify claim never becomes a model tool claim');
      for (const changed of [{ operationKey: 'invented' }, { executionFence: request.executionFence + 1 }, { candidateId: 'other' },
        { candidate: { ...request.candidate, text: 'mutated' } }, { contract: { ...request.contract, objective: 'other' } },
        { sessionId: 'other' }, { entryPath: 'other.html' }]) assert.equal(allowed({ ...probe, ...changed }), false);
      await assert.rejects(gateway.verifyBrowserPage(agent, probe), /verification_authority_missing/);
      return verification.verify(request);
    } } } });
  kernel.start(snapshot, config);
  if (disposition === 'lost-lease') await assert.rejects(kernel.runUntilIdle(scope, 'run'), { code: 'stale_fence' });
  else {
    const done = await kernel.runUntilIdle(scope, 'run');
    assert.equal(done.phase, 'completed', JSON.stringify({ reason: done.reason, models, verifications, calls, actions,
      receipts: store.load(scope, 'run').receipts.slice(-3).map(receipt => ({ status: receipt.status, code: receipt.result.code })) }));
    assert.equal(done.outcome, ['allow', 'bound-policy'].includes(disposition) ? 'unverified' : 'blocked');
    assert.equal(done.reason, ['allow', 'bound-policy'].includes(disposition) ? 'required_verification_incomplete' : 'required_acceptance_blocked');
  }
  assert.equal(models, 2); assert.equal(verifications, 1);
  const verificationActions = actions.filter(action => action.runId.includes(':host-verify:'));
  assert.deepEqual(verificationActions.map(action => action.kind), ['allow', 'bound-policy'].includes(disposition) ? ['navigate', 'screenshot'] : []);
  assert.equal(calls.filter(id => id.startsWith('ak-native-verify-')).length, ['allow', 'bound-policy'].includes(disposition) ? 2 : 1);
});
