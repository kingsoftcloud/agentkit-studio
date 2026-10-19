/** Keyless native-carrier feasibility probes. No production carrier or policy is installed. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssistantNativeCarrierService } from '../src/assistant-native-carrier.mjs';

if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Set AGENTKIT_DSH_ROOT to the built pinned DSH checkout');
const root = resolve(process.env.AGENTKIT_DSH_ROOT);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(commit, '687f282e8625c6b8d11ff58211a90524be2e4317');
const require = createRequire(join(root, 'packages/api/session-controller/package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const { Context } = await load('cordis');
const sessionModule = await load('dsh-session');
const { createSystemMessage } = await load('dsh-llm');
const { Peer } = await load('dsh-client-connection');
const clientGateway = await load('dsh-api-gateway/client');
const clientConnection = await load('dsh-client-connection/client');
const clientTypert = await load('dsh-typert-registry/client');

// Evaluate the shipping public /client bundle through its own generated factory.
// These are the real exported classes, not a replacement Controller implementation.
let registration;
new Function('window', await readFile(join(root, 'packages/api/session-controller/lib/client.js'), 'utf8'))({
  __ModuleLoader__: { load(value) { assert.equal(registration, undefined); registration = value; } },
});
assert.equal(registration?.id, '@deepseek-ai/dsh-api-session-controller');
const dependencies = new Map([
  ['@deepseek-ai/cordis', await load('cordis')],
  ['@deepseek-ai/dsh-api-gateway/client', clientGateway],
  ['@deepseek-ai/dsh-client-store', await load('dsh-client-store')],
]);
const { SessionEventStream } = registration.factory(name => {
  assert.ok(dependencies.has(name), `Unexpected native bundle dependency: ${name}`);
  return dependencies.get(name);
});

const report = { evidence: 'native-non-owner-generation-and-session-journal-boundary', dshCommit: commit,
  dshSourceModified: Boolean(execFileSync('git', ['diff', 'HEAD', '--name-only'], { cwd: root, encoding: 'utf8' }).trim()),
  modelCalls: 0, networkCalls: 0, credentialsCreated: 0, productionPolicyChanged: false,
  fullControllerGraphQualified: false, productionCarrierImplemented: false, cases: [] };
const host = new Context(), client = new Context();
const cancelled = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
const until = async condition => {
  const end = Date.now() + 5000;
  while (!condition()) { if (Date.now() >= end) throw new Error('Native connection did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
let peer, removeSource;
try {
  await host.plugin((await load('dsh-typert-registry')).default);
  await host.plugin((await load('dsh-api-remote-access')).default);
  await host.plugin((await load('dsh-api-gateway')).default);
  await host.plugin(sessionModule.default);
  const session = host.sessions.create('assistant-native-privacy-proof');
  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage({ content: [{ type: 'text', text: 'synthetic-private-marker' }], source: { kind: 'test' } }) }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const raw = session.snapshotEvents();
  assert.deepEqual(raw.map(event => event.seq), [0, 1, 2]);

  // No owner principal, credential, global role or business permission is granted.
  peer = new Peer(host, { principal: { kind: 'assistant-feasibility-probe' }, interactions: 'answer' });
  removeSource = host.typertGateway.registerRemoteEvents(async function* (signal) { await cancelled(signal); }, { home: '' });
  const calls = [];
  clientConnection.installConnection(client, { interactions: 'answer', location: { hostname: 'assistant-proof.invalid' }, transport: { ownsHost: false,
    rpc: {
      call: async (_channel, endpoint) => { throw new Error(`Unexpected unary RPC: ${endpoint}`); },
      open: async function* (channel, endpoint, payload, signal, uplink) {
        calls.push({ channel, endpoint });
        assert.equal(channel, '/api'); assert.equal(endpoint, '$events');
        yield* await host.typertGateway.wireStream.open(endpoint, payload, uplink ?? (async function* () {})(), peer, signal);
      },
    },
  } });
  clientTypert.apply(client);
  clientGateway.apply(client);
  await until(() => client.connection.generation.getSnapshot() !== undefined);
  assert.equal(client.connection.isLoopback, false);
  assert.equal(host.typertGateway.hasLiveClient(), false, 'non-owner event generation is not an approval answerer');
  assert.deepEqual(calls, [{ channel: '/api', endpoint: '$events' }]);
  report.cases.push({ name: 'real-native-non-owner-connection-generation', passed: true, owner: false, businessPermissionsGranted: false });

  async function probe(name, events, { omitAssistantBaseline = false, expectError } = {}) {
    let observed, request;
    const remote = {
      $stream: options => client.remote.$stream(options),
      session: {
        follow: async function* (input, signal) {
          request = input;
          yield { type: 'snapshot', header: session.header, cursor: 2,
            records: events.map(event => ({ type: 'event', event })), hasMore: false,
            projections: { asOfSeq: 2, values: {} },
            ...omitAssistantBaseline ? {} : { assistantStream: { revision: 0 } } };
          await cancelled(signal);
        },
        page: async () => { throw new Error('Unexpected page read'); },
      },
    };
    const stream = new SessionEventStream(remote, { kind: 'session', sessionId: session.id }, {
      publish: value => { observed = value; }, failed: error => { throw error; },
    });
    try {
      if (expectError) {
        let failure;
        try { await stream.open({}); } catch (error) { failure = error; }
        assert.match(failure?.message || '', expectError);
        report.cases.push({ name, passed: true, accepted: false, error: failure.message });
      } else {
        await stream.open({}); assert.equal(observed?.entries.length, events.length);
        report.cases.push({ name, passed: true, accepted: true });
      }
      assert.equal(request.assistantStream, true, 'native Controller always opts into assistant live frames');
      return observed;
    } finally { await stream.dispose(); }
  }

  await probe('complete-genuine-session-log-opens', raw);
  await probe('filtering-internal-event-preserving-real-seq-is-rejected', raw.filter(event => event.type !== 'system/message'), { expectError: /discontinuous/ });
  await probe('omitting-assistant-stream-baseline-is-rejected', raw, { omitAssistantBaseline: true, expectError: /omitted its opted-in opening baseline/ });

  const marked = raw.map(event => event.type === 'system/message' ? { ...event, ignorable: true } : event);
  const markedView = await probe('ignorable-is-not-a-redaction-marker', marked);
  assert.ok(JSON.stringify(markedView).includes('synthetic-private-marker'), 'ignorable does not remove known payloads');
  report.cases.at(-1).privateSyntheticPayloadStillPresent = true;
  await probe('ignorable-does-not-disable-known-surface-metadata-rules', raw.map(event => {
    if (event.type !== 'system/message') return event;
    const { surfaceOp: _surface, ...rest } = event; return { ...rest, ignorable: true };
  }), { expectError: /requires a surfaceOp marker/ });

  // The event-local validator is deliberately partial. Passing it alone must
  // never be treated as an official masked-payload contract.
  const masked = raw.map(event => event.type === 'system/message' ? { ...event, data: { redacted: true } } : event);
  await probe('explicit-redacted-payload-passes-partial-wire-check-only', masked);
  assert.throws(() => sessionModule.deriveEventMessage(masked[1]), /undefined|content|message/);
  report.cases.at(-1).nativeMessageProjectionAccepted = false;
  report.cases.at(-1).supportedRedactionContract = false;

  // A presentation projection may retain a genuine event's envelope and a
  // schema-valid empty message. The native surface contract explicitly permits
  // empty system/developer/assistant content; do not confuse this with the
  // unsupported arbitrary { redacted: true } payload above.
  const emptyContent = raw.map(event => event.type === 'system/message'
    ? { ...event, data: { ...event.data, message: { ...event.data.message, content: [] } } } : event);
  const emptyView = await probe('schema-valid-empty-system-content-retains-real-surface-position', emptyContent);
  assert.equal(sessionModule.deriveEventMessage(emptyContent[1]), null);
  assert.ok(!JSON.stringify(emptyView).includes('synthetic-private-marker'));
  assert.ok(JSON.stringify(session.snapshotEvents()).includes('synthetic-private-marker'), 'presentation projection must not mutate durable events');
  assert.deepEqual(emptyContent.map(({ type, seq, time, surfaceOp }) => ({ type, seq, time, surfaceOp })),
    raw.map(({ type, seq, time, surfaceOp }) => ({ type, seq, time, surfaceOp })));
  report.cases.at(-1).nativeMessageProjectionAccepted = true;
  report.cases.at(-1).privateSyntheticPayloadRemoved = true;
  report.cases.at(-1).durableSessionUnchanged = true;

  const sourceMarked = raw.map(event => event.type === 'system/message' ? { ...event, sourceEventSeqs: [0] } : event);
  const sourceView = await probe('source-event-seqs-are-provenance-not-redaction', sourceMarked);
  assert.ok(JSON.stringify(sourceView).includes('synthetic-private-marker'));
  report.cases.at(-1).privateSyntheticPayloadStillPresent = true;

  const hidden = event => ({ type: 'agentkit/privacy-redacted', seq: event.seq, time: event.time,
    ignorable: true, data: { sourceSeq: event.seq } });
  const privateView = await probe('explicit-ignorable-private-event-retains-source-cursor', raw.map(hidden));
  assert.ok(!JSON.stringify(privateView).includes('synthetic-private-marker'));
  for (const event of raw.map(hidden)) assert.equal(sessionModule.deriveEventMessage(event), null);
  report.cases.at(-1).representation = 'public-projection-not-original-session-log';

  // Exercise the official journal's pagination, overlap de-duplication and
  // generation replacement using a one-for-one private projection.
  while (session.snapshotEvents().length < 9) session.append('turn/start', { turn: session.snapshotEvents().length });
  const fullRaw = session.snapshotEvents(), fullPublic = fullRaw.map(hidden);
  let opens = 0, closed = 0, current = [], terminal;
  const pages = [], publications = [];
  const remote = { $stream: options => client.remote.$stream(options), session: {
    follow: async function* (request, signal) {
      opens++;
      assert.deepEqual(request.address, { kind: 'session', sessionId: session.id });
      const tail = opens === 1 ? 5 : 7;
      try {
        yield { type: 'snapshot', header: session.header, cursor: tail,
          records: fullPublic.slice(tail - 2, tail + 1).map(event => ({ type: 'event', event })), hasMore: true,
          projections: { asOfSeq: tail, values: {} }, assistantStream: { revision: 0 } };
        yield { type: 'event', event: fullPublic[tail] }; // retransmitted tail is ignored
        yield { type: 'event', event: fullPublic[tail + 1] };
        yield { type: 'event', event: fullPublic[tail + 1] }; // duplicate live event is ignored
        await cancelled(signal);
      } finally { closed++; }
    },
    page: async request => {
      pages.push(request);
      return { ok: true, value: { records: fullPublic.slice(0, request.beforeSeq).map(event => ({ type: 'event', event })), hasMore: false } };
    },
  } };
  const journal = new SessionEventStream(remote, { kind: 'session', sessionId: session.id }, {
    publish: change => {
      publications.push(change.type);
      if (change.type === 'replace') current = [...change.entries];
      if (change.type === 'prepend') current = [...change.entries, ...current];
      if (change.type === 'append') current.push(change.entry);
    }, failed: error => { terminal = error; },
  });
  try {
    await journal.open({ maxMessages: 3 });
    await until(() => current.at(-1)?.event.seq === 6 || terminal);
    assert.equal(terminal, undefined);
    await journal.prepend({ beforeSeq: 3, maxMessages: 3 });
    assert.equal(pages[0].throughSeq, 6);
    assert.deepEqual(current.map(row => row.event.seq), [0, 1, 2, 3, 4, 5, 6]);
    await journal.prepend({ beforeSeq: 3, maxMessages: 3 });
    assert.deepEqual(current.map(row => row.event.seq), [0, 1, 2, 3, 4, 5, 6], 'older overlapping pages are deduplicated');
    journal.restart();
    await until(() => opens === 2 && current.at(-1)?.event.seq === 8 || terminal);
    assert.equal(terminal, undefined);
    assert.deepEqual(current.map(row => row.event.seq), [5, 6, 7, 8], 'native reconnect replaces its tail window');
    assert.equal(new Set(current.map(row => row.event.seq)).size, current.length);
    assert.ok(!JSON.stringify(current).includes('synthetic-private-marker'));
    for (const row of current) {
      assert.equal(row.event.data.sourceSeq, row.event.seq);
      assert.equal(row.event.time, fullRaw[row.event.seq].time);
    }
    report.cases.push({ name: 'native-private-projection-pagination-reconnect-and-deduplication', passed: true,
      sourceSequenceMapping: 'identity', paginationThroughSeq: pages[0].throughSeq, generations: opens, duplicates: 0 });
  } finally { await journal.dispose(); }
  assert.equal(closed, 2);
  report.cases.push({ name: 'native-private-journal-disposal-closes-every-generation', passed: true });

  const isolatedPeers = [];
  const adapter = createAssistantNativeCarrierService({ ctx: host, createPeer: options => {
    const scoped = new Peer(host, options); isolatedPeers.push(scoped); return scoped;
  } });
  try {
    const opened = adapter.open({ sessionId: session.id, runAssistant: async () => { throw new Error('No writes in native carrier probe'); } });
    const request = (operation, payload = {}) => adapter.request(session.id, operation, { carrierId: opened.carrierId, ...payload });
    await request('native-stream-open', { streamId: 'native-events', endpoint: '$events', payload: { args: {} } });
    const events = await request('native-stream-poll', { streamId: 'native-events' });
    assert.equal(events.items[0]?.type, 'ready'); assert.equal(events.items[0]?.host.home, '');
    assert.equal(host.typertGateway.hasLiveClient(), false);
    assert.equal(host.remoteAccess.decide({ principal: isolatedPeers[0].principal, action: 'session/prompt', resources: [{ kind: 'session', id: session.id }] }).kind, 'deny');
    assert.equal(host.remoteAccess.decide({ principal: isolatedPeers[0].principal, action: 'session/page', resources: [{ kind: 'session', id: 'foreign' }] }).kind, 'deny');
    assert.equal(host.remoteAccess.decide({ principal: isolatedPeers[0].principal, action: 'session/page', resources: [{ kind: 'session', id: session.id }] }).kind, 'allow');
    await assert.rejects(adapter.request('foreign', 'native-close', { carrierId: opened.carrierId }));
    await request('native-close'); assert.equal(isolatedPeers[0].signal.aborted, true);
    assert.equal(host.remoteAccess.decide({ principal: isolatedPeers[0].principal, action: 'session/page', resources: [{ kind: 'session', id: session.id }] }).kind, 'deny');
    report.cases.push({ name: 'real-native-carrier-read-policy-generation-foreign-refusal-and-release', passed: true, nativePromptPermission: false });
  } finally { await adapter.dispose(); }

  await peer.dispose();
  await until(() => client.connection.generation.getSnapshot() === undefined);
  report.cases.push({ name: 'native-peer-disposal-withdraws-client-generation', passed: true });
  report.remainingQualification = 'Schema-valid empty message presentation preserves genuine sequence and surface positions. A full carrier still requires every consumed event, projection, live frame, pagination and reconnect boundary to be privacy-audited; this probe alone does not qualify that carrier.';
} finally {
  await client.fiber.dispose();
  await peer?.dispose();
  await removeSource?.();
  await host.fiber.dispose();
}
const output = resolve(process.argv[2] || '.artifacts/assistant-native-carrier.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
