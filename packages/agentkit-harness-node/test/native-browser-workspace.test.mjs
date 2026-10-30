import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioBrowserWorkspacePort } from '../src/native/browser-workspace.mjs';
import { parseWorkspaceBrowserInput, studioBrowserDefinition } from '../src/native/browser-workspace-protocol.mjs';
import { compileToolInput, configure, NativeKernel, initialSnapshot, MemoryRunStore, emptyUsage,
  canonical, validateBrowserObservation, validateBrowserSessionRef } from '../../agentkit-harness-core/dist/index.mjs';
import { createHash } from 'node:crypto';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';

const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const parse = (actions, options = {}) => parseWorkspaceBrowserInput({ path: 'app', wait_ms: 0, actions, ...options }, 'operation');
const baseInput = { path: 'app', wait_ms: 0 };
const request = (operationKey, args = baseInput, runId = 'run') => ({ scope, runId, operationKey,
  definition: studioBrowserDefinition(), call: { callId: operationKey, name: 'browser_inspect_workspace', arguments: args },
  signal: new AbortController().signal });

async function owner(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-browser-owner-')), root = join(directory, 'workspace'), evidenceRoot = join(directory, 'evidence');
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'index.html'), '<button id="start">Start</button>');
  writeFileSync(join(root, 'app', 'app.js'), 'initial');
  const trace = [], refs = new Map(), gone = new Set(); let hooks = {}, backendOptions, nextId = 0, disposed = false;
  const fake = {
    browserChannel: 'fixture', browserVersion: 'fixture/v1',
    async open(runId) {
      const ref = validateBrowserSessionRef({ scope, runId, runtimeId: 'owner', workspaceRevision: backendOptions.workspaceRevision, sessionId: `page-${++nextId}` });
      trace.push({ kind: 'open', ref }); refs.set(runId, ref); return ref;
    },
    async act(ref, action, { signal, observeAction }) {
      trace.push({ kind: 'act', ref, action });
      hooks.observe?.(action, observeAction);
      await hooks.act?.(ref, action, signal);
      signal.throwIfAborted();
      if (action.kind === 'navigate') {
        assert.equal(backendOptions.networkPolicy(ref, action.url), true);
        const response = await fetch(action.url, { signal }); assert.equal(response.status, 200); assert.match(await response.text(), /button/);
      }
      const contentRef = await backendOptions.artifactSink(ref, png, 'image/png');
      return validateBrowserObservation({ sessionRef: ref, actionId: action.actionId,
        actionSeq: trace.filter(row => row.kind === 'act' && canonical(row.ref) === canonical(ref)).length,
        status: 'ok', complete: true, retryability: 'safe', viewport: [1280, 720], text: 'observed page',
        screenshot: { contentRef, width: 1, height: 1, contentBlock: { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } } },
        ...hooks.observation?.(ref, action),
      });
    },
    async recover(ref) { trace.push({ kind: 'recover', ref }); return hooks.recover?.(ref) ?? {
      status: gone.has(ref.runId) ? 'lost' : 'reconnected', sessionRef: ref, lastActionSeq: 1, reason: null, reobserveAvailable: false }; },
    async restart(ref) { trace.push({ kind: 'restart', ref }); const next = { ...ref, generation: ref.generation + 1, leaseEpoch: ref.leaseEpoch + 1 };
      refs.set(ref.runId, next); gone.delete(ref.runId); return { status: 'restarted', sessionRef: next, lastActionSeq: 0, reason: null, reobserveAvailable: false }; },
    async close(ref) { trace.push({ kind: 'close', ref }); }, async dispose() { disposed = true; },
  };
  const createBrowser = config => { backendOptions = config; return fake; };
  const port = await createStudioBrowserWorkspacePort({ scope, root, runtimeId: 'owner', createBrowser,
    evidenceRoot, reobserveAfterLoss: true, sleep: async (_ms, signal) => signal.throwIfAborted(), ...options });
  t.after(async () => { try { await port.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  return { port, root, evidenceRoot, trace, gone, fake, refs, get backendOptions() { return backendOptions; },
    hooks(value) { hooks = value; }, get disposed() { return disposed; } };
}

test('trusted combined vision deadline preserves strict full formal admission at the browser owner', async t => {
  const h = await owner(t, { toolTimeoutMs: 261000 });
  assert.equal(h.port.definition.timeoutMs, 261000);
  const original = request('vision-page');
  assert.equal((await h.port.execute(original)).content.code, 'scope_or_tool_mismatch');
  const bound = { ...original, definition: h.port.definition };
  const ok = await h.port.execute(bound);
  assert.equal(ok.status, 'ok'); assert.ok(ok.browserObservation.screenshot);
  const forged = { ...bound, definition: { ...bound.definition, description: 'foreign' } };
  const count = h.trace.length;
  assert.equal((await h.port.execute(forged)).content.code, 'scope_or_tool_mismatch');
  assert.equal(h.trace.length, count, 'changing a non-timeout formal field cannot execute');
});

test('workspace browser persists bounded action diagnostics without changing uncertainty or authorizing a replay', async t => {
  const h=await owner(t);
  h.hooks({observe(action,observer){observer({contract:'browser-action-observation/v1',actionId:action.actionId,
    kind:action.kind,phase:'capture_screenshot',dispatchStarted:true,dispatchCompleted:true,
    elapsedMs:action.timeoutMs,timeoutMs:action.timeoutMs,outcome:'timeout',errorCode:'action_timed_out'});},
    observation(){return {status:'uncertain',complete:false,retryability:'requires_reconcile',errorCode:'action_timed_out',screenshot:null};}});
  const out=await h.port.execute(request('diagnostic'));
  assert.equal(out.status,'uncertain');assert.equal(out.browserObservation.complete,false);
  assert.equal(out.metadata.browserActionObservations.length,1);
  assert.equal(out.content.browser_action_diagnostic.phase,'capture_screenshot');
  assert.equal(out.content.browser_action_diagnostic.dispatch_completed,true);
  assert.equal(out.context.content,canonical(out.content));
  const again=await h.port.execute(request('next'));
  assert.equal(again.content.code,'browser_session_lost');
  assert.deepEqual(again.content.required_actions,[{type:'reload'}]);
  assert.equal(h.trace.filter(row=>row.kind==='act').length,1,'Diagnostics do not replay the original action');
});

test('private-page isolation requires confirmed close, and a legacy definition never opts in implicitly', async t => {
  const h = await owner(t);
  h.hooks({ observation(_ref, action) { return action.kind === 'click'
    ? { status: 'uncertain', complete: false, retryability: 'requires_reconcile', errorCode: 'action_timed_out', screenshot: null } : {}; } });
  const input = { ...baseInput, actions: [{ type: 'click', selector: '#start' }] };
  const legacy = request('legacy', input, 'legacy'); delete legacy.definition.recoveryPolicy;
  const before = await h.port.execute(legacy);
  assert.equal(before.status, 'uncertain'); assert.equal(before.browserIsolation, undefined);
  assert.equal(h.trace.some(row => row.kind === 'close'), false);
  const close = h.fake.close;
  h.fake.close = async () => { throw new Error('close failed'); };
  const failed = await h.port.execute(request('failed-close', input));
  assert.equal(failed.status, 'uncertain'); assert.equal(failed.browserIsolation, undefined);
  assert.throws(() => h.backendOptions.artifactSink(failed.browserSessionRef, png, 'image/png'), { code: 'screenshot_target_unavailable' });
  h.fake.close = close;
  const isolated = await h.port.execute(request('confirmed-close', input, 'confirmed'));
  assert.equal(isolated.status, 'uncertain'); assert.equal(isolated.browserIsolation.fenced, true);
  assert.equal(isolated.browserIsolation.operationKey, 'confirmed-close');
  assert.equal(isolated.content.resource_continuity.fresh_observation_required, true);
  assert.equal(h.trace.filter(row => row.kind === 'close' && row.ref.runId === 'confirmed').length, 1);
  const lost = await h.port.execute(request('no-implicit-replay', baseInput, 'confirmed'));
  assert.equal(lost.content.code, 'browser_session_lost');
  h.hooks({});
  const fresh = await h.port.execute(request('new-observation', { ...baseInput, actions: [{ type: 'reload' }] }, 'confirmed'));
  assert.equal(fresh.status, 'ok'); assert.equal(fresh.browserSessionRef.generation, 2);
  assert.equal(h.trace.filter(row => row.kind === 'act' && row.ref.runId === 'confirmed' && row.action.kind === 'click').length, 1);
});

for (const backend of ['memory', 'sqlite']) for (const crash of [false, true]) {
  test(`${backend}: isolated unknown input continues under one budget${crash ? ' after cold restore' : ''}, without replay or stale acceptance`, async t => {
    const h = await owner(t), file = join(h.evidenceRoot, 'isolation.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(file) : new MemoryRunStore();
    t.after(() => store.close?.());
    h.hooks({ observation(_ref, action) { return action.kind === 'click'
      ? { status: 'uncertain', complete: false, retryability: 'requires_reconcile', errorCode: 'action_timed_out', screenshot: null } : {}; } });
    const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
    const config = configure({ profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'v1' },
      hostBindingDigest: 'fixture-owner', tools: [studioBrowserDefinition()], contract: { objective: 'inspect page' },
      limits: { maxModelCalls: 6, maxRecoveryRetries: 1 } });
    const snapshot = initialSnapshot({ scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config, digest(config));
    let models = 0;
    const ports = { browser: h.port, tools: h.port, model: { generate: async () => {
      models++;
      if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'original',
        name: 'browser_inspect_workspace', arguments: { ...baseInput, actions: [{ type: 'click', selector: '#start' }, { type: 'press', key: 'Enter' }] } }] };
      h.hooks({});
      if (models === 3) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'fresh',
        name: 'browser_inspect_workspace', arguments: { ...baseInput, actions: [{ type: 'reload' }] } }] };
      return { kind: 'final_candidate', text: models === 2 ? 'claims success without observation' : 'freshly observed', usage: emptyUsage(), toolCalls: [] };
    } } };
    const first = new NativeKernel({ store, digest, owner: 'first', now: () => 1, ports,
      ...(crash ? { onCheckpoint: async state => { if (state.recoveryRetriesUsed === 1) throw new Error('crash after isolation receipt'); } } : {}) });
    first.start(snapshot, config);
    let finished;
    if (crash) {
      await assert.rejects(first.runUntilIdle(scope, 'run'), /crash after isolation receipt/);
      if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(file); }
      const next = new NativeKernel({ store, digest, owner: 'next', now: () => 100, ports });
      finished = await next.runUntilIdle(scope, 'run');
    } else finished = await first.runUntilIdle(scope, 'run');
    assert.equal(finished.phase, 'completed'); assert.equal(finished.finalText, 'freshly observed');
    assert.equal(finished.recoveryRetriesUsed, 1); assert.equal(finished.usage.toolCalls, 2);
    assert.equal(models, 4); assert.deepEqual(finished.browserReobservationRefs, []);
    assert.equal(finished.lastBrowserObservation.sessionRef.generation, 2);
    const record = store.load(scope, 'run');
    const uncertain = record.receipts.find(row => row.result.results?.some(value => value.browserIsolation));
    assert.equal(uncertain.status, 'committed', 'the owner response is durably received');
    assert.equal(uncertain.result.results[0].status, 'uncertain', 'the original action outcome remains unknown');
    assert.equal(record.events.filter(row => row.kind === 'browser.candidate_rejected').length, 1);
    const isolated = record.events.find(row => row.kind === 'browser.isolated');
    assert.equal(isolated.payload.continued, true); assert.equal(isolated.payload.originalActionOutcome, 'unknown');
    assert.equal(h.trace.filter(row => row.kind === 'act' && row.action.kind === 'click').length, 1);
    assert.equal(h.trace.filter(row => row.kind === 'act' && row.action.kind === 'press').length, 0);
    assert.equal(h.trace.filter(row => row.kind === 'restart').length, 1);
  });
}

