import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { configure, initialSnapshot, NativeKernel, MemoryRunStore, canonical, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { createStudioBrowserWorkspacePort } from '../src/native/browser-workspace.mjs';
import { NativePlaywrightBrowser } from '../src/native/browser-playwright.mjs';
import { resolveNativeBrowserExecutable } from '../src/native/browser-availability.mjs';

const executablePath = resolveNativeBrowserExecutable();
test('real Chromium: mid-dispatch private input failure is fenced, not replayed, and a new page completes the same Run',
  { skip: executablePath ? false : 'No installed browser executable', timeout: 30000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'native-live-isolation-'));
    const root = join(directory, 'workspace'); mkdirSync(root);
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Recovery fixture</title><button id="start">Start</button><p>Fresh page observation</p>');
    const scope = { tenantId: 'test', workspaceId: 'local', userId: 'test', agentId: 'browser' };
    const actions = [];
    const port = await createStudioBrowserWorkspacePort({ scope, root, runtimeId: 'live-isolation', reobserveAfterLoss: true,
      createBrowser(options) {
        const backend = new NativePlaywrightBrowser({ ...options, launchBrowser: () => chromium.launch({ executablePath, headless: true }) });
        const act = backend.act.bind(backend);
        backend.act = (ref, action, options) => {
          actions.push({ kind: action.kind, generation: ref.generation });
          // Fault injection changes only this fixture's action deadline. The real
          // driver must time out, quarantine, close and restart its actual context.
          return act(ref, action.kind === 'click' ? { ...action, timeoutMs: 1000 } : action, options);
        };
        return backend;
      } });
    t.after(async () => { try { await port.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
    const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
    const config = configure({ profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture' },
      hostBindingDigest: 'live-isolation', tools: [port.definition], contract: { objective: 'Get a fresh browser observation' },
      limits: { maxRecoveryRetries: 1, maxModelCalls: 3, maxToolCalls: 2 } });
    const snapshot = initialSnapshot({ scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config, digest(config));
    const store = new MemoryRunStore(); let calls = 0;
    const kernel = new NativeKernel({ store, digest, owner: 'fixture', ports: { tools: port, browser: port, model: { generate: async () => {
      calls++;
      if (calls < 3) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: `call-${calls}`, name: port.definition.name,
        arguments: { path: 'index.html', wait_ms: 0, actions: calls === 1
          ? [{ type: 'click', selector: '#start', duration_ms: 5000 }, { type: 'press', key: 'Enter' }] : [{ type: 'reload' }] } }] };
      return { kind: 'final_candidate', text: 'Fresh browser observation obtained', usage: emptyUsage(), toolCalls: [] };
    } } } });
    kernel.start(snapshot, config);
    const finished = await kernel.runUntilIdle(scope, 'run');
    assert.equal(finished.phase, 'completed'); assert.equal(finished.recoveryRetriesUsed, 1);
    assert.equal(finished.usage.modelCalls, 3); assert.equal(finished.usage.toolCalls, 2);
    assert.equal(finished.lastBrowserObservation.sessionRef.generation, 2);
    assert.deepEqual(finished.browserReobservationRefs, []);
    const original = store.load(scope, 'run').receipts.flatMap(row => row.result.results ?? []).find(row => row.browserIsolation);
    assert.equal(original.status, 'uncertain');
    assert.ok(['action_dispatch_failed_or_timed_out', 'action_timed_out'].includes(original.browserObservation.errorCode),
      original.browserObservation.errorCode);
    assert.equal(original.browserIsolation.fenced, true);
    assert.equal(actions.filter(row => row.kind === 'click').length, 1);
    assert.equal(actions.filter(row => row.kind === 'press').length, 0);
    assert.equal(actions.some(row => row.kind === 'navigate' && row.generation === 2), true);
  });
