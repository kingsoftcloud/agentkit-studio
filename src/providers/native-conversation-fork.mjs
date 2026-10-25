import { createHash } from 'node:crypto';
import { canonical, configure, copy, invariant, parseNativeJson, projectSessionHistory, terminal } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { readNativeDshOwnership } from '../../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Resolve an exact closed-turn fork prefix into data for a fresh Native Run.
 * Only the new Session's first admission queries the source. Cold recovery uses
 * already-admitted bytes; source defaults/heads/attachments cannot reinterpret it. */
export async function nativeConversationForkSeed({ ctx, agent, store, scope, turn, profile, tools, policies, signal }) {
  signal.throwIfAborted();
  const session = agent.session, head = store.sessionHead(scope, String(session.id));
  if (head) {
    const seed = head.turnId === String(turn) ? store.load(scope, head.runId).configuration.conversationSeed : undefined;
    return seed === undefined ? undefined : copy(seed);
  }
  if (!session.header?.isSeeded || !session.header.parentSession) return undefined;
  invariant(typeof session.snapshotEvents === 'function' && typeof session.isOwnSeq === 'function', 'native_conversation_fork_boundary_unavailable');
  const events = session.snapshotEvents();
  const marker = events.find(event => event.type === 'session/end-seed' && event.data.inherited === true && session.isOwnSeq(event.seq));
  invariant(marker && marker.seq > 0 && !events.slice(marker.seq + 1).some(event => event.type === 'session/end-seed' && event.data.inherited === true),
    'native_conversation_fork_boundary_unavailable');
  const prefix = copy(events.slice(0, marker.seq)), boundarySeq = marker.seq - 1;
  const sessionId = String(session.id), parentSessionId = String(session.header.parentSession), transcriptDigest = hash(prefix);
  const query = ctx.get('sessionQuery');
  invariant(typeof query?.observeSession === 'function', 'native_conversation_fork_source_unavailable');
  const observed = await query.observeSession(parentSessionId);
  try {
    signal.throwIfAborted();
    invariant(agent.session === session && String(session.id) === sessionId && session.header.parentSession === parentSessionId
      && hash(session.snapshotEvents().slice(0, marker.seq)) === transcriptDigest, 'native_conversation_fork_session_changed');
    invariant(observed.header.id === parentSessionId
      && canonical(observed.events.slice(0, marker.seq)) === canonical(prefix), 'native_conversation_fork_source_changed');
    let owner = null, openTurn = false, selectedOwner = null, selectedEnd = null;
    for (const event of prefix) {
      if (event.type === 'turn/start') { invariant(!openTurn, 'native_conversation_fork_invalid_transcript'); openTurn = true; owner = null; }
      if (event.type === 'turn/owner') { invariant(openTurn, 'native_conversation_fork_invalid_transcript'); owner = event.data; }
      if (event.type === 'turn/end') { selectedOwner = owner; selectedEnd = event; openTurn = false; owner = null; }
    }
    // DSH's arbitrary open cuts add synthetic closers *after* the inherited
    // boundary. Do not accidentally import the source's later full snapshot.
    invariant(!openTurn && selectedEnd?.data.reason?.kind !== 'forked', 'native_conversation_fork_open_boundary');
    invariant(selectedOwner?.engine === NATIVE_DSH_TURN_CONTRACT, 'native_conversation_fork_native_boundary_required');
    const facts = parseNativeJson(selectedOwner.binding);
    const admission = readNativeDshOwnership(selectedOwner, { sessionId: facts.identity?.sessionId, turn: selectedOwner.turn });
    invariant(canonical(admission.identity.scope) === canonical(scope)
      && admission.identity.sessionId !== String(session.id), 'native_conversation_fork_scope_mismatch');
    const record = store.load(scope, admission.identity.runId), snapshot = record.snapshot;
    invariant(terminal(snapshot.phase) && Object.entries(admission.identity).every(([key, value]) => canonical(snapshot[key]) === canonical(value))
      && snapshot.configDigest === admission.configDigest && hash(record.configuration) === admission.configDigest
      && canonical(record.configuration) === canonical(admission.configuration), 'native_conversation_fork_checkpoint_mismatch');
    const normalized = configure({ profile, contract: { objective: 'Project fork history' }, hostBindingDigest: 'fork-history-projection' });
    const messages = projectSessionHistory(record, normalized, hash, { identityNamespace: String(session.id) });
    for (const message of messages) {
      delete message.operatorGuidance; delete message.inputId; delete message.inputGoalRevision;
      // The frozen seed also travels in the DSH turn/owner admission. Keep
      // provider-private reasoning/signatures in the original private ledger,
      // rather than publishing them inside a new Session ownership event.
      delete message.providerReplay; delete message.replayToolIds; delete message.providerReplayProjection;
    }
    const discovered = (snapshot.toolDiscovery?.discovered ?? []).filter(name => tools.some(tool => tool.name === name && tool.discovery));
    return { contract: 'native-conversation-fork/v1', source: { parentSessionId,
      sessionId: snapshot.sessionId, runId: snapshot.runId, turnId: snapshot.turnId, boundarySeq,
      snapshotRevision: snapshot.revision, configDigest: snapshot.configDigest, snapshotDigest: hash(snapshot), transcriptDigest },
      messages, ...(policies.todoPolicy && snapshot.todos ? { todos: copy(snapshot.todos.items) } : {}),
      ...(policies.toolDiscoveryPolicy ? { discoveredToolNames: discovered } : {}) };
  } finally { observed[Symbol.dispose]?.(); }
}
