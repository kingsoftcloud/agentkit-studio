/**
 * Actual maintained DSH proof that Native publicly visible thinking (Assistant
 * reasoning) projects through the real Conversation assembler and renders with
 * the real ReasoningRow React component (SSR only). No DOM, browser interaction,
 * network service, or human-approval acceptance.
 *
 * This script bundles the ACTUAL maintained DSH sources (ConversationNodeAssembler,
 * ConversationEventRegistry/ViewRegistry/GroupRegistry, chatViewDefinition,
 * processGroupDefinition, assistantDefinition, ClientAssistantStream,
 * ReasoningRow) via esbuild CJS and loads them through `new Function` with a
 * `require` bound to the DSH ui-chat package, so the bundled React external is
 * the single real React instance. It does not fake component internals.
 *
 * Proof boundaries (each is reported in the returned facts):
 *  - Durable history: real assistant/message reasoning blocks project into
 *    assistant-step chat nodes with the same text after settlement and again
 *    after a cold reload (deep-cloned events).
 *  - Interrupted: assistant/message events carrying interrupted:true map to
 *    assistant-step nodes with status 'interrupted' and finalNode.interrupted.
 *  - ReasoningRow SSR: collapsed/expanded/running renders carry the semantic
 *    data-variant=think, data-state ok|running, data-expanded, summary (**stripped)
 *    and expanded body slot text.
 *  - Live prefix: a transport-baseline reconstruction only — raw Native stream
 *    frames (start without startedAfterSeq / chunk / end) are replayed through
 *    the real ClientAssistantStream with startedAfterSeq re-attached from the
 *    current durable seq of the actual message/step timeline; the emitted
 *    assistant/live-chunk transients are fed back through the real assembler.
 *    This is explicitly NOT real network acceptance; the main agent owns the
 *    packed-Host wire proof. The settled node's reasoning text equals the
 *    durable message reasoning (the stream prefix is not duplicated after
 *    settlement); the reconstructed live prefix is a prefix of that text.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REASONING_BODY_SLOT = 'conversation.chat.reasoning.body';

function dshPaths(source) {
  const u = (rel) => join(source, rel);
  return {
    cordis: '@deepseek-ai/cordis',
    eventRegistry: u('packages/client/ui-conversation/src/client/conversation/event-registry.ts'),
    viewRegistry: u('packages/client/ui-conversation/src/client/conversation/view-registry.ts'),
    groupRegistry: u('packages/client/ui-conversation/src/client/conversation/group-registry.ts'),
    assembler: u('packages/client/ui-conversation/src/client/conversation/assembler.ts'),
    chatViewDefinition: u('packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'),
    processGroupDefinition: u('packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts'),
    assistantDefinition: u('packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'),
    clientAssistantStream: u('packages/api/session-controller/src/client/sessions/assistant-stream.ts'),
    reasoningRow: u('packages/client/ui-chat/src/client/chat/ReasoningRow.tsx'),
  };
}

/** CSS modules render no classes under SSR; map every .css import to an empty object. */
function cssEmptyPlugin() {
  return {
    name: 'css-empty',
    setup(b) {
      b.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {}', loader: 'js' }));
    },
  };
}

/** Load a CJS bundle with a supplied `require` (bound to the DSH ui-chat package),
 *  so externalized React resolves to one real instance. */
function loadCjs(code, dshRequire, uiChatDir) {
  const moduleObj = { exports: {} };
  const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', code);
  fn(dshRequire, moduleObj, moduleObj.exports, uiChatDir, join(uiChatDir, 'package.json'));
  return moduleObj.exports;
}

async function buildAssemblerBundle(source) {
  const p = dshPaths(source);
  const entry = [
    `export { Context } from ${JSON.stringify(p.cordis)};`,
    `export { ConversationEventRegistry } from ${JSON.stringify(p.eventRegistry)};`,
    `export { ConversationViewRegistry } from ${JSON.stringify(p.viewRegistry)};`,
    `export { ConversationGroupRegistry } from ${JSON.stringify(p.groupRegistry)};`,
    `export { ConversationNodeAssembler } from ${JSON.stringify(p.assembler)};`,
    `export { chatViewDefinition } from ${JSON.stringify(p.chatViewDefinition)};`,
    `export { processGroupDefinition } from ${JSON.stringify(p.processGroupDefinition)};`,
    `export { assistantDefinition, registerAssistantConversationNode } from ${JSON.stringify(p.assistantDefinition)};`,
    `export { ClientAssistantStream } from ${JSON.stringify(p.clientAssistantStream)};`,
  ].join('\n');
  const compiled = await build({
    stdin: { contents: entry, resolveDir: source },
    bundle: true, platform: 'node', format: 'cjs', write: false, target: 'node22',
    logLevel: 'silent',
  });
  return compiled.outputFiles[0].text;
}

