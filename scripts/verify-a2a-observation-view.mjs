/** Actual maintained Conversation assembler/Chat builder/renderer slot and
 * React server rendering. No DOM, browser interaction or human approval claim. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { a2aObservationDefinition, mountA2aObservation, A2A_OBSERVATION_KIND, A2A_OBSERVATION_CONTRACT } from '../src/client/dsh/a2a-observation.mjs';
import { createAssistantConversation } from '../src/client/dsh/assistant-conversation.mjs';
import { createAssistantTranscript } from '../src/client/components/assistant-transcript.mjs';
const { values } = parseArgs({ options: { source: { type: 'string' }, 'history-root': { type: 'string' } } });
assert.ok(values.source, '--source <maintained DSH checkout> required');
const source = resolve(values.source), require = createRequire(join(source, 'packages/client/ui-chat/package.json'));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const exports = [
  ['Context', require.resolve('@deepseek-ai/cordis')],
  ['ConversationEventRegistry', join(source, 'packages/client/ui-conversation/src/client/conversation/event-registry.ts')],
  ['ConversationViewRegistry', join(source, 'packages/client/ui-conversation/src/client/conversation/view-registry.ts')],
  ['ConversationGroupRegistry', join(source, 'packages/client/ui-conversation/src/client/conversation/group-registry.ts')],
  ['ConversationNodeAssembler', join(source, 'packages/client/ui-conversation/src/client/conversation/assembler.ts')],
  ['chatViewDefinition', join(source, 'packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts')],
  ['processGroupDefinition', join(source, 'packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts')],
  ['SlotRegistry', join(source, 'packages/client/ui-renderer/src/client/registry.ts')],
];
const compiled = await build({ stdin: { contents: exports.map(([name, path]) => `export { ${name} } from ${JSON.stringify(path)};`).join('\n'),
  resolveDir: source }, bundle: true, platform: 'node', format: 'esm', write: false, target: 'node22',
  banner: { js: `import {createRequire as makeRequire} from 'node:module'; const require = makeRequire(${JSON.stringify(join(source, 'package.json'))});` } });
const { Context, ConversationEventRegistry, ConversationViewRegistry, ConversationGroupRegistry, ConversationNodeAssembler, chatViewDefinition, processGroupDefinition, SlotRegistry } =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
const ctx = new Context(); await ctx.plugin(SlotRegistry);
try {
  const events = new ConversationEventRegistry(ctx), views = new ConversationViewRegistry(ctx), groups = new ConversationGroupRegistry(ctx, views);
  ctx.provide('uiConversation', { events, views, groups }); views.register(chatViewDefinition);
  groups.register(processGroupDefinition);
  // Declare the same keyed session seat that the maintained Chat application owns.
  ctx.slots.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } }, () => null);
  const mounted = mountA2aObservation(ctx, { React });
  assert.equal(events.entries()[0], a2aObservationDefinition);
  const renderer = ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === A2A_OBSERVATION_KIND);
  assert.equal(renderer?.component, mounted.View, 'actual keyed renderer registration');
  const canonical = JSON.parse(await readFile(new URL('../tests/fixtures/a2a-canonical-reference.json', import.meta.url), 'utf8'));
  const activity = JSON.parse(await readFile(new URL('../tests/fixtures/a2a-tool-activity-reference.json', import.meta.url), 'utf8'));
  let cases = 0, eventCount = 0, nodeCount = 0;
  const conversation = createAssistantConversation({ ConversationNodeAssembler }); conversation.bind(ctx.uiConversation);
  const Transcript = createAssistantTranscript({ ui: { React, BRAND: {} }, assistantConversation: conversation,
    hostRemote: { assistantExecute: () => assert.fail('observation renderer must not fetch attachments or execute tools') }, window: globalThis });
  for (const sample of [...canonical.cases, ...activity.cases.map(value => ({ ...value, events: value.steps.flatMap(step => step.events ?? []) }))]) {
    const sourceKey = createHash('sha256').update(sample.label).digest('hex');
    // The reference mapper starts at zero. The durable Node source journal
    // allocates from one; this UI-only adaptation shifts its sequence labels.
    const input = sample.events.map((event, index) => {
      const value = { ...event, seq: event.seq + 1 };
      return { type: 'agentkit/a2a-observation', seq: index, time: 1, ignorable: true, data: {
        contract: A2A_OBSERVATION_CONTRACT, sourceKey, owner: { agentId: 'agent', sessionId: 'session', kind: 'native' },
        sourceSeq: value.seq, eventId: value.event_id, eventJson: JSON.stringify(value),
      } };
    });
    const assembler = new ConversationNodeAssembler(events, views, groups);
    assembler.replaceWindow(input.map(event => ({ type: 'event', event })), false); assembler.activateTarget('chat');
    const snapshot = assembler.snapshot('chat'), nodes = [...snapshot.nodes.values()];
    assert.ok(nodes.every(node => node.kind === A2A_OBSERVATION_KIND));
    if (input.length) assert.ok(nodes.length > 0, sample.label);
    for (const node of nodes) {
      assert.ok(input.some(event => event.seq === node.anchorSeq));
      const html = renderToStaticMarkup(React.createElement(renderer.component, { node }));
      assert.match(html, /A2A 远端观察/); assert.doesNotMatch(html, /<(?:a|button|input)\b/);
    }
    const html = renderToStaticMarkup(React.createElement(Transcript, { view: { events: input }, agentId: 'agent' }));
    if (nodes.length) assert.match(html, /A2A 远端观察/, 'Studio AssistantTranscript renders actual assembled observations');
    assert.doesNotMatch(html, /<(?:a|button|input)\b/);
    // Replacing with the exact persisted history must reproduce visible content.
    assembler.replaceWindow(input.map(event => ({ type: 'event', event: JSON.parse(JSON.stringify(event)) })), false);
    assert.deepEqual([...assembler.snapshot('chat').nodes.values()].map(node => node.data), nodes.map(node => node.data));
    cases++; eventCount += input.length; nodeCount += nodes.length;
  }
  let mountedObservations = null;
  if (values['history-root']) {
    const base = join(resolve(values['history-root']), 'sessions'), paths = (await readdir(base, { recursive: true })).filter(path => path.endsWith('.jsonl'));
    assert.equal(paths.length, 1);
    const history = (await readFile(join(base, paths[0]), 'utf8')).trim().split('\n').map(JSON.parse)
      .filter(event => Number.isSafeInteger(event.seq) && typeof event.type === 'string');
    const observations = history.filter(event => event.type === 'agentkit/a2a-observation'); assert.equal(observations.length, 9);
    const nodes = conversation.assemble(history, false); assert.ok(nodes.length > 0);
    const html = renderToStaticMarkup(React.createElement(Transcript, { view: { events: history }, agentId: 'agent' }));
    assert.match(html, /The remote agent found 3 relevant documents/); assert.match(html, /remote_search/);
    assert.match(html, /已完成/); assert.doesNotMatch(html, /<(?:a|button|input)\b/);
    mountedObservations = { durableEvents: observations.length, actualNodes: nodes.length, actualReplyRendered: true, actualRemoteToolRendered: true };
  }
  mounted.dispose(); assert.equal(events.entries().length, 0); assert.equal(ctx.slots.entries('conversation.chat.node').length, 0);
  console.log(JSON.stringify({ node: process.version, cases, referenceEvents: eventCount, renderedNodes: nodeCount,
    actualAssembler: true, actualChatBuilder: true, actualRendererSlot: true, actualReactSSR: true, studioTranscript: true, mountedObservations,
    limitation: 'No DOM, browser interaction, network service or human approval acceptance.' }));
} finally { await ctx.fiber.dispose(); }