test('foreign or overbroad browser diagnostics cannot leak arbitrary backend data into a tool receipt', async t => {
  const h=await owner(t);
  h.hooks({observe(action,observer){const fact={contract:'browser-action-observation/v1',actionId:action.actionId,
    kind:action.kind,phase:'publish',dispatchStarted:true,dispatchCompleted:true,elapsedMs:1,
    timeoutMs:action.timeoutMs,outcome:'ok',errorCode:null};
    observer({...fact,actionId:'foreign'});observer({...fact,url:'https://invalid/?token=secret'});
    observer({...fact,phase:'secret page contents'});observer({...fact,dispatchStarted:false});
  }});
  const out=await h.port.execute(request('foreign-diagnostic'));
  assert.equal(out.status,'ok');assert.equal(out.metadata.browserActionObservations,undefined);
  assert.equal(out.content.browser_action_diagnostic,undefined);
  assert.doesNotMatch(JSON.stringify(out.metadata),/secret|foreign/);
});

test('resource retirement fences one run, rejects late artifacts and old actions, and preserves another run',async t=>{
 const h=await owner(t);const first=await h.port.execute(request('first'));
 const second=await h.port.execute(request('second',baseInput,'other'));
 const before=h.trace.filter(row=>row.kind==='act').length;
 const fence=await h.port.retireResources({scope,sessionId:'session',runId:'run',refs:[first.browserSessionRef]});
 assert.equal(fence.fenced,true);assert.equal(fence.externalEffects,false);assert.equal(fence.oldActionsReplayed,false);
 assert.equal(h.backendOptions.networkPolicy(first.browserSessionRef,'http://127.0.0.1/'),false);
 assert.throws(()=>h.backendOptions.artifactSink(first.browserSessionRef,png,'image/png'),/screenshot_target_unavailable/);
 const old=await h.port.execute(request('old-retry',{...baseInput,actions:[{type:'reload'}]}));
 assert.equal(old.content.code,'browser_run_retired');assert.equal(old.content.executed,false);
 assert.equal(h.trace.filter(row=>row.kind==='act').length,before);
 assert.equal((await h.port.recoverSessions({refs:[first.browserSessionRef]}))[0].reobserveAvailable,false);
 assert.equal((await h.port.execute(request('other-still-live',baseInput,'other'))).status,'ok');
 assert.equal(h.trace.filter(row=>row.kind==='close'&&row.ref.runId==='other').length,0);
 assert.equal(second.browserSessionRef.runId,'other');
});