async function buildReasoningBundle(source) {
  const p = dshPaths(source);
  const entry = `export { ReasoningRow } from ${JSON.stringify(p.reasoningRow)};`;
  const compiled = await build({
    stdin: { contents: entry, resolveDir: source },
    bundle: true, platform: 'node', format: 'cjs', write: false, target: 'node22',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'scheduler'],
    alias: { '@deepseek-ai/dsh-client-ui-primitives': join(source, 'packages/client/ui-primitives/src/index.ts') },
    jsx: 'automatic', jsxImportSource: 'react',
    plugins: [cssEmptyPlugin()],
    logLevel: 'silent',
  });
  return compiled.outputFiles[0].text;
}

/** Unwrap a raw Native frame that may be wrapped as {frame} or {type:'assistant-stream', frame}. */
function unwrapFrame(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'assistant-stream' && value.frame) return value.frame;
  if ('frame' in value && value.frame) return value.frame;
  return value;
}

function reasoningTextFromContent(content) {
  return (Array.isArray(content) ? content : [])
    .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function reasoningTextFromBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && b.kind === 'reasoning' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * Verify Native publicly visible thinking using actual maintained DSH sources.
 * @param source - absolute maintained DSH checkout root.
 * @param events - actual durable SessionEvent[] (session history).
 * @param frames - raw Native stream frames (start/chunk/end, possibly wrapped {frame}).
 * @param outputDir - optional directory for HTML/evidence artifacts.
 * @returns facts describing the proof and any limitations.
 */
export async function verifyNativeThinkingView({ source, events, frames, outputDir } = {}) {
  assert.ok(isAbsolute(source), 'source must be an absolute maintained DSH root');
  assert.ok(Array.isArray(events) && Array.isArray(frames), 'Actual durable events and stream frames are required');
  const uiChatDir = join(source, 'packages/client/ui-chat');
  const dshRequire = createRequire(join(uiChatDir, 'package.json'));
  const React = dshRequire('react');
  const { renderToStaticMarkup } = dshRequire('react-dom/server');

  const assemblerCode = await buildAssemblerBundle(source);
  const reasoningCode = await buildReasoningBundle(source);
  const A = loadCjs(assemblerCode, dshRequire, uiChatDir);
  const R = loadCjs(reasoningCode, dshRequire, uiChatDir);
  const {
    Context, ConversationEventRegistry, ConversationViewRegistry, ConversationGroupRegistry,
    ConversationNodeAssembler, chatViewDefinition, processGroupDefinition,
    assistantDefinition, registerAssistantConversationNode, ClientAssistantStream,
  } = A;
  const { ReasoningRow } = R;

  const facts = {
    node: process.version,
    source,
    actualReact: React.version,
    bundles: { assembler: true, reasoning: true, reactExternal: true },
    limitations: [
      'No DOM, browser interaction, network service, or human-approval acceptance.',
      'ReasoningRow is rendered via react-dom/server renderToStaticMarkup; CSS modules map to empty classes.',
      'ClientAssistantStream replay is a transport-baseline reconstruction, not real network acceptance.',
    ],
  };

  // --- Context + registries (same seat the maintained Chat application owns) ---
  const ctx = new Context();
  const regEvents = new ConversationEventRegistry(ctx);
  const regViews = new ConversationViewRegistry(ctx);
  const regGroups = new ConversationGroupRegistry(ctx, regViews);
  ctx.provide('uiConversation', { events: regEvents, views: regViews, groups: regGroups });
  regViews.register(chatViewDefinition);
  regGroups.register(processGroupDefinition);
  registerAssistantConversationNode(ctx);

  const registered = regEvents.entries().find((def) => def.kind === 'assistant-step');
  assert.ok(registered, 'assistantDefinition registered in the event registry');
  assert.equal(registered.target, 'chat');
  facts.assistantDefinitionRegistered = {
    kind: registered.kind,
    target: registered.target,
    definitionKind: typeof assistantDefinition?.kind === 'string' ? assistantDefinition.kind : 'assistant-step',
    matchForm: typeof registered.match === 'function' ? 'function' : 'table',
  };

  try {
    // --- ReasoningRow SSR (real component, real React) ---
    const t = (key) => key;
    const renderRow = ({ text, running, expanded, previewPolicy = { settledReasoningPreview: false } }) => {
      const useDisclosure = () => ({ expanded, toggle() {}, setExpanded() {} });
      const usePresentation = (selector) => selector(previewPolicy);
      // Standard body slot injection: a plain <p> with the original reasoning text.
      const renderSlot = (name, props) => { assert.equal(name, REASONING_BODY_SLOT); return React.createElement('p', null, props?.text ?? ''); };
      return renderToStaticMarkup(
        React.createElement(ReasoningRow, { text, running, useDisclosure, usePresentation, renderSlot, t }),
      );
    };
    const sampleText = '**Plan:** step one\nthen step two';
    const collapsedHtml = renderRow({ text: sampleText, running: false, expanded: false });
    const expandedHtml = renderRow({ text: sampleText, running: false, expanded: true });
    const runningHtml = renderRow({ text: sampleText, running: true, expanded: false });
    const ssr = {
      collapsed: {
        dataVariantThink: collapsedHtml.includes('data-variant="think"'),
        dataStateOk: collapsedHtml.includes('data-state="ok"'),
        noDataExpanded: !collapsedHtml.includes('data-expanded'),
        summaryStripsBold: collapsedHtml.includes('Plan: step one'),
        summaryNoBoldMarker: !collapsedHtml.includes('**Plan:**'),
      },
      expanded: {
        dataVariantThink: expandedHtml.includes('data-variant="think"'),
        dataStateOk: expandedHtml.includes('data-state="ok"'),
        dataExpanded: expandedHtml.includes('data-expanded'),
        bodyTextPresent: expandedHtml.includes('then step two'),
        bodyRawBold: expandedHtml.includes('**Plan:**'),
      },
      running: {
        dataStateRunning: runningHtml.includes('data-state="running"'),
        runningA11y: runningHtml.includes('row.running'),
        disclosureTitle: runningHtml.includes('message.think'),
      },
    };
    for (const [group, checks] of Object.entries(ssr)) {
      for (const [name, value] of Object.entries(checks)) {
        assert.ok(value, `ReasoningRow SSR ${group}.${name} failed; html=${(group === 'running' ? runningHtml : group === 'expanded' ? expandedHtml : collapsedHtml).slice(0, 240)}`);
      }
    }
    facts.reasoningRowSSR = ssr;

    // --- Durable history projection through the real assembler ---
    const evList = Array.isArray(events) ? events : [];
    const windowEntries = evList.map((event) => ({ type: 'event', event }));
    const asm = new ConversationNodeAssembler(regEvents, regViews, regGroups);
    asm.replaceWindow(windowEntries, false);
    asm.activateTarget('chat');
    const snapshot = asm.snapshot('chat');
    const nodes = [...snapshot.nodes.values()];
    const assistantStepNodes = nodes.filter((n) => n.kind === 'assistant-step');
    const appendMessages = evList.filter((e) => e && e.type === 'assistant/message' && e.surfaceOp === 'append');

    // Each settled/missing assistant-step node with a finalNode must reproduce the
    // reasoning text of its corresponding durable assistant/message.
    const reasoningMatches = [];
    for (const node of assistantStepNodes) {
      const final = node.data?.finalNode;
      if (!final) continue;
      const message = appendMessages.find((m) => m.seq === final.seq);
      if (!message) continue;
      const expected = reasoningTextFromContent(message.data?.message?.content);
      const actual = reasoningTextFromBlocks(node.data.blocks);
      reasoningMatches.push({
        seq: final.seq,
        status: node.data.status,
        interrupted: final.interrupted === true,
        expectedPresent: expected.length > 0,
        sameText: expected !== '' && actual === expected,
      });
      if (expected !== '') assert.equal(actual, expected, `settled reasoning text must match durable message at seq ${final.seq}`);
    }

    // Cold reload: re-assemble from a deep-cloned durable window; data must be stable.
    const coldAsm = new ConversationNodeAssembler(regEvents, regViews, regGroups);
    coldAsm.replaceWindow(evList.map((e) => ({ type: 'event', event: JSON.parse(JSON.stringify(e)) })), false);
    coldAsm.activateTarget('chat');
    const coldNodes = [...coldAsm.snapshot('chat').nodes.values()];
    const coldStable = assistantStepNodes.every((n) => {
      const twin = coldNodes.find((c) => c.key === n.key && c.kind === 'assistant-step');
      return twin != null && JSON.stringify(twin.data) === JSON.stringify(n.data);
    });
    assert.ok(coldStable, 'Cold history must reproduce the same assistant nodes');
    assert.ok(reasoningMatches.some(match => match.expectedPresent), 'The supplied history must contain visible reasoning');
    assert.equal(reasoningMatches.filter(match => match.expectedPresent).length,
      appendMessages.filter(message => reasoningTextFromContent(message.data.message.content)).length,
      'Every reasoning-bearing message must have a matching assembled node');

    // Interrupted: durable messages carrying interrupted:true map to interrupted nodes.
    const interruptedMessages = appendMessages.filter((m) => m.data?.interrupted === true);
    const interruptedMapped = interruptedMessages.map((m) => {
      const node = assistantStepNodes.find((n) => n.data?.finalNode?.seq === m.seq);
      return !!node && node.data.status === 'interrupted' && node.data.finalNode?.interrupted === true;
    });
    assert.ok(interruptedMapped.every(Boolean), 'Every interrupted message must remain visibly interrupted');

    facts.historyProjection = {
      durableEvents: evList.length,
      assistantStepNodes: assistantStepNodes.length,
      appendMessages: appendMessages.length,
      reasoningMatches,
      coldReloadStable: coldStable,
      interruptedMessages: interruptedMessages.length,
      interruptedMapped,
    };

    // The actual attempt identity/end receipt is required. Do not fabricate an
    // end frame or rewrite turn/step to make an unrelated prefix appear valid.
    const project = entries => {
      const assembler = new ConversationNodeAssembler(regEvents, regViews, regGroups);
      assembler.replaceWindow(entries, false); assembler.activateTarget('chat');
      return [...assembler.snapshot('chat').nodes.values()].filter(node => node.kind === 'assistant-step');
    };
    facts.streamReplay = {
      cases: replayStreams({ frames, events: evList, ClientAssistantStream, project }),
      transportBaselineReconstruction: true,
      networkAcceptance: 'not performed — main agent owns the packed-Host wire proof',
    };

    // --- Optional HTML/evidence artifacts ---
    if (outputDir) {
      await mkdir(outputDir, { recursive: true });
      const doc = `<!doctype html><meta charset="utf-8"><title>Native thinking view proof</title>` +
        `<h1>ReasoningRow SSR (real DSH component, react-dom/server)</h1>` +
        `<h2>collapsed</h2>${collapsedHtml}` +
        `<h2>expanded</h2>${expandedHtml}` +
        `<h2>running</h2>${runningHtml}` +
        `<hr><pre>${escapeHtml(JSON.stringify(facts, null, 2))}</pre>`;
      await writeFile(join(outputDir, 'native-thinking-view.html'), doc, 'utf8');
      await writeFile(join(outputDir, 'native-thinking-view-facts.json'), JSON.stringify(facts, null, 2), 'utf8');
      facts.artifacts = { dir: outputDir, html: 'native-thinking-view.html', json: 'native-thinking-view-facts.json' };
    }
    return facts;
  } finally {
    await ctx.fiber.dispose();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * Replay raw Native stream frames through the real ClientAssistantStream.
 * The raw start frame lacks startedAfterSeq; the remote attaches it from the
 * current durable seq. We reconstruct that attachment from the actual durable
 * message/step timeline (transport-baseline reconstruction, not network).
 */
function replayStreams({ frames, events, ClientAssistantStream, project }) {
  const raw = frames.map(unwrapFrame), cases = [];
  const starts = raw.filter(frame => frame.type === 'start');
  assert.ok(starts.length, 'Real captured stream starts are required');
  for (const start of starts) {
    const attempt = raw.filter(frame => frame.attemptId === start.attemptId);
    const chunks = attempt.filter(frame => frame.type === 'chunk');
    const firstReasoning = chunks.findIndex(frame => frame.chunk.type === 'reasoning-delta' && frame.chunk.text);
    if (firstReasoning < 0) continue;
    const end = attempt.find(frame => frame.type === 'end');
    assert.equal(end?.outcome?.eventType, 'assistant/message', 'A real durable settlement receipt is required');
    const message = events.find(event => event.seq === end.outcome.seq);
    assert.equal(message?.type, 'assistant/message');
    assert.equal(message.data.turn, start.turn); assert.equal(message.data.step, start.step);
    const opening = events.filter(event => event.seq < message.seq).map(event => ({ type: 'event', event }));
    const startedAfterSeq = opening.at(-1)?.event.seq ?? -1;
    const live = new ClientAssistantStream();
    const visible = [...live.replace(opening)];
    assert.equal(live.acceptFrame({ ...start, startedAfterSeq }), undefined);
    const prefix = chunks.slice(0, firstReasoning + 1);
    for (const frame of prefix) {
      const result = live.acceptFrame(frame); assert.equal(result?.type, 'transient'); visible.push(result.entry);
    }
    const isCurrent = node => node.data.turn === start.turn && node.data.step === start.step;
    const running = project(visible).find(isCurrent);
    assert.equal(running?.data.status, 'running');
    const liveReasoning = reasoningTextFromBlocks(running.data.blocks);
    const messageReasoning = reasoningTextFromContent(message.data.message.content);
    assert.ok(liveReasoning && messageReasoning.startsWith(liveReasoning));
    const restored = new ClientAssistantStream();
    const reconnected = [...restored.replace(opening, { revision: prefix.at(-1).revision, activeAttempt: {
      attemptId: start.attemptId, startedAfterSeq, turn: start.turn, step: start.step, nextIndex: prefix.length,
      stream: prefix.map(({ time, chunk }) => ({ type: 'chunk', time, chunk })),
    } })];
    assert.deepEqual(project(reconnected).map(node => node.data), project(visible).map(node => node.data),
      'Reconnect must retain exactly the active public prefix');
    for (const frame of chunks.slice(prefix.length)) {
      const result = restored.acceptFrame(frame); assert.equal(result?.type, 'transient'); reconnected.push(result.entry);
    }
    assert.equal(restored.acceptDurable({ type: 'event', event: message }), undefined);
    const settled = restored.acceptFrame(end);
    assert.equal(settled?.type, message.data.interrupted ? 'settlement' : 'publish');
    assert.equal(settled.entry.event.seq, message.seq);
    let entries = [...reconnected, settled.entry];
    if (settled.type === 'settlement') entries = entries.filter(entry => entry.type !== 'transient');
    else {
      const stop = events.find(event => event.seq > message.seq && event.type === 'step/end'
        && event.data.turn === start.turn && event.data.step === start.step);
      assert.ok(stop, 'The real owning Step end is required');
      const result = restored.acceptDurable({ type: 'event', event: stop });
      assert.equal(result.retireAttemptId, start.attemptId);
      entries = [...entries.filter(entry => entry.type !== 'transient'), result.entry];
    }
    const finalNodes = project(entries).filter(isCurrent);
    assert.equal(finalNodes.length, 1);
    assert.equal(finalNodes[0].data.status, message.data.interrupted ? 'interrupted' : 'settled');
    assert.equal(reasoningTextFromBlocks(finalNodes[0].data.blocks), messageReasoning);
    if (message.data.interrupted) assert.ok(!finalNodes[0].data.blocks.some(block => block.kind === 'tool-call'));
    cases.push({ turn: start.turn, step: start.step, startedAfterSeq, prefixChunks: prefix.length,
      reconnectEqual: true, settlementAccepted: true, prefixNotDuplicated: true, status: finalNodes[0].data.status });
  }
  assert.ok(cases.length, 'At least one actual reasoning-bearing attempt is required');
  return cases;
}

async function loadHistory(historyRoot) {
  const root = resolve(historyRoot);
  // The Host root also contains the installed package/dependency graph. Never
  // traverse that graph or silently accept unrelated event journals as history.
  const sessionRoot = join(root, 'sessions');
  const sessionPaths = (await readdir(sessionRoot, { recursive: true })).filter((p) => p.endsWith('.jsonl'));
  assert.equal(sessionPaths.length, 1, 'This proof requires one unambiguous actual Session');
  let events = [];
  for (const p of sessionPaths) {
    const lines = (await readFile(join(sessionRoot, p), 'utf8')).trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      events.push(JSON.parse(line));
    }
  }
  events = events.filter((e) => Number.isSafeInteger(e?.seq) && typeof e.type === 'string');
  const frames = (await readFile(join(root, 'assistant-stream.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { events, frames };
}

// --- CLI ---
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({ options: { source: { type: 'string' }, 'history-root': { type: 'string' }, 'output-dir': { type: 'string' } } });
  assert.ok(values.source && values['history-root'], '--source <maintained DSH> --history-root <actual thinking Host evidence> required');
  const { events, frames } = await loadHistory(values['history-root']);
  const facts = await verifyNativeThinkingView({
    source: resolve(values.source),
    events,
    frames,
    outputDir: values['output-dir'] ? resolve(values['output-dir']) : undefined,
  });
  console.log(JSON.stringify(facts, null, 2));
}
