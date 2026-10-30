import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioNativeHarness } from '../src/host/services/native-harness.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { nativeOwnershipHost } from './fixtures/native-ownership-host.mjs';

test('actual Studio task uses execution-owned facts, a complete small Skill directory and workspace pixels through SQLite and HTTP projection', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'studio-model-surface-')), workspaceRoot = join(root, 'work');
  mkdirSync(workspaceRoot);
  const image = new PNG({ width: 256, height: 256 }); let seed = 12345;
  for (let i = 0; i < image.data.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; image.data[i] = seed & 255; }
  const pixels = PNG.sync.write(image); assert.ok(pixels.length > 65536);
  writeFileSync(join(workspaceRoot, 'sample.png'), pixels);
  const skills = Array.from({ length: 18 }, (_, index) => {
    const name = `skill-${String(index).padStart(2, '0')}`, directory = join(root, name); mkdirSync(directory);
    const content = `---\nname: ${name}\ndescription: useful skill ${index}\n---\nPRIVATE_INSTRUCTIONS_${index}`;
    writeFileSync(join(directory, 'SKILL.md'), content);
    return { name, content, path: join(directory, 'SKILL.md'), resourceBase: { kind: 'directory', path: directory } };
  });
  const store = new SqliteRunStore(join(root, 'runs.sqlite')), agents = createAgentStore({ storeDir: root });
  const record = await agents.create({ name: 'Model surface', runtimeType: 'harness', spec: {
    bindings: { modelProfileIds: ['model'], tools: ['read_workspace_file'] } } });
  const registry = new Map(), events = [], projections = new Map(); let attachments = 0, toolException;
  const services = { sessions: { flush: async () => true }, llm: {}, sessionProjections: {
    register(definition) { projections.set(definition.key, definition); return () => projections.delete(definition.key); },
    stateOf(_session, key) { const definition = projections.get(key); return definition ? events.reduce(definition.apply, definition.init()) : undefined; },
  }, attachments: { imageLimits: { maxImageBytes: 1024 * 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4 * 1024 * 1024,
    mediaTypes: ['image/png'] }, readImageRequest: async () => ({ mediaType: 'image/png', data: pixels }),
    saveImages: async images => { attachments += images.length;
    return images.map((image, index) => ({ attachmentId: `image-${index}`, mediaType: image.mediaType,
      bytes: image.data.length, width: 256, height: 256 })); } } };
  const ctx = { get: key => services[key], effect: install => install(), tools: {
    resultRetentions: ['caller/v1'], register(definition) { registry.set(definition.name, definition); return () => registry.delete(definition.name); },
    async execute(input) { try { const definition = registry.get(input.name), value = await definition.execute(input.arguments, input);
      return { isError: false, value, content: definition.output.render(input.arguments, value) }; }
      catch (error) { toolException = error.stack; throw error; } },
  } };
  const gateway = createNativeDshTools({ ctx, config: { agentId: record.metadata.id, toolBindings: ['read_workspace_file', 'browser_inspect_workspace'],
    toolContracts: [{ name: 'read_workspace_file', executor: 'builtin' }, { name: 'browser_inspect_workspace', executor: 'builtin' }], skillDefinitions: skills }, workspaceRoot,
  stateDir: join(root, 'state'), commandEnvironment: { KSADK_BROWSER_EXECUTABLE_PATH: join(root, 'not-installed-browser') } });
  const models = createModelService({ configuration: { resolve: async () => ({ values: { modelProfiles: [{ id: 'model',
    provider: 'openai-compatible', modelName: 'vision-test', baseUrl: 'https://model.invalid/v1', input: ['text', 'image'] }] } }) },
  credentials: { resolve: async () => ({ value: 'fixture-credential' }) } });
  const bodies = [];
  const host = await createStudioNativeHarness({ ctx, storeDir: root, workspaceRoot, agents, models, ledger: store,
    agentEvents: () => ({ emit() {} }),
    renderPrompt: () => 'Inspect the supplied workspace image.', fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body);
      const first = bodies.length === 1, delta = first ? { tool_calls: [{ index: 0, id: 'image-read', type: 'function',
        function: { name: 'read_workspace_file', arguments: '{"path":"sample.png"}' } }] } : { content: 'Workspace pixels inspected.' };
      return new Response(`data: ${JSON.stringify({ id: `response-${bodies.length}`, choices: [{ index: 0, delta,
        finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.after(async () => { await host.close(); await gateway.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const session = { id: 'surface-session', append: (type, data, options) => events.push({ type, data, ...options, seq: events.length + 1 }) };
  session.append('turn/start', { turn: 1 }); const assembly = { tools: [...registry.values()] };
  const input = (id, kind, text) => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] });
  const payload = { agent: { session, externalTurns: nativeOwnershipHost(session, events), options: { provider: 'agentkit-studio-model', model: 'vision-test' } },
    turn: 1, signal: new AbortController().signal, input: { kind: 'enter', messages: [
      input('ambient', 'runtime-context', 'WRONG_AMBIENT_CWD=/studio/repository'), input('human', 'user', 'Inspect sample.png.')], assembly },
    prepareInput: async () => ({ kind: 'enter', messages: [], assembly }), binding: { agentId: record.metadata.id,
      agentRevision: record.metadata.revision, runtime: 'harness', local: true, nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools: gateway } };
  let hostFailure;
  try { await host.executeTurn(payload); } catch (error) { hostFailure = { code: error.code, reason: error.nativeReason }; }
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex'),
    userId: 'local-user', agentId: record.metadata.id };
  const saved = store.load(scope, store.sessionHead(scope, session.id).runId);
  assert.equal(saved.snapshot.phase, 'completed', JSON.stringify({ reason: saved.snapshot.reason, toolException, hostFailure,
    recent: saved.events.slice(-5).map(event => ({ kind: event.kind, status: event.payload.status, cause: event.payload.cause })),
    failures: saved.events.filter(event => event.kind === 'tool.failure_observed').map(event => event.payload), attachments,
    receipts: saved.receipts.map(receipt => ({ status: receipt.status, result: receipt.result?.kind,
      code: receipt.result?.code, reason: receipt.result?.reason,
      outcomes: receipt.result?.results?.map(result => ({ status: result.status, content: result.content })) })) }));
  assert.equal(bodies.length, 2); assert.equal(attachments, 1);
  const initial = JSON.stringify(bodies[0]); assert.ok(!initial.includes('WRONG_AMBIENT_CWD'));
  assert.match(initial, /skill-17/); assert.ok(!initial.includes('PRIVATE_INSTRUCTIONS'));
  assert.equal(saved.configuration.modelSurface.environment.cwd, realpathSync(workspaceRoot));
  const capabilities = saved.configuration.modelSurface.executionCapabilities;
  assert.equal(capabilities.length, 1); assert.equal(capabilities[0].availability, 'unavailable');
  assert.equal(capabilities[0].networkPolicy, 'workspace-origin/v1'); assert.equal(capabilities[0].externalNetwork, false);
  assert.match(initial, /workspace-origin\/v1/); assert.doesNotMatch(initial, /not-installed-browser/);
  assert.equal(saved.configuration.contextPolicy.summaryFormatPolicy, 'task-continuity/v1');
  assert.match(JSON.stringify(bodies[1]), /data:image\/png;base64/);
  const read = saved.snapshot.messages.find(message => message.role === 'tool' && message.name === 'read_workspace_file');
  assert.ok(read.media.length === 1); assert.ok(Buffer.byteLength(read.media[0].image_url.url) > 65536);
  assert.ok(!read.content.includes('base64'));
  assert.equal(saved.configuration.hostRecoveryBinding.inputContextPolicy, 'agentkit.native-context-ownership/v2');
});