test('cold owners can fence a lost namespace without creating or replaying a browser page',async t=>{
 const h=await owner(t),first=await h.port.execute(request('first'));await h.port.close();let actions=0;
 const cold=await createStudioBrowserWorkspacePort({scope,root:h.root,runtimeId:'owner',createBrowser:()=>({
  open:async()=>{actions++;assert.fail('Retirement cannot open a page');},act:async()=>assert.fail('No old input replay'),
  recover:async ref=>({status:'lost',sessionRef:ref,lastActionSeq:0,reason:'owner_unavailable'}),
  restart:async()=>assert.fail('No replacement page'),close:async()=>{},
 })});t.after(()=>cold.close());
 const fence=await cold.retireResources({scope,sessionId:'session',runId:'run',refs:[first.browserSessionRef]});
 assert.equal(fence.fenced,true);assert.equal(actions,0);
 await assert.rejects(cold.retireResources({scope,sessionId:'session',runId:'foreign',refs:[first.browserSessionRef]}),/browser_reference_scope_mismatch/);
});

test('a failed resource close cannot issue a fence proof, and subsequent actions remain disabled',async t=>{
 const h=await owner(t),first=await h.port.execute(request('first'));const close=h.fake.close;
 h.fake.close=async()=>{throw Error('close failed');};
 await assert.rejects(h.port.retireResources({scope,sessionId:'session',runId:'run',refs:[first.browserSessionRef]}),/close failed/);
 assert.equal((await h.port.execute(request('late'))).content.code,'browser_run_retired');
 h.fake.close=close;
 assert.equal((await h.port.retireResources({scope,sessionId:'session',runId:'run',refs:[first.browserSessionRef]})).fenced,true);
});

