/** Host-private A2A 1.0 Task projection. The protocol Task and its fact UUID
 * receipts commit together, before the admission iterator is acknowledged.
 * This is a single-Host adapter; it does not claim shared managed SQL storage. */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, copy, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { atomicPrivate, privateDirectory, readAll, tryLock } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';

export const A2A_INBOUND_TASK_STORE = 'agentkit.a2a-inbound-task-store/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.trim() && value.length <= 4096 && !value.includes('\0');
const terminal = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const integer = value => Number.isSafeInteger(value) || typeof value === 'bigint';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const check = condition => invariant(condition, 'A2A_INBOUND_TASK_INVALID');
const messageId = message => message?.messageId ?? message?.message_id;
const integrationMetadata = { 'https://google.github.io/adk-docs/a2a/a2a-extension/': { adk_agent_executor_v2: true } };

function scope(identity) {
  const fields = ['accountId', 'tenantId', 'callerPrincipalType', 'callerPrincipalId', 'callerRuntimeId', 'subAccountId',
    'targetAgentId', 'targetRuntimeId', 'targetA2aAgentId'];
  check(object(identity) && object(identity.taskBinding));
  const owner = Object.fromEntries(fields.map(key => [key, identity[key]]));
  check(fields.filter(key => !['callerRuntimeId', 'subAccountId'].includes(key)).every(key => id(owner[key]))
    && ['runtime', 'user'].includes(owner.callerPrincipalType)
    && (owner.callerPrincipalType === 'runtime' ? id(owner.callerRuntimeId) && owner.subAccountId === null
      : owner.callerRuntimeId === null && id(owner.subAccountId))
    && id(identity.taskBinding.platformTaskId) && id(identity.taskBinding.targetVersionId));
  return { owner, platformTaskId: identity.taskBinding.platformTaskId, targetVersionId: identity.taskBinding.targetVersionId };
}
function wireMessage(message) {
  check(object(message) && id(messageId(message)) && messageId(message).length <= 128 && Array.isArray(message.parts)
    && message.parts.length > 0 && message.parts.length <= 4096
    && (message.messageId === undefined || message.message_id === undefined || message.messageId === message.message_id)
    && (message.role === undefined || ['ROLE_USER', 'user'].includes(message.role)));
  const result = copy(message);
  result.messageId = messageId(message); result.role = 'ROLE_USER'; delete result.message_id;
  for (const [camel, snake] of [['taskId', 'task_id'], ['contextId', 'context_id']]) {
    check(message[camel] === undefined || message[snake] === undefined || message[camel] === message[snake]);
    if (message[camel] !== undefined || message[snake] !== undefined) result[camel] = message[camel] ?? message[snake];
    delete result[snake];
  }
  return result;
}
function agentMessage(record, suffix, text, metadata) {
  return { messageId: hash([record.task.id, suffix]), role: 'ROLE_AGENT', taskId: record.task.id,
    contextId: record.task.contextId, parts: [{ text }], ...(metadata ? { metadata: copy(metadata) } : {}) };
}
function status(record, state, fact, updates, message) {
  invariant(!terminal.has(record.task.status.state) || record.task.status.state === state, 'A2A_INBOUND_TERMINAL_CONFLICT');
  record.task.status = { state, timestamp: fact.timestamp, ...(message ? { message } : {}) };
  updates.push({ statusUpdate: { taskId: record.task.id, contextId: record.task.contextId,
    status: copy(record.task.status), metadata: copy(integrationMetadata), final: terminal.has(state) || state === 'TASK_STATE_INPUT_REQUIRED' } });
}
function output(record, refs) {
  return refs.map(ref => {
    check(object(ref) && id(ref.scope_id) && id(ref.item_id) && (ref.part_id == null || id(ref.part_id)));
    const item = record.items[hash([ref.scope_id, ref.item_id])];
    if (!item || item.kind !== 'message') return '';
    return ref.part_id == null ? item.parts.map(part => part.text).join('') : item.parts.find(part => part.id === ref.part_id)?.text ?? '';
  }).join('');
}
function project(record, fact, updates, includeReasoning) {
  check(object(fact) && fact.schema_version === 1 && uuid(fact.event_id) && integer(fact.seq) && fact.seq >= 1
    && id(fact.session_id) && id(fact.run_id) && id(fact.timestamp) && Number.isFinite(Date.parse(fact.timestamp))
    && object(fact.payload) && ['control', 'runtime', 'interaction', 'workflow', 'schedule', 'job', 'relationship'].includes(fact.family)
    && Number.isSafeInteger(fact.family_version) && fact.family_version >= 1
    && (!['runtime', 'control', 'interaction'].includes(fact.family) || fact.family_version === (fact.family === 'runtime' ? 2 : 1)));
  invariant(record.sessionId === fact.session_id && (!record.runId || record.runId === fact.run_id), 'A2A_INBOUND_TASK_BINDING_CONFLICT');
  record.runId = fact.run_id;
  const p = fact.payload;
  if (fact.family === 'runtime') {
    check(p.schema_version === 2 && p.run_id === record.runId && p.event_type === fact.event_type && id(p.scope_id));
    if (['run.completed', 'run.failed', 'run.canceled', 'run.interrupted'].includes(p.event_type)) {
      const next = p.event_type === 'run.completed' ? 'completed' : p.event_type === 'run.canceled' ? 'cancelled'
        : p.event_type === 'run.interrupted' ? 'interrupted' : 'failed';
      invariant(!record.runtimeTerminal || record.runtimeTerminal === next, 'A2A_INBOUND_TERMINAL_CONFLICT');
      if (next === 'completed') {
        check(Array.isArray(p.output_refs)); record.outputText = p.output_refs.length ? output(record, p.output_refs)
          : record.task.artifacts.filter(artifact => artifact.name === 'response').map(artifact => artifact.parts[0].text).join('');
      }
      record.runtimeTerminal = next;
      // A runtime hint cannot outrun the canonical control boundary.
      return;
    }
    if (!['item.updated', 'item.completed', 'item.snapshot_replaced'].includes(p.event_type)) return;
    if (p.item_kind !== 'message' && !(includeReasoning && p.item_kind === 'reasoning')) return;
    check(id(p.item_id));
    const key = hash([p.scope_id, p.item_id]), previous = record.items[key];
    invariant(!previous || previous.kind === p.item_kind && !previous.closed, 'A2A_INBOUND_ITEM_CONFLICT');
    const item = previous ?? { kind: p.item_kind, parts: [], artifactId: hash([record.task.id, p.scope_id, p.item_id]) };
    if (p.event_type === 'item.updated') {
      check(['append', 'replace'].includes(p.op) && object(p.update));
      if (p.update.content_type !== 'text') return;
      check(id(p.update.part_id) && typeof p.update.text === 'string');
      let part = item.parts.find(part => part.id === p.update.part_id);
      if (!part) { part = { id: p.update.part_id, text: '' }; item.parts.push(part); }
      part.text = p.op === 'append' ? part.text + p.update.text : p.update.text;
    } else {
      check(Array.isArray(p.snapshot?.parts));
      const parts = p.snapshot.parts.filter(part => part?.content_type === 'text');
      check(parts.every(part => id(part.part_id) && typeof part.text === 'string')
        && new Set(parts.map(part => part.part_id)).size === parts.length);
      item.parts = parts.map(part => ({ id: part.part_id, text: part.text }));
    }
    record.items[key] = item;
    item.closed = p.event_type === 'item.completed';
    const artifact = { artifactId: item.artifactId, name: item.kind === 'reasoning' ? 'reasoning' : 'response',
      parts: [{ text: item.parts.map(part => part.text).join(''), metadata: item.kind === 'reasoning'
        ? { adk_thought: true } : { ksadk_output_snapshot: true } }] };
    const index = record.task.artifacts.findIndex(value => value.artifactId === artifact.artifactId);
    if (index < 0) record.task.artifacts.push(artifact); else record.task.artifacts[index] = artifact;
    updates.push({ artifactUpdate: { taskId: record.task.id, contextId: record.task.contextId,
      artifact: copy(artifact), append: false, lastChunk: p.event_type === 'item.completed' } });
  } else if (fact.family === 'interaction' && fact.event_type === 'interaction.requested') {
    check(id(p.interaction_id) && Number.isSafeInteger(p.revision) && p.revision >= 0
      && ['approval', 'structured_input'].includes(p.kind) && object(p.request));
    const presentation = p.request.presentation ?? {};
    const title = typeof presentation.title === 'string' ? presentation.title : 'Remote approval';
    const description = typeof presentation.description === 'string' ? presentation.description : 'Input required';
    const metadata = p.kind === 'approval' ? { input_schema: { type: 'string', enum: ['approve', 'reject'] },
      ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'], presentation: { title, description } } }
      : { input_schema: copy(p.request.request_schema) };
    check(p.kind !== 'structured_input' || object(p.request.request_schema));
    record.pending = { run_id: record.runId, interaction_id: p.interaction_id, expected_revision: p.revision, kind: p.kind };
    record.pendingMessage = agentMessage(record, fact.event_id, description, metadata);
  } else if (fact.family === 'control' && fact.event_type === 'control.run_transition') {
    check(p.run_id === record.runId);
    if (p.state === 'waiting') {
      invariant(record.pending, 'A2A_INBOUND_INTERACTION_MISSING');
      status(record, 'TASK_STATE_INPUT_REQUIRED', fact, updates, record.pendingMessage);
    } else if (['completed', 'cancelled', 'failed', 'interrupted'].includes(p.state)) {
      invariant(p.state !== 'completed' || record.runtimeTerminal === 'completed', 'A2A_INBOUND_COMPLETION_UNCONFIRMED');
      invariant(!record.runtimeTerminal || record.runtimeTerminal === p.state
        || p.state === 'interrupted' && record.runtimeTerminal === 'failed', 'A2A_INBOUND_TERMINAL_CONFLICT');
      for (const item of Object.values(record.items)) if (!item.closed) {
        const artifact = record.task.artifacts.find(artifact => artifact.artifactId === item.artifactId);
        check(artifact); updates.push({ artifactUpdate: { taskId: record.task.id, contextId: record.task.contextId,
          artifact: copy(artifact), append: false, lastChunk: true } }); item.closed = true;
      }
      status(record, p.state === 'completed' ? 'TASK_STATE_COMPLETED' : p.state === 'cancelled' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED',
        fact, updates, agentMessage(record, fact.event_id, p.state === 'completed' ? record.outputText : p.state === 'cancelled'
          ? 'Request canceled' : 'A2A task execution failed'));
      record.pending = null; record.pendingMessage = null;
    } else if (p.state === 'running') status(record, 'TASK_STATE_WORKING', fact, updates);
  }
}

export function createA2aInboundTaskStore({ directory, assertCurrent, includeReasoning = false } = {}) {
  check(typeof directory === 'string' && typeof assertCurrent === 'function' && typeof includeReasoning === 'boolean');
  privateDirectory(directory, true);
  function guard() {
    const current = assertCurrent(); if (current && typeof current.then === 'function') void Promise.resolve(current).catch(() => {});
    invariant(current === true, 'A2A_INBOUND_AUTHORITY_LOST'); privateDirectory(directory);
  }
  function context(identity) {
    guard(); const binding = scope(identity), key = hash({ owner: binding.owner, platformTaskId: binding.platformTaskId });
    return { binding, key, path: join(directory, key + '.json') };
  }
  function read(ctx) {
    guard(); let record;
    try { record = parseNativeJson(readAll(ctx.path)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    check(record.contract === A2A_INBOUND_TASK_STORE && record.key === ctx.key && object(record.task) && object(record.seen)
      && object(record.inputs) && object(record.items) && object(record.productOutbox)
      && record.includeReasoning === includeReasoning && integer(record.cursor) && record.cursor >= 0);
    invariant(canonical(record.binding) === canonical(ctx.binding), 'A2A_INBOUND_TASK_BINDING_CONFLICT'); return record;
  }
  function transaction(ctx, change) {
    guard(); const release = tryLock(join(directory, ctx.key + '.sqlite'), 5000); invariant(release, 'A2A_INBOUND_STORE_BUSY');
    try {
      const result = change(read(ctx)); guard();
      const bytes = canonical(result.record); invariant(Buffer.byteLength(bytes) <= 8 * 1024 ** 2, 'A2A_INBOUND_STORE_LIMIT');
      atomicPrivate(ctx.path, bytes); return copy(result.value);
    } finally { release(); }
  }
  function address(record, { taskId, contextId } = {}) {
    invariant(record && (taskId === undefined || record.task.id === taskId)
      && (contextId === undefined || record.task.contextId === contextId), 'A2A_INBOUND_TASK_NOT_FOUND');
  }
  const view = record => ({ task: copy(record.task), cursor: record.cursor, runId: record.runId,
    pending: copy(record.pending), sessionId: record.sessionId });
  return Object.freeze({ contract: A2A_INBOUND_TASK_STORE,
    prepare(identity, { message, taskId, contextId } = {}) {
      const normalized = wireMessage(message), ctx = context(identity);
      check((taskId === undefined || id(taskId)) && (contextId === undefined || id(contextId)));
      return transaction(ctx, existing => {
        const record = existing ?? { contract: A2A_INBOUND_TASK_STORE, key: ctx.key, binding: ctx.binding, includeReasoning,
          task: { id: taskId ?? randomUUID(), contextId: contextId ?? randomUUID(), status: { state: 'TASK_STATE_SUBMITTED' },
            metadata: copy(integrationMetadata), history: [], artifacts: [] },
          inputs: {}, seen: {}, productOutbox: {}, cursor: 0, sessionId: null, runId: null, runtimeTerminal: null,
          pending: null, pendingMessage: null, items: {}, outputText: '' };
        address(record, { taskId, contextId });
        const key = hash(messageId(message)), previous = record.inputs[key], digest = hash(message);
        invariant(!previous || previous.digest === digest, 'A2A_INBOUND_COMMAND_CONFLICT');
        if (!previous) {
          invariant(!existing || taskId === record.task.id && record.task.status.state === 'TASK_STATE_INPUT_REQUIRED'
            && record.pending, 'A2A_INBOUND_CONTINUATION_CONFLICT');
          invariant(!terminal.has(record.task.status.state), 'A2A_INBOUND_TERMINAL_CONFLICT');
          record.inputs[key] = { digest, message: normalized, admitted: false, continuation: copy(record.pending) };
        }
        return { record, value: { ...view(record), continuation: copy(record.inputs[key].continuation) } };
      });
    },
    get(identity, ids) { const record = read(context(identity)); address(record, ids); return view(record); },
    admitted(identity, { taskId, contextId, message, submission }) {
      const ctx = context(identity);
      return transaction(ctx, record => {
        address(record, { taskId, contextId });
        const input = record.inputs[hash(messageId(message))];
        check(input && input.digest === hash(message) && ['accepted', 'duplicate'].includes(submission?.receipt?.status));
        invariant((!record.sessionId || record.sessionId === submission.sessionId) && submission.agentId === ctx.binding.owner.targetAgentId
          && (!record.runId || !submission.receipt.run_id || record.runId === submission.receipt.run_id), 'A2A_INBOUND_TASK_BINDING_CONFLICT');
        record.sessionId = submission.sessionId; record.runId ??= submission.receipt.run_id ?? null;
        if (!input.admitted) {
          invariant(!terminal.has(record.task.status.state), 'A2A_INBOUND_TERMINAL_CONFLICT');
          record.task.history.push({ ...input.message, taskId: record.task.id, contextId: record.task.contextId }); input.admitted = true;
          record.task.status = { state: 'TASK_STATE_WORKING' }; record.pending = null; record.pendingMessage = null;
        }
        return { record, value: view(record) };
      });
    },
    apply(identity, ids, fact) {
      const ctx = context(identity);
      return transaction(ctx, record => {
        address(record, ids); check(uuid(fact?.event_id)); const digest = hash(fact), previous = record.seen[fact.event_id];
        if (previous) {
          invariant(previous.digest === digest, 'A2A_INBOUND_EVENT_CONFLICT');
          return { record, value: { ...view(record), updates: previous.updates, duplicate: true } };
        }
        invariant(integer(fact.seq) && fact.seq > record.cursor, 'A2A_INBOUND_EVENT_ORDER_CONFLICT');
        invariant(!terminal.has(record.task.status.state), 'A2A_INBOUND_TERMINAL_CONFLICT');
        invariant(Object.keys(record.seen).length < 10000, 'A2A_INBOUND_STORE_LIMIT');
        const updates = []; project(record, fact, updates, includeReasoning);
        if (ctx.binding.owner.callerPrincipalType === 'user' && fact.family === 'control' && fact.event_type === 'control.run_transition'
          && ['running', 'waiting', 'completed', 'failed', 'interrupted', 'cancelled'].includes(fact.payload.state))
          record.productOutbox[fact.event_id] = { digest, fact: copy(fact), state: 'pending', failures: 0, error: null };
        record.cursor = fact.seq; record.seen[fact.event_id] = { digest, updates };
        return { record, value: { ...view(record), updates, duplicate: false } };
      });
    },
    // These callbacks are Host-only. They never accept caller-supplied paths
    // or change a Task/Run; the shared dispatcher may retry only these already
    // committed facts, using Server event UUID idempotency after a lost ACK.
    productDeliveryLock() { guard(); return tryLock(join(directory, 'product-delivery.sqlite')); },
    pendingProduct() {
      guard();
      for (const name of readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort()) {
        const raw = parseNativeJson(readAll(join(directory, name))), ctx = { key: name.slice(0, -5), binding: raw.binding, path: join(directory, name) };
        check(object(raw.binding) && hash({ owner: raw.binding.owner, platformTaskId: raw.binding.platformTaskId }) === ctx.key);
        const record = read(ctx), rows = Object.values(record.productOutbox).filter(row => row.state === 'pending').sort((a, b) =>
          a.fact.seq < b.fact.seq ? -1 : a.fact.seq > b.fact.seq ? 1 : 0).slice(0, 100);
        if (!rows.length) continue;
        check(record.binding.owner.callerPrincipalType === 'user' && rows.every(row => row.digest === hash(row.fact)
          && record.seen[row.fact.event_id]?.digest === row.digest));
        return { taskKey: ctx.key, binding: copy(record.binding), platformTaskId: record.binding.platformTaskId,
          targetVersionId: record.binding.targetVersionId, remoteTaskId: record.task.id, remoteContextId: record.task.contextId,
          events: rows.map(row => copy(row.fact)) };
      }
      return null;
    },
    updateProduct(batch, action, failure = null) {
      check(object(batch) && ['acknowledge', 'deadLetter', 'failure'].includes(action));
      const ctx = { key: batch.taskKey, binding: batch.binding, path: join(directory, batch.taskKey + '.json') };
      check(/^[a-f0-9]{64}$/u.test(ctx.key));
      return transaction(ctx, record => {
        address(record, { taskId: batch.remoteTaskId, contextId: batch.remoteContextId });
        for (const fact of batch.events) {
          const row = record.productOutbox[fact.event_id]; check(row && row.digest === hash(fact));
          if (row.state !== 'pending') continue;
          if (action === 'acknowledge') row.state = 'acknowledged';
          else { row.error = failure; row.failures++; if (action === 'deadLetter') row.state = 'deadLetter'; }
        }
        return { record, value: null };
      });
    },
  });
}
