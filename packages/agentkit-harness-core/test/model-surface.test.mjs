import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRunStore, NativeKernel, emptyUsage, artifactToolDefinitions, boundedCapabilityCatalog, canonical, configure, discoveryModelTools, discoveredCallExposed,
  executeToolDiscovery, modelSurfaceMessages, planNativeContext, toolDiscoveryDefinitions, validSummaryContinuity, contextContinuity } from '../dist/index.mjs';
import { governArtifactResult } from '../dist/artifact-runtime.mjs';
import { modelObservationBytes } from '../dist/tool-context.mjs';
import { digest, fixture, scope, tool } from './fixtures.mjs';

const surface = { contract: 'bound-model-surface/v1', environment: { workspaceRoot: '/isolated/work', cwd: '/isolated/work',
  platform: 'linux', date: '2026-10-28', commandBackend: 'local_process', commandCwd: '/isolated/work',
  environmentNames: ['HOME', 'PATH'], supportsImages: true } };
const policy = { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', enabled: true, triggerRatio: .72, targetRatio: .45,
  summaryMaxTokens: 1024, maxCompactions: null, maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2,
  maxSummaryRetries: 1, summaryFormatPolicy: 'task-continuity/v1' };

test('verification continuity exposes actionable summaries and only readable evidence, preserving private ledger facts', () => {
  const {config,snapshot}=fixture({modelSurface:{...surface,verificationProjection:'readable-evidence/v1'},
    artifactPolicy:'runtime-artifacts/v1',tools:artifactToolDefinitions()});
  const readable={uri:'artifact://readable',digest:'sha256:readable',mediaType:'text/plain',sizeBytes:8};
  snapshot.artifactRefs=[readable];
  snapshot.verification={status:'failed',reason:'delivery_rejected',candidateId:'candidate',contractRevision:'contract',workspaceRevision:'revision',
    checks:[{id:'delivery',status:'failed',evidence:{private:'HOST_PRIVATE_PAYLOAD',locator:'artifact://private-verifier'},
      evidenceRefs:['artifact://private-verifier',readable.uri],safeSummary:'Correct the declared file.',repairable:true}]};
  const before=canonical(snapshot),continuity=contextContinuity(snapshot,config);
  assert.equal(continuity.schemaVersion,'agentkit.native-context-continuity/v2');
  assert.equal(continuity.verification.checks[0].safeSummary,'Correct the declared file.');
  assert.deepEqual(continuity.verification.checks[0].readableEvidence,[readable]);
  assert.doesNotMatch(canonical(continuity),/HOST_PRIVATE_PAYLOAD|private-verifier/);
  assert.equal(canonical(snapshot),before,'projection cannot change evidence or grant artifact access');
  const legacy={...config,modelSurface:surface};
  assert.equal(contextContinuity(snapshot,legacy).schemaVersion,'agentkit.native-context-continuity/v1');
  assert.match(canonical(contextContinuity(snapshot,legacy)),/HOST_PRIVATE_PAYLOAD/);
});

test('the admitted model surface is frozen transcript data, not a transport-only prompt patch', () => {
  const { config, snapshot } = fixture({ modelSurface: surface, tools: [tool({ name: 'custom_business_tool',
    modelGuidance: ['Use the tenant-scoped query supplied by this tool owner.'] })] });
  const env = snapshot.messages.find(message => message.kind === 'runtime_environment');
  assert.equal(JSON.parse(env.content).cwd, '/isolated/work'); assert.equal(env.persistent, true);
  assert.deepEqual(modelSurfaceMessages(config), snapshot.messages.filter(message => message.role === 'system'));
  assert.ok(JSON.parse(snapshot.messages.find(message => message.kind === 'capability_directory').content)
    .guidance.includes('Use the tenant-scoped query supplied by this tool owner.'));
  surface.environment.cwd = '/changed';
  assert.equal(JSON.parse(env.content).cwd, '/isolated/work'); surface.environment.cwd = '/isolated/work';
  assert.throws(() => fixture({ modelSurface: { ...surface, environment: { ...surface.environment, apiKey: 'must-not-serialize' } } }), /invalid_model_environment/);
  assert.equal(modelSurfaceMessages(fixture().config).length, 0);
});

test('directory budgeting retains all names when descriptions do not fit, and reports any actual omission', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ name: `skill-${i}`, id: `id-${i}`, description: 'description '.repeat(100) }));
  const directory = boundedCapabilityCatalog(entries, 2000);
  assert.equal(directory.total, 20); assert.equal(directory.omitted, 0); assert.equal(directory.mode, 'names');
  assert.equal(directory.entries.length, 20); assert.ok(Buffer.byteLength(canonical(directory)) <= 2000);
  const small = boundedCapabilityCatalog(entries, 256);
  assert.equal(small.omitted, 20 - small.entries.length); assert.ok(small.omitted > 0);
  assert.ok(Buffer.byteLength(canonical(small)) <= 256);
});