test('host governance does not change the browser execution protocol, while forged effects and unknown metadata stay rejected', async t => {
  const h = await owner(t), original = request('governed-page');
  const governed = { ...original, definition: { ...original.definition, approvalPolicy: 'durable-preflight/v1',
    executionTimeoutPolicy: 'dispatch/v2', modelGuidance: ['Use the admitted page.'] } };
  const result = await h.port.execute(governed);
  assert.equal(result.status, 'ok'); assert.ok(result.browserObservation);
  const count = h.trace.length;
  for (const fields of [{ permissions: ['workspace:write'] }, { timeoutMs: 1 }, { approvalPolicy: 'unknown-policy' },
    { arbitraryMetadata: true }, { parameters: { type: 'object', properties: {} } }]) {
    const refused = await h.port.execute({ ...governed, definition: { ...governed.definition, ...fields } });
    assert.equal(refused.content.code, 'scope_or_tool_mismatch'); assert.equal(refused.content.executed, false);
  }
  assert.equal(h.trace.length, count);
});

test('expired Native authority during a browser action blocks screenshot publication and later actions', async t => {
  const h = await owner(t);
  let current = true;
  h.hooks({ act: async (_ref, action) => { if (action.kind === 'navigate') current = false; } });
  const result = await h.port.execute({ ...request('stale-action', { ...baseInput, actions: [{ type: 'click', selector: '#start' }] }),
    assertCurrent: () => current });
  assert.equal(result.status, 'uncertain');
  assert.equal(h.trace.filter(row => row.kind === 'act').length, 1);
  assert.equal(existsSync(join(h.root, '.artifacts', 'browser-check.png')), false);
});

test('the public schema and parser agree on the complete Studio action protocol', () => {
  const actions = [{ type: 'click', selector: '#start', button: 'right', duration_ms: 20 }, { type: 'fill', element_ref: 'e1', value: '你好' },
    { type: 'press', key: 'Enter' }, { type: 'move', x: 1279, y: 719, steps: 30 },
    { type: 'scroll', delta_x: -10000, delta_y: 10000, x: 0, y: 0 }, { type: 'reload' }, { type: 'wait', ms: 100 }];
  const definition = studioBrowserDefinition(), validate = compileToolInput(definition.parameters);
  assert.equal(validate({ ...baseInput, actions }), true, JSON.stringify(validate.errors));
  const normalized = parse(actions);
  assert.deepEqual(normalized.actions.map(row => row.kind), ['click', 'fill', 'press', 'move', 'scroll', 'reload', 'wait']);
  assert.equal(normalized.actions[1].value, '你好'); assert.equal(normalized.actions[2].selector, 'body');
  assert.equal(normalized.actions[0].actionId, 'operation:1');
  assert.equal(definition.observationRole, 'browser'); assert.equal(definition.readOnly, false); assert.equal(definition.concurrentSafe, false);
  assert.doesNotThrow(() => configure({ profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'v1' },
    hostBindingDigest: 'host', contract: { objective: 'check page' }, tools: [definition] }));
  assert.equal(parse([]).screenshotPath, '.artifacts/browser-check.png');
});
test('cold verification submits concrete navigation/capture/click actions to Host authority and always closes a denied page', async t => {
  const fixture = await owner(t), accepted = [];
  fixture.hooks({ observation: () => ({ controls: [{ tag: 'button', label: 'Start', selector: '#start', clickable: true }] }) });
  await assert.rejects(fixture.port.verifyPage({ runId: 'run', entryPath: 'app', candidateId: 'candidate',
    signal: new AbortController().signal, executeAction: async ({ entryPath, action }, dispatch) => {
      assert.equal(entryPath, 'app/index.html'); accepted.push(action.kind);
      if (action.kind === 'click') throw new Error('Host denied click');
      return dispatch(new AbortController().signal);
    } }), /Host denied click/);
  assert.deepEqual(accepted, ['navigate', 'screenshot', 'click']);
  assert.equal(fixture.trace.filter(row => row.kind === 'act').some(row => row.action.kind === 'click'), false);
  assert.equal(fixture.trace.filter(row => row.kind === 'close').length, 1);
});

