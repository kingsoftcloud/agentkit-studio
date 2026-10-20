/** Actual DSH ToolRuntime + attachments + production browser binding; no SDK source edits. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { studioBrowserDefinition } from '../packages/agentkit-harness/src/native/browser-workspace-protocol.mjs';
import { NativeKernel, MemoryRunStore, canonical, configure, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, chromium: { type: 'string' } } });
assert.ok(values.source && values.chromium, 'Use --source <built maintained DSH checkout> --chromium <executable>');
const source = resolve(values.source), require = createRequire(join(source, 'packages/core/tools/package.json'));
const load = path => import(pathToFileURL(join(source, path, 'lib/index.js')).href);
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const [{ default: SystemPrompt }, { default: ToolRuntime }, { LocalAttachmentStore }] = await Promise.all([
  load('packages/core/system-prompt'), load('packages/core/tools'), load('packages/attachment/attachment-local'),
]);
const root = await mkdtemp(join(tmpdir(), 'native-dsh-browser-')), workspaceRoot = join(root, 'workspace');
const ctx = new Context(), scope = { tenantId: 'test', workspaceId: 'test', userId: 'test', agentId: 'test' };
const agent = { session: { id: 'session' } }, definition = studioBrowserDefinition();
let gateway, deny = false, guardDeny = false, omitImage = false;
const trace = [], results = [];
const binding = () => createNativeDshTools({ ctx, workspaceRoot, stateDir: join(root, 'state'),
  browserExecutablePath: resolve(values.chromium), config: { toolBindings: [definition.name] } });
const request = (operationKey, actions = [], runId = 'direct') => ({ scope, runId, sessionId: 'session',
  turnId: '1', buildId: 'proof', parentRunId: null, taskChainId: 'proof', operationKey,
  definition, call: { callId: operationKey, name: definition.name, arguments: { path: 'app', wait_ms: 0, actions } },
  signal: new AbortController().signal, interaction: null });
try {
  await mkdir(join(workspaceRoot, 'app'), { recursive: true });
  await writeFile(join(workspaceRoot, 'app/index.html'), '<!doctype html><button id="count">Clicked 0</button><script>let n=0; document.querySelector("#count").onclick=e=>e.target.textContent="Clicked "+(++n)</script>');
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  new LocalAttachmentStore(ctx, { dshHome: join(root, 'attachments') });
  ctx.on('tools/pre-execute', async (_exec, next) => {
    trace.push('pre'); return deny ? { kind: 'deny', reason: 'Browser denied by Host policy' } : next();
  });
  ctx.on('tools/execute', async (_exec, next) => { trace.push('around'); return next(); });
  ctx.tools.guard(() => guardDeny ? 'Browser denied by Host guard' : undefined);
  ctx.on('tools/post-execute', async (_exec, _result, next) => {
    trace.push('post'); return omitImage ? { kind: 'accept', content: [{ type: 'text', text: 'Host omitted the screenshot' }] } : next();
  });
  ctx.on('tools/result', (_exec, result) => { trace.push('result'); results.push(result); });
  gateway = binding();
  assert.equal(gateway.definitions(agent, [definition])[0].observationRole, 'browser');
  deny = true;
  const denied = await gateway.forAgent(agent).tools.execute(request('denied', [{ type: 'click', selector: '#count' }]));
  assert.equal(denied.status, 'error'); assert.equal(denied.browserSessionRef, undefined);
  assert.equal(trace.includes('around'), false);
  await assert.rejects(readFile(join(workspaceRoot, '.artifacts/browser-check.png')), { code: 'ENOENT' });
  deny = false; guardDeny = true; trace.length = 0;
  const guarded = await gateway.forAgent(agent).tools.execute(request('guard-denied', [{ type: 'click', selector: '#count' }]));
  assert.equal(guarded.status, 'error'); assert.equal(guarded.browserSessionRef, undefined);
  assert.equal(trace.includes('around'), false);
  guardDeny = false; trace.length = 0;
  const observed = await gateway.forAgent(agent).tools.execute(request('click', [{ type: 'click', selector: '#count' }]));
  assert.equal(observed.status, 'ok', JSON.stringify(observed.content));
  assert.equal(observed.content.ok, true); assert.match(canonical(observed.content), /Clicked 1/);
  assert.equal(observed.context.media.length, 1);
  assert.deepEqual(trace, ['pre', 'around', 'post', 'result']);
  const publicImage = results.at(-1).content.find(block => block.type === 'image');
  assert.ok(publicImage); assert.equal(JSON.stringify(publicImage).includes('base64'), false);
  const attachments = ctx.get('attachments');
  assert.deepEqual(Buffer.from((await attachments.readImageRequest(publicImage.attachment, {
    width: publicImage.attachment.width, height: publicImage.attachment.height, maxBytes: 2 * 1024 * 1024,
  })).data),
    Buffer.from(observed.context.media[0].image_url.url.split(',')[1], 'base64'));
  const image = await readFile(join(workspaceRoot, '.artifacts/browser-check.png'));
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  omitImage = true;
  const redacted = await gateway.forAgent({ session: { id: 'session' } }).tools.execute(request('redacted'));
  assert.equal(redacted.status, 'ok'); assert.match(canonical(redacted.content), /Clicked 1/);
  assert.equal(redacted.context.media, undefined);
  assert.equal(redacted.context.content, 'Host omitted the screenshot');
  assert.deepEqual(redacted.browserSessionRef, observed.browserSessionRef);
  omitImage = false;

  const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
  const configuration = configure({ profile: { profileId: 'proof', profileVersion: '1', providerFamily: 'proof', compatibilityDigest: 'proof/v1' },
    contract: { objective: 'Inspect the browser; visual acceptance remains unverified.' }, hostBindingDigest: 'dsh-browser/v1', tools: [definition] });
  const store = new MemoryRunStore(); let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'dsh-browser-proof', ports: {
    ...gateway.forAgent(agent), model: { generate: async input => {
      if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
        callId: 'click', name: definition.name, arguments: request('kernel').call.arguments,
      }] };
      const tool = input.messages.find(message => message.role === 'tool');
      assert.equal(tool.media.length, 1); assert.match(tool.content, /Clicked 0/);
      return { kind: 'final_candidate', text: 'Actual browser image received.', toolCalls: [], usage: emptyUsage() };
    } },
  } });
  kernel.start({ scope, runId: 'kernel', sessionId: 'session', turnId: '1', buildId: 'proof', taskChainId: 'proof', parentRunId: null }, configuration);
  const done = await kernel.runUntilIdle(scope, 'kernel');
  assert.equal(done.phase, 'completed'); assert.equal(done.outcome, 'unverified'); assert.equal(models, 2);
  assert.equal(store.load(scope, 'kernel').snapshot.browserSessionRefs.length, 1);

  await gateway.close(); gateway = binding();
  const restored = gateway.forAgent({ session: { id: 'session' } });
  const probe = await restored.browser.recoverSessions({ ...request('probe'), refs: [observed.browserSessionRef] });
  assert.equal(probe[0].status, 'lost'); assert.equal(probe[0].reobserveAvailable, true);
  const refused = await restored.tools.execute(request('old-input', [{ type: 'click', selector: '#count' }]));
  assert.equal(refused.status, 'error');
  const fresh = await restored.tools.execute(request('reload', [{ type: 'reload' }]));
  assert.equal(fresh.status, 'ok', JSON.stringify(fresh.content));
  assert.equal(fresh.browserSessionRef.generation, observed.browserSessionRef.generation + 1);
  assert.equal(fresh.browserSessionRef.leaseEpoch, observed.browserSessionRef.leaseEpoch + 1);
  assert.match(canonical(fresh.content), /Clicked 0/);
  process.stdout.write('PASS: actual DSH registry pre/guard/around/post/result policy, Node browser launch, persisted attachments, policy omission, Native next-model image, and restored owner requiring explicit reload\n');
} finally { await gateway?.close(); await rm(root, { recursive: true, force: true }); }
