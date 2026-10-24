/** Durable inbound admission bridge. A verified Gateway request can ask the
 * real Server to admit its original Message; it cannot mint a local permit or
 * start a model/Run. Repeating an uncertain admission is explicit and retains
 * the same platform task, message and remote address. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical, copy, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { atomicPrivate, privateDirectory, readAll, tryLock } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';
import { parseA2aInboundSubmission, streamA2aInboundKernelFacts } from './native-a2a-inbound-kernel.mjs';
import { awaitA2aControl } from './native-a2a-controls.mjs';

export const A2A_INBOUND_ADMISSION = 'agentkit.a2a-inbound-admission/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.trim() && value.length <= 4096 && !value.includes('\0');
const accepted = submission => ['accepted', 'duplicate'].includes(submission?.receipt?.status);
function originalMessage(body) {
  let raw;
  try { raw = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { invariant(false, 'A2A_INBOUND_MESSAGE_INVALID'); }
  invariant(object(raw), 'A2A_INBOUND_MESSAGE_INVALID');
  if (Object.hasOwn(raw, 'jsonrpc')) {
    invariant(raw.jsonrpc === '2.0' && ['message/send', 'message/stream', 'SendMessage', 'SendStreamingMessage'].includes(raw.method),
      'A2A_INBOUND_MESSAGE_INVALID'); raw = raw.params;
  }
  invariant(object(raw?.message), 'A2A_INBOUND_MESSAGE_INVALID');
  const message = raw.message, messageId = message.messageId ?? message.message_id;
  invariant(id(messageId) && messageId.length <= 128
    && (message.messageId === undefined || message.message_id === undefined || message.messageId === message.message_id), 'A2A_INBOUND_MESSAGE_INVALID');
  return { message: copy(message), messageId };
}

export function createA2aInboundAdmission({ directory, verifier, controlPlane, events, assertCurrent } = {}) {
  invariant(typeof directory === 'string' && typeof verifier?.verify === 'function'
    && controlPlane?.binding?.contract === 'agentkit.a2a-internal-control-plane/v1'
    && typeof controlPlane.submitInboundMessage === 'function' && typeof controlPlane.cancelInboundTask === 'function'
    && typeof assertCurrent === 'function', 'A2A_INBOUND_CONFIGURATION_INVALID');
  const verify = verifier.verify, submit = controlPlane.submitInboundMessage, cancel = controlPlane.cancelInboundTask;
  const planeBinding = canonical(controlPlane.binding), lifetime = new AbortController();
  privateDirectory(directory, true);
  function guard(signal) {
    signal.throwIfAborted(); const verdict = assertCurrent();
    if (verdict && typeof verdict.then === 'function') void Promise.resolve(verdict).catch(() => {});
    invariant(verdict === true && verifier.verify === verify && controlPlane.submitInboundMessage === submit
      && controlPlane.cancelInboundTask === cancel && canonical(controlPlane.binding) === planeBinding, 'A2A_INBOUND_AUTHORITY_LOST');
    signal.throwIfAborted(); return true;
  }
  function authorize(input, operations) {
    invariant(input?.signal instanceof AbortSignal && object(input.request) && input.request.body instanceof Uint8Array
      && input.request.body.byteLength <= 2 * 1024 ** 2 && id(input.remoteTaskId) && id(input.remoteContextId), 'A2A_INBOUND_REQUEST_INVALID');
    const signal = AbortSignal.any([input.signal, lifetime.signal]); guard(signal);
    const request = { method: input.request.method, path: input.request.path, query: input.request.query,
      headers: { ...input.request.headers }, body: Uint8Array.from(input.request.body) };
    const identity = copy(verify.call(verifier, request)); guard(signal);
    invariant(identity.verifiedBodySha256 === sha(request.body) && operations.includes(identity.taskBinding?.operation), 'A2A_INBOUND_PROVENANCE_INVALID');
    const owner = { accountId: identity.accountId, tenantId: identity.tenantId, callerPrincipalType: identity.callerPrincipalType,
      callerPrincipalId: identity.callerPrincipalId, callerRuntimeId: identity.callerRuntimeId, subAccountId: identity.subAccountId,
      targetAgentId: identity.targetAgentId, targetRuntimeId: identity.targetRuntimeId, targetA2aAgentId: identity.targetA2aAgentId };
    const binding = { owner, platformTaskId: identity.taskBinding.platformTaskId, targetVersionId: identity.taskBinding.targetVersionId,
      remoteTaskId: input.remoteTaskId, remoteContextId: input.remoteContextId, planeBinding };
    const key = hash({ owner, platformTaskId: binding.platformTaskId });
    return { signal, request, identity, binding, key };
  }
  function read(ctx) {
    guard(ctx.signal); privateDirectory(directory);
    let record;
    try { record = parseNativeJson(readAll(join(directory, `${ctx.key}.json`))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    invariant(record.contract === A2A_INBOUND_ADMISSION && record.key === ctx.key
      && canonical(record.binding) === canonical(ctx.binding) && object(record.operations), 'A2A_INBOUND_BINDING_CONFLICT');
    for (const [key, op] of Object.entries(record.operations)) {
      invariant(object(op) && ['send', 'cancel'].includes(op.kind) && object(op.fields)
        && op.digest === hash(op.fields) && key === hash({ kind: op.kind, id: op.kind === 'send'
          ? op.fields.message?.messageId ?? op.fields.message?.message_id : op.fields.runId })
        && ['prepared', 'unknown', 'resolved'].includes(op.phase)
        && (Number.isSafeInteger(op.cursor) || typeof op.cursor === 'bigint') && op.cursor >= 0
        && (Number.isSafeInteger(op.observedCursor) || typeof op.observedCursor === 'bigint') && op.observedCursor >= op.cursor, 'A2A_INBOUND_RECORD_INVALID');
      if (op.submission) {
        const s = op.submission;
        parseA2aInboundSubmission({ SessionId: s.sessionId, AgentId: s.agentId, CommandId: s.receipt?.command_id, Receipt: s.receipt });
        invariant(s.agentId === ctx.identity.targetAgentId, 'A2A_INBOUND_TARGET_CONFLICT');
      }
    }
    invariant(record.latestSend === null || record.operations[record.latestSend]?.kind === 'send'
      && accepted(record.operations[record.latestSend].submission), 'A2A_INBOUND_RECORD_INVALID');
    invariant(record.latestAdmission === null || accepted(record.operations[record.latestAdmission]?.submission), 'A2A_INBOUND_RECORD_INVALID');
    return record;
  }
  function update(ctx, change) {
    guard(ctx.signal); privateDirectory(directory);
    const release = tryLock(join(directory, `${ctx.key}.state.sqlite`), 5000);
    invariant(release, 'A2A_INBOUND_STORE_BUSY');
    try {
      const current = read(ctx), record = current ?? { contract: A2A_INBOUND_ADMISSION, key: ctx.key, binding: ctx.binding,
        operations: {}, latestSend: null, latestAdmission: null, sessionId: null, runId: null, pending: null, waiting: false };
      const result = change(record, current); guard(ctx.signal);
      const bytes = canonical(record); invariant(Buffer.byteLength(bytes) <= 8 * 1024 ** 2, 'A2A_INBOUND_STORE_LIMIT');
      atomicPrivate(join(directory, `${ctx.key}.json`), bytes); return result;
    } finally { release(); }
  }
  const view = record => ({ contract: A2A_INBOUND_ADMISSION, taskKey: record.key, sessionId: record.sessionId, runId: record.runId,
    pending: copy(record.pending), submission: copy(record.operations[record.latestAdmission]?.submission ?? null),
    cursor: record.operations[record.latestAdmission]?.cursor ?? 0,
    uncertainOperations: Object.entries(record.operations).filter(([, op]) => op.phase !== 'resolved').map(([key]) => key) });
  async function execute(input, kind) {
    const ctx = authorize(input, [kind === 'send' ? 'send_message' : 'cancel_task']);
    const release = tryLock(join(directory, `${ctx.key}.admission.sqlite`));
    invariant(release, 'A2A_INBOUND_ADMISSION_BUSY');
    try {
      const parsed = kind === 'send' ? originalMessage(ctx.request.body) : null;
      const fields = { platformTaskId: ctx.binding.platformTaskId, targetVersionId: ctx.binding.targetVersionId,
        remoteTaskId: ctx.binding.remoteTaskId, remoteContextId: ctx.binding.remoteContextId,
        ...(parsed ? { message: parsed.message, ...(input.continuation === undefined ? {} : { continuation: copy(input.continuation) }) }
          : { runId: input.runId }) };
      if (kind === 'cancel') invariant(id(fields.runId), 'A2A_INBOUND_RUN_INVALID');
      const operationKey = hash({ kind, id: parsed?.messageId ?? fields.runId }), digest = hash(fields);
      const prior = update(ctx, (record, existing) => {
        const previous = record.operations[operationKey];
        if (previous) {
          invariant(previous.digest === digest && canonical(previous.fields) === canonical(fields), 'A2A_INBOUND_COMMAND_CONFLICT');
          return copy(previous);
        }
        if (kind === 'cancel') invariant(existing && record.runId === fields.runId, 'A2A_INBOUND_RUN_CONFLICT');
        else {
          invariant(!Object.values(record.operations).some(op => op.phase !== 'resolved'), 'A2A_INBOUND_PRIOR_OUTCOME_UNKNOWN');
          if (record.latestSend) invariant(record.waiting && record.operations[record.latestAdmission]?.kind === 'send'
            && object(fields.continuation) && record.pending
            && canonical(fields.continuation) === canonical(record.pending), 'A2A_INBOUND_CONTINUATION_CONFLICT');
          else invariant(fields.continuation === undefined, 'A2A_INBOUND_CONTINUATION_CONFLICT');
        }
        const cursor = record.operations[record.latestAdmission]?.observedCursor ?? 0;
        record.operations[operationKey] = { kind, digest, fields, phase: 'prepared', submission: null, cursor, observedCursor: cursor }; return null;
      });
      if (prior && accepted(prior.submission)) return copy(prior.submission);
      const call = kind === 'send' ? submit : cancel;
      let submission;
      try {
        submission = await awaitA2aControl(() => call.call(controlPlane, {
          ...copy(fields), signal: ctx.signal, assertCurrent: () => guard(ctx.signal),
        }), ctx.signal);
        guard(ctx.signal);
        invariant(submission.agentId === ctx.identity.targetAgentId, 'A2A_INBOUND_TARGET_CONFLICT');
        if (prior?.submission) invariant(prior.submission.sessionId === submission.sessionId
          && prior.submission.agentId === submission.agentId
          && prior.submission.receipt.command_id === submission.receipt.command_id, 'A2A_INBOUND_COMMAND_CONFLICT');
        const current = read(ctx);
        invariant(!current.sessionId || current.sessionId === submission.sessionId, 'A2A_INBOUND_SESSION_CONFLICT');
        invariant(!submission.receipt.run_id || !current.runId || submission.receipt.run_id === current.runId, 'A2A_INBOUND_RUN_CONFLICT');
      } catch (error) {
        // Authority loss cannot authorize even a local publication. The
        // prepared marker remains uncertain if this owner was invalidated.
        if (!ctx.signal.aborted) {
          try { update(ctx, record => { record.operations[operationKey].phase = 'unknown'; }); } catch {}
        }
        throw error;
      }
      update(ctx, record => {
        invariant(!record.sessionId || record.sessionId === submission.sessionId, 'A2A_INBOUND_SESSION_CONFLICT');
        invariant(!submission.receipt.run_id || !record.runId || submission.receipt.run_id === record.runId, 'A2A_INBOUND_RUN_CONFLICT');
        record.sessionId ??= submission.sessionId;
        const op = record.operations[operationKey];
        op.phase = submission.receipt.status === 'persistence_uncertain' ? 'unknown' : 'resolved'; op.submission = copy(submission);
        if (accepted(submission)) {
          record.runId ??= submission.receipt.run_id ?? null;
          record.latestAdmission = operationKey;
          if (kind === 'send') { record.latestSend = operationKey; record.pending = null; record.waiting = false; }
        }
      });
      return copy(submission);
    } finally { release(); }
  }
  return Object.freeze({ contract: A2A_INBOUND_ADMISSION,
    submit: input => execute(input, 'send'), cancel: input => execute(input, 'cancel'),
    inspect(input) {
      const ctx = authorize(input, ['get_task', 'subscribe_to_task']), record = read(ctx);
      invariant(record, 'A2A_INBOUND_TASK_NOT_FOUND'); return view(record);
    },
    async *facts(input) {
      const ctx = authorize(input, ['get_task', 'subscribe_to_task']), record = read(ctx), operationKey = record?.latestAdmission;
      invariant(operationKey && accepted(record.operations[operationKey]?.submission), 'A2A_INBOUND_COMMAND_NOT_ACCEPTED');
      const operation = record.operations[operationKey];
      for await (const fact of streamA2aInboundKernelFacts(operation.submission, events, {
        expectedRunId: record.runId, afterSeq: operation.cursor, stopAtWaiting: operation.kind !== 'cancel',
        signal: ctx.signal, assertCurrent: () => guard(ctx.signal),
      })) {
        update(ctx, latest => {
          invariant(latest.latestAdmission === operationKey, 'A2A_INBOUND_OBSERVATION_SUPERSEDED');
          invariant(!latest.runId || latest.runId === fact.run_id, 'A2A_INBOUND_RUN_CONFLICT'); latest.runId = fact.run_id;
          const op = latest.operations[operationKey];
          // Independent readers may overlap. An older replay must never
          // restore a superseded question or WAITING after a newer fact.
          if (fact.seq <= op.observedCursor) return;
          op.observedCursor = fact.seq;
          if (fact.family === 'interaction' && fact.event_type === 'interaction.requested') {
            const p = fact.payload;
            invariant(id(p.interaction_id) && Number.isSafeInteger(p.revision) && p.revision >= 0
              && ['approval', 'structured_input'].includes(p.kind), 'A2A_INBOUND_INTERACTION_INVALID');
            latest.pending = { run_id: fact.run_id, interaction_id: p.interaction_id, expected_revision: p.revision, kind: p.kind };
          }
          if (fact.family === 'control' && fact.event_type === 'control.run_transition') {
            if (fact.payload.state === 'waiting') { invariant(latest.pending, 'A2A_INBOUND_INTERACTION_MISSING'); latest.waiting = true; }
            else if (['completed', 'failed', 'cancelled', 'interrupted'].includes(fact.payload.state)) { latest.pending = null; latest.waiting = false; }
          }
        });
        yield fact;
        // Advancing the consumer is the acknowledgement boundary. A crash or
        // early return replays the last fact; its UUID permits idempotent use.
        update(ctx, latest => { const op = latest.operations[operationKey]; if (fact.seq > op.cursor) op.cursor = fact.seq; });
      }
    },
    close() { lifetime.abort(); },
  });
}