test('malformed later actions, ambiguous targets, sparse batches and invalid numeric values are rejected as one batch', () => {
  const invalid = [{ type: 'click' }, { type: 'click', selector: '#s', element_ref: 'e1' }, { type: 'fill', selector: '#s', value: 12 },
    { type: 'press', key: 5 }, { type: 'click', selector: '#s', button: 'unexpected' }, { type: 'move', x: true, y: 0 },
    { type: 'move', x: 1280, y: 0 }, { type: 'move', x: 0, y: 0, steps: null }, { type: 'scroll', delta_x: 0, delta_y: 1, x: 0 },
    { type: 'scroll', delta_x: 0.5, delta_y: 0 }, { type: 'wait', ms: 10001 }, { type: 'reload', selector: '#s' },
    { type: 'click', selector: '#s', duration_ms: 5001 }, { type: 'navigate', url: 'https://outside.invalid' }];
  const validate = compileToolInput(studioBrowserDefinition().parameters);
  for (const action of invalid) {
    assert.equal(validate({ ...baseInput, actions: [action] }), false, JSON.stringify(action));
    assert.throws(() => parse([{ type: 'click', selector: '#start' }, action]), { code: 'browser_action_invalid' });
  }
  assert.throws(() => parse(Array(1)), { code: 'browser_action_invalid' });
  assert.throws(() => parse(Array.from({ length: 21 }, () => ({ type: 'reload' }))), { code: 'browser_actions_invalid' });
});

test('path, screenshot and total explicit wait constraints are checked without coercion', () => {
  for (const path of ['', '../page.html', '/page.html', 'a\\page.html', 'a\0.html']) assert.throws(() => parse([], { path }), { code: 'workspace_path_invalid' });
  for (const screenshot_path of [null, false, '../x.png', '/x.png', 'x.jpg']) assert.throws(() => parse([], { screenshot_path }), { code: 'screenshot_path_invalid' });
  assert.equal(parse([{ type: 'wait', ms: 10000 }, { type: 'wait', ms: 10000 }], { wait_ms: 10000 }).actions.length, 2);
  assert.throws(() => parse([{ type: 'wait', ms: 10000 }], { wait_ms: 20001 }), { code: 'browser_action_time_budget_exceeded' });
  for (const wait_ms of [null, true, '10', -1]) assert.throws(() => parse([], { wait_ms }), { code: 'browser_wait_invalid' });
  assert.throws(() => parse([], { unknown: 'field' }), { code: 'browser_input_invalid' });
});

test('invalid batches, screenshot escapes and spoofed capabilities open no page and execute no earlier input', async t => {
  const o = await owner(t);
  const cases = [{ ...baseInput, actions: [{ type: 'click', selector: '#start' }, { type: 'fill', selector: '#name', value: 2 }] },
    { ...baseInput, screenshot_path: '../outside.png' }, { ...baseInput, path: '../outside.html' }];
  symlinkSync(o.evidenceRoot, join(o.root, 'escape'));
  cases.push({ ...baseInput, screenshot_path: 'escape/image.png' });
  for (const args of cases) assert.equal((await o.port.execute(request('invalid', args))).status, 'error');
  assert.equal((await o.port.execute({ ...request('foreign'), scope: { ...scope, userId: 'other' } })).status, 'error');
  assert.equal((await o.port.execute({ ...request('forged'), definition: { ...studioBrowserDefinition(), readOnly: true } })).status, 'error');
  assert.equal(o.trace.length, 0);
});

test('successive calls keep one page, each run gets a separate origin, and captures become typed model media', async t => {
  const o = await owner(t);
  const first = await o.port.execute(request('first', { ...baseInput, actions: [{ type: 'click', selector: '#start' }] }));
  const second = await o.port.execute(request('second')), other = await o.port.execute(request('other', baseInput, 'run-2'));
  assert.equal(first.status, 'ok'); assert.equal(second.status, 'ok'); assert.equal(other.status, 'ok');
  assert.equal(o.trace.filter(row => row.kind === 'open').length, 2);
  assert.deepEqual(second.browserSessionRef, first.browserSessionRef); assert.notEqual(other.browserSessionRef.sessionId, first.browserSessionRef.sessionId);
  assert.equal(o.trace.filter(row => row.kind === 'act' && row.action.kind === 'navigate').length, 2);
  const urls = o.trace.filter(row => row.kind === 'act' && row.action.kind === 'navigate').map(row => row.action.url);
  assert.notEqual(new URL(urls[0]).origin, new URL(urls[1]).origin);
  assert.equal(o.backendOptions.networkPolicy(first.browserSessionRef, urls[1]), false);
  assert.equal(o.backendOptions.networkPolicy({ ...first.browserSessionRef, generation: 2 }, urls[0]), false);
  assert.deepEqual(readFileSync(join(o.root, '.artifacts', 'browser-check.png')), png);
  assert.deepEqual(second.context.media, [second.browserObservation.screenshot.contentBlock]);
  assert.equal(second.content.page_navigation_reason, 'none'); assert.equal(second.browserObservation.complete, true);
  assert.match(second.metadata.progressObservationDigest, /^sha256:[a-f0-9]{64}$/);
});