test('generic search exposes the exact discovered schema for the next direct call without granting unbound tools', () => {
  const deferred = tool({ name: 'docs_search', discovery: { deferred: true, searchHint: 'Search company docs' } });
  const { config, snapshot } = fixture({ profile: { profileId: 'test', profileVersion: '1', providerFamily: 'openai-chat',
    compatibilityDigest: 'test', discoveredToolExposure: 'direct-after-search/v1' },
  tools: [...toolDiscoveryDefinitions(), deferred], toolDiscoveryPolicy: 'local-tool-search/v1' });
  const call = { callId: 'search', name: 'ToolSearch', arguments: { query: 'select:docs_search' } };
  assert.equal(discoveryModelTools(snapshot, config, config.tools).some(tool => tool.name === deferred.name), false);
  const result = executeToolDiscovery(snapshot, config, call);
  assert.equal(result.content.definitions[0].call, 'direct');
  const direct = { callId: 'direct', name: deferred.name, arguments: {} };
  assert.equal(discoveredCallExposed(snapshot, config, direct), false);
  snapshot.toolDiscovery.discovered.push(...result.content.tool_names);
  const loaded = discoveryModelTools(snapshot, config, config.tools).find(tool => tool.name === deferred.name);
  assert.deepEqual(loaded.parameters, deferred.parameters); assert.equal(loaded.discovery, undefined);
  assert.equal(discoveredCallExposed(snapshot, config, direct), true);
  assert.equal(executeToolDiscovery(snapshot, config, { ...call, arguments: { query: 'select:unbound' } }).content.tool_names.length, 0);
  const oldProfile = { ...config.profile }; delete oldProfile.discoveredToolExposure;
  const legacy = configure({ ...config, profile: oldProfile });
  assert.equal(discoveredCallExposed(snapshot, legacy, direct), false);
});

test('the real kernel executes search then a direct loaded tool once with model-visible schemas matching admission', async () => {
  const tools = [...toolDiscoveryDefinitions(), tool({ name: 'remote_lookup', discovery: { deferred: true,
    searchHint: 'Find a remote document' } })];
  const { config, snapshot } = fixture({ modelSurface: surface, tools, toolDiscoveryPolicy: 'local-tool-search/v1',
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'openai-chat', compatibilityDigest: 'fixture',
      discoveredToolExposure: 'direct-after-search/v1' } });
  const store = new MemoryRunStore(); store.create(config, snapshot); let models = 0, executions = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'surface-test', ports: {
    model: { generate: async request => {
      models++;
      if (models === 1) {
        assert.equal(request.tools.some(tool => tool.name === 'remote_lookup'), false);
        return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'discover', name: 'ToolSearch', arguments: { query: 'select:remote_lookup' } }] };
      }
      if (models === 2) {
        assert.equal(request.tools.find(tool => tool.name === 'remote_lookup').discovery, undefined);
        return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'direct', name: 'remote_lookup', arguments: {} }] };
      }
      assert.equal(models, 3);
      assert.equal(request.messages.find(message => message.name === 'remote_lookup' && message.role === 'tool').content, 'document observed');
      return { kind: 'final_candidate', text: 'Observed document', toolCalls: [], usage: emptyUsage() };
    } }, tools: { execute: async request => { executions++; assert.equal(request.call.name, 'remote_lookup');
      return { status: 'ok', content: 'document observed' }; } },
  } });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(executions, 1); assert.equal(models, 3);
  assert.equal(result.usage.toolCalls, 2);
});

test('structured compaction rejects incomplete notes and retains execution facts alongside the accepted summary', async () => {
  const { config, snapshot } = fixture({ modelSurface: surface, contextPolicy: policy,
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture',
      contextWindow: 10000, maxOutputTokens: 1024 } });
  snapshot.messages.push({ role: 'assistant', content: 'old observation '.repeat(600) });
  const counters = { countRequest: async (messages, tools) => Math.ceil(canonical({ messages, tools }).length / 4),
    countText: async text => Math.ceil(text.length / 4) };
  const first = await planNativeContext(snapshot, config, [], counters, digest, true, true);
  assert.equal(first.action, 'compact');
  assert.match(first.state.compaction.chunk.messages[0].content, /objective, constraints, completed, pending, evidence/);
  const bad = structuredClone(first.state); bad.compaction.proposal = 'Task is done, trust me.';
  const rejected = await planNativeContext({ ...snapshot, contextState: bad }, config, [], counters, digest, true, true);
  assert.equal(rejected.state.compaction.errors, 1); assert.equal(rejected.state.compaction.offset, 0);
  const notes = canonical({ objective: ['Complete the task'], constraints: [], completed: [], pending: ['Inspect results'],
    evidence: ['Observed old result'], failures: [], artifacts: [], nextSteps: ['Read current source'] });
  assert.equal(validSummaryContinuity(notes), true); assert.equal(validSummaryContinuity('{"objective":[]}'), false);
  const accepted = structuredClone(first.state); accepted.compaction.proposal = notes;
  const ready = await planNativeContext({ ...snapshot, contextState: accepted }, config, [], counters, digest, false, true);
  assert.equal(ready.action, 'ready');
  assert.ok(ready.messages.some(message => message.kind === 'runtime_environment'));
  assert.ok(ready.messages.some(message => message.kind === 'compaction_summary' && message.content.includes('Read current source')));
});

test('image observations use the image allowance while receipts and display metadata stay out of model text', async () => {
  const { config } = fixture({ modelSurface: surface, artifactPolicy: 'runtime-artifacts/v1', tools: artifactToolDefinitions(), limits: { maxToolResultBytes: 1024,
    maxInlineImageBytes: 256000 } });
  const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(80000)}` } };
  const result = { status: 'ok', content: { path: 'image.png', privateRecord: 'not model-visible' },
    context: { content: 'Image image.png', media: [image], presentation: { format: 'image', content: ['display-only'] } } };
  assert.ok(modelObservationBytes(result, config) < 1024);
  const governed = await governArtifactResult({}, tool({ resultArchivePolicy: 'archived-model-view/v5' }), result, config);
  assert.deepEqual(governed.context.media, [image]); assert.equal(governed.context.content, 'Image image.png');
  assert.equal(governed.content.privateRecord, 'not model-visible');
  const overflow = { ...config, limits: { ...config.limits, maxInlineImageBytes: 1000 } };
  const omitted = await governArtifactResult({}, tool(), result, overflow);
  assert.equal(omitted.context.media, undefined); assert.match(omitted.context.content, /not been observed/);
});