test('source edits reload the app while generated captures do not dirty the served revision', async t => {
  const o = await owner(t);
  await o.port.execute(request('open', { ...baseInput, screenshot_path: 'app/capture.png' }));
  const unchanged = await o.port.execute(request('unchanged', { ...baseInput, screenshot_path: 'app/capture.png' }));
  assert.equal(unchanged.content.page_navigation_reason, 'none');
  writeFileSync(join(o.root, 'app', 'app.js'), 'updated application');
  const changed = await o.port.execute(request('updated', { ...baseInput, screenshot_path: 'app/capture.png' }));
  assert.equal(changed.content.page_navigation_reason, 'source_changed');
  assert.equal(o.trace.filter(row => row.kind === 'act' && row.action.kind === 'navigate').length, 2);
});

test('recovery only probes; a lost page requires isolated explicit reload and never replays old actions', async t => {
  const o = await owner(t), initial = await o.port.execute(request('initial', { ...baseInput, actions: [{ type: 'click', selector: '#start' }] }));
  o.gone.add('run'); const before = o.trace.filter(row => row.kind === 'act').length;
  const reports = await o.port.recoverSessions({ refs: [initial.browserSessionRef], runId: 'run' });
  assert.equal(reports[0].status, 'lost'); assert.equal(reports[0].reobserveAvailable, true);
  assert.equal(o.trace.filter(row => row.kind === 'act').length, before); assert.equal(o.trace.some(row => row.kind === 'restart'), false);
  for (const actions of [[], [{ type: 'click', selector: '#start' }], [{ type: 'reload' }, { type: 'click', selector: '#start' }]]) {
    const rejected = await o.port.execute(request('stale', { ...baseInput, actions }));
    assert.equal(rejected.content.code, 'browser_session_lost'); assert.equal(rejected.status, 'error');
  }
  const fresh = await o.port.execute(request('fresh', { ...baseInput, actions: [{ type: 'reload' }] }));
  assert.equal(fresh.status, 'ok'); assert.equal(fresh.content.page_navigation_reason, 'session_restarted');
  assert.equal(fresh.browserSessionRef.generation, 2); assert.equal(fresh.browserSessionRef.leaseEpoch, 2);
  assert.equal(o.trace.filter(row => row.kind === 'act' && row.action.kind === 'click').length, 1);
  assert.equal(o.trace.filter(row => row.kind === 'restart').length, 1);
});

test('later foreign or malformed recovery reports cannot partially admit an earlier lost owner', async t => {
  const o = await owner(t), first = await o.port.execute(request('first')), second = await o.port.execute(request('second', baseInput, 'other'));
  const refs = [first.browserSessionRef, second.browserSessionRef];
  await assert.rejects(o.port.recoverSessions({ refs: [refs[0], { ...refs[1], scope: { ...scope, agentId: 'foreign' } }] }), { code: 'browser_reference_scope_mismatch' });
  assert.equal(o.trace.filter(row => row.kind === 'recover').length, 0);
  o.hooks({ recover: ref => ({ status: 'lost', sessionRef: ref.runId === 'other' ? { ...ref, generation: 9 } : ref,
    lastActionSeq: 1, reason: 'lost', reobserveAvailable: false }) });
  await assert.rejects(o.port.recoverSessions({ refs }), { code: 'browser_recovery_reference_mismatch' });
  o.hooks({});
  assert.equal((await o.port.execute(request('still-owned'))).status, 'ok');
});

test('an action failure retains earlier diagnostics, stops the rest of a batch, and cannot be hidden by a screenshot', async t => {
  const o = await owner(t);
  o.hooks({ observation: (_ref, action) => action.kind === 'click' ? { status: 'error', errorCode: 'action_failed', pageErrors: ['broken interaction'] } : {} });
  const result = await o.port.execute(request('failure', { ...baseInput, actions: [{ type: 'click', selector: '#start' }, { type: 'press', key: 'Enter' }] }));
  assert.equal(result.status, 'error'); assert.deepEqual(result.content.page_errors, ['broken interaction']);
  assert.equal(o.trace.filter(row => row.kind === 'act' && row.action.kind === 'press').length, 0);
  assert.equal(o.trace.filter(row => row.kind === 'act' && row.action.kind === 'screenshot').length, 0);
  o.hooks({ act: (_ref, action) => { if (action.kind === 'click') throw new Error('private backend details'); } });
  const unknown = await o.port.execute(request('unknown', { ...baseInput, actions: [{ type: 'click', selector: '#start' }] }));
  assert.equal(unknown.status, 'uncertain'); assert.equal(unknown.content.code, 'browser_action_outcome_unknown');
  assert.doesNotMatch(JSON.stringify(unknown), /private backend/); assert.ok(unknown.browserSessionRef);
  const url = o.trace.find(row => row.kind === 'act' && row.action.kind === 'navigate').action.url;
  assert.equal(o.backendOptions.networkPolicy(unknown.browserSessionRef, url), false);
  assert.throws(() => o.backendOptions.artifactSink(unknown.browserSessionRef, png, 'image/png'), { code: 'screenshot_target_unavailable' });
  assert.equal((await o.port.execute(request('unsafe-continuation'))).content.code, 'browser_session_lost');
});

test('only the precise headless pointer-lock warning is nonblocking; other console failures remain failures', async t => {
  const o = await owner(t);
  const warning = 'error: The root document of this element is not valid for pointer lock.';
  o.hooks({ observation: () => ({ console: [warning] }) });
  const tolerated = await o.port.execute(request('warning'));
  assert.equal(tolerated.status, 'ok'); assert.equal(tolerated.content.environment_warnings.length, 2);
  o.hooks({ observation: () => ({ console: ['error: real application failure'] }) });
  const failed = await o.port.execute(request('error')); assert.equal(failed.status, 'error'); assert.equal(failed.content.console_errors.length, 2);
});

test('cold verification uses fresh contexts, external captures and at most one unambiguous launch action', async t => {
  const o = await owner(t), warm = await o.port.execute(request('warm'));
  const launch = { tag: 'button', role: 'button', label: '▶ Start Game', selector: '#start', clickable: true, duplicateId: false };
  o.hooks({ observation: (_ref, action) => ({ controls: [launch], ...(action.kind === 'navigate' ? { pageErrors: ['startup diagnostic'] } : {}) }) });
  const checked = await o.port.verifyPage({ runId: 'run', entryPath: 'app/index.html', candidateId: 'candidate' });
  assert.notEqual(checked.sessionRef.runId, warm.browserSessionRef.runId);
  assert.deepEqual(checked.pageErrors, ['startup diagnostic']);
  const verification = o.trace.filter(row => row.kind === 'act' && row.ref.runId !== 'run');
  assert.deepEqual(verification.map(row => row.action.kind), ['navigate', 'screenshot', 'click', 'screenshot']);
  assert.equal(o.trace.filter(row => row.kind === 'close' && row.ref.runId === checked.sessionRef.runId).length, 1);
  const again = await o.port.verifyPage({ runId: 'run', entryPath: 'app/index.html', candidateId: 'candidate' });
  assert.notEqual(again.sessionRef.runId, checked.sessionRef.runId);
  assert.equal(o.backendOptions.networkPolicy(checked.sessionRef, verification[0].action.url), false);
});

test('duplicate launch IDs reject cold verification without an automatic click', async t => {
  const o = await owner(t);
  o.hooks({ observation: () => ({ controls: [{ tag: 'button', label: '开始游戏', selector: '#start', clickable: true, duplicateId: true }] }) });
  const result = await o.port.verifyPage({ runId: 'run', entryPath: 'app/index.html', candidateId: 'candidate' });
  assert.equal(result.status, 'error'); assert.equal(result.errorCode, 'browser_launch_control_ambiguous');
  assert.equal(o.trace.filter(row => row.kind === 'act' && row.action.kind === 'click').length, 0);
});

test('close interrupts active input, drains ownership locks, releases local servers and is idempotent', async t => {
  const o = await owner(t); let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  o.hooks({ act: async (_ref, action, signal) => {
    if (action.kind !== 'click') return;
    entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = o.port.execute(request('active', { ...baseInput, actions: [{ type: 'click', selector: '#start' }] }));
  await waiting;
  const url = o.trace.find(row => row.kind === 'act' && row.action.kind === 'navigate').action.url;
  const closing = o.port.close(); assert.equal(o.port.close(), closing); await closing;
  assert.equal((await pending).status, 'uncertain'); assert.equal(o.disposed, true);
  assert.equal(o.backendOptions.networkPolicy(o.refs.get('run'), url), false); await assert.rejects(fetch(url));
  await assert.rejects(o.port.execute(request('late')), /browser_owner_closed/);
});

test('an incomplete first observation never authorizes the remaining input batch', async t => {
  const o = await owner(t); o.hooks({ observation: () => ({ complete: false }) });
  const result = await o.port.execute(request('incomplete', { ...baseInput, actions: [{ type: 'click', selector: '#start' }] }));
  assert.equal(result.status, 'error'); assert.equal(result.browserObservation.complete, false);
  assert.equal(o.trace.filter(row => row.kind === 'act').length, 1);
});

test('a borrowed backend reconnect without the local server binding is loss, and external evidence must stay outside the workspace', async t => {
  const o = await owner(t), observed = await o.port.execute(request('observed'));
  const cold = await createStudioBrowserWorkspacePort({ scope, root: o.root, runtimeId: 'owner', createBrowser: () => o.fake, reobserveAfterLoss: true });
  t.after(() => cold.close());
  const report = (await cold.recoverSessions({ refs: [observed.browserSessionRef], runId: 'run' }))[0];
  assert.equal(report.status, 'lost'); assert.equal(report.reason, 'page_binding_unavailable');
  await assert.rejects(cold.verifyPage({ runId: 'run', entryPath: 'app/index.html', candidateId: 'candidate' }), { code: 'browser_verification_evidence_unavailable' });
  await assert.rejects(createStudioBrowserWorkspacePort({ scope, root: o.root, runtimeId: 'owner', createBrowser: () => o.fake,
    evidenceRoot: join(o.root, '.evidence') }), { code: 'browser_verification_evidence_must_be_outside_workspace' });
});

test('same-run operations serialize and a canceled queued input never reaches the backend', async t => {
  const o = await owner(t); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), active = new Promise(resolve => { entered = resolve; });
  o.hooks({ act: async (_ref, action) => { if (action.kind === 'click') { entered(); await gate; } } });
  const first = o.port.execute(request('first', { ...baseInput, actions: [{ type: 'click', selector: '#start' }] }));
  await active;
  const controller = new AbortController();
  const second = o.port.execute({ ...request('queued', { ...baseInput, actions: [{ type: 'press', key: 'Enter' }] }), signal: controller.signal });
  const rejected = assert.rejects(second, /canceled queued input/); controller.abort(new Error('canceled queued input'));
  assert.equal(o.trace.some(row => row.kind === 'act' && row.action.kind === 'press'), false);
  release(); assert.equal((await first).status, 'ok'); await rejected;
  assert.equal(o.trace.filter(row => row.kind === 'open').length, 1);
});

test('request cancellation revokes late network and capture authority until an explicit new generation', async t => {
  const o = await owner(t); let entered;
  const active = new Promise(resolve => { entered = resolve; });
  o.hooks({ act: async (_ref, action, signal) => {
    if (action.kind !== 'click') return;
    entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const controller = new AbortController(), running = o.port.execute({ ...request('canceled', { ...baseInput,
    actions: [{ type: 'click', selector: '#start' }] }), signal: controller.signal });
  await active; controller.abort(new Error('request canceled')); const unknown = await running;
  assert.equal(unknown.status, 'uncertain');
  assert.throws(() => o.backendOptions.artifactSink(unknown.browserSessionRef, png, 'image/png'), { code: 'screenshot_target_unavailable' });
  const report = (await o.port.recoverSessions({ refs: [unknown.browserSessionRef] }))[0];
  assert.equal(report.status, 'lost'); assert.equal(report.reason, 'browser_action_outcome_unknown');
  o.hooks({});
  const fresh = await o.port.execute(request('explicit-reload', { ...baseInput, actions: [{ type: 'reload' }] }));
  assert.equal(fresh.status, 'ok'); assert.equal(fresh.browserSessionRef.generation, 2);
  assert.throws(() => o.backendOptions.artifactSink(unknown.browserSessionRef, png, 'image/png'), { code: 'screenshot_target_unavailable' });
  assert.equal(o.trace.filter(row => row.kind === 'act' && row.action.kind === 'click').length, 1);
});

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: the actual kernel reopens ownership, rejects a stale candidate and admits only an explicit fresh capture`, async t => {
    const o = await owner(t), filename = join(o.evidenceRoot, 'ledger.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
    t.after(() => store.close?.());
    const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
    const config = configure({ profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'v1' },
      hostBindingDigest: 'fixture-owner', tools: [studioBrowserDefinition()], contract: { objective: 'inspect page' }, limits: { maxModelCalls: 8 } });
    const snapshot = initialSnapshot({ scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config, digest(config));
    const first = new NativeKernel({ store, digest, owner: 'first-worker', now: () => 1,
      onCheckpoint: async snapshot => { if (snapshot.browserSessionRefs.length) throw new Error('delivery interrupted after receipt'); },
      ports: { browser: o.port, tools: o.port, model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
        toolCalls: [{ callId: 'old-click', name: 'browser_inspect_workspace', arguments: { ...baseInput, actions: [{ type: 'click', selector: '#start' }] } }] }) } } });
    first.start(snapshot, config);
    await assert.rejects(first.runUntilIdle(scope, 'run'), /delivery interrupted after receipt/);
    const old = store.load(scope, 'run'); assert.equal(old.snapshot.usage.toolCalls, 1); assert.equal(old.snapshot.browserSessionRefs.length, 1);
    if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); }
    o.gone.add('run'); let models = 0;
    const next = new NativeKernel({ store, digest, owner: 'replacement', now: () => 100, ports: {
      browser: o.port, tools: o.port, model: { generate: async () => {
        models++;
        if (models === 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'fresh-only',
          name: 'browser_inspect_workspace', arguments: { ...baseInput, actions: [{ type: 'reload' }] } }] };
        return { kind: 'final_candidate', text: models === 1 ? 'claims page still works' : 'freshly observed', usage: emptyUsage(), toolCalls: [] };
      } },
    } });
    const finished = await next.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
    assert.equal(finished.phase, 'completed'); assert.equal(finished.outcome, 'unverified'); assert.equal(finished.finalText, 'freshly observed');
    assert.deepEqual(finished.browserReobservationRefs, []); assert.equal(finished.lastBrowserObservation.sessionRef.generation, 2);
    assert.equal(finished.usage.toolCalls, 2); assert.equal(models, 3);
    assert.ok(record.events.some(event => event.kind === 'browser.candidate_rejected'));
    assert.equal(o.trace.filter(row => row.kind === 'act' && row.action.kind === 'click').length, 1);
    assert.equal(o.trace.filter(row => row.kind === 'restart').length, 1);
    assert.equal(record.receipts.filter(receipt => receipt.result.browserObservation).length > 0
      || record.receipts.some(receipt => Array.isArray(receipt.result.results) && receipt.result.results.some(result => result.browserObservation)), true);
  });
}
