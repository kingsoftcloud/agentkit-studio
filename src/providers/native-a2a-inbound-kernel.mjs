/** Managed Server admission and durable Session facts. This is deliberately
 * independent of the local Native run/event schema: a Server receipt never
 * authorizes fabricating a local Run, command or successful A2A Task. */
import { copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const integer = value => Number.isSafeInteger(value) || typeof value === 'bigint';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const accepted = value => ['accepted', 'duplicate'].includes(value);
const statuses = new Set(['accepted', 'duplicate', 'rejected', 'unsupported', 'queue_full', 'persistence_uncertain']);
const invalid = condition => invariant(condition, 'A2A_INBOUND_SUBMISSION_INVALID');

export function parseA2aInboundSubmission(raw) {
  invalid(object(raw) && text(raw.SessionId, 128) && raw.SessionId.startsWith('a2a-kernel-')
    && text(raw.AgentId, 64) && raw.AgentId.startsWith('ar-') && uuid(raw.CommandId) && object(raw.Receipt));
  const receipt = copy(raw.Receipt);
  receipt.schema_version ??= 1;
  invalid(receipt.schema_version === 1 && uuid(receipt.command_id) && statuses.has(receipt.status)
    && receipt.command_id.toLowerCase() === raw.CommandId.toLowerCase()
    && (receipt.run_id == null || text(receipt.run_id))
    && (receipt.message_id == null || uuid(receipt.message_id))
    && (receipt.accepted_seq == null || integer(receipt.accepted_seq)));
  invalid(!accepted(receipt.status) || uuid(receipt.message_id)
    && integer(receipt.accepted_seq) && receipt.accepted_seq >= 1);
  invalid(accepted(receipt.status) || object(receipt.error));
  if (receipt.error != null) invalid(object(receipt.error) && text(receipt.error.code, 256)
    && typeof receipt.error.message === 'string' && receipt.error.message.length <= 4096
    && typeof receipt.error.retryable === 'boolean' && (receipt.error.details === undefined || object(receipt.error.details)));
  receipt.command_id = receipt.command_id.toLowerCase();
  return { sessionId: raw.SessionId, agentId: raw.AgentId, receipt };
}

/** Cancellation must bound even an event port whose next()/return() ignores
 * AbortSignal. Late rejections are observed; no detached fact is published. */
async function step(work, signal, guard) {
  let abort;
  try {
    guard();
    const stopped = new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const pending = Promise.resolve().then(() => { guard(); return work(); });
    const value = await Promise.race([pending, stopped]); guard(); return value;
  } finally { signal.removeEventListener('abort', abort); }
}

export async function* streamA2aInboundKernelFacts(submission, events, {
  expectedRunId = null, afterSeq = 0, stopAtWaiting = true, snapshotOnly = false, signal, assertCurrent,
} = {}) {
  const current = parseA2aInboundSubmission({ SessionId: submission?.sessionId, AgentId: submission?.agentId,
    CommandId: submission?.receipt?.command_id, Receipt: submission?.receipt });
  invariant(accepted(current.receipt.status), 'A2A_INBOUND_COMMAND_NOT_ACCEPTED');
  invariant(integer(afterSeq) && afterSeq >= 0 && typeof stopAtWaiting === 'boolean'
    && (expectedRunId === null || text(expectedRunId)) && signal instanceof AbortSignal
    && typeof snapshotOnly === 'boolean' && typeof assertCurrent === 'function'
    && typeof events?.[snapshotOnly ? 'read' : 'subscribe'] === 'function', 'A2A_INBOUND_SUBSCRIPTION_INVALID');
  const guard = () => {
    signal.throwIfAborted(); const verdict = assertCurrent();
    if (verdict && typeof verdict.then === 'function') void Promise.resolve(verdict).catch(() => {});
    invariant(verdict === true, 'A2A_INBOUND_AUTHORITY_LOST'); signal.throwIfAborted();
  };
  guard();
  let runId = current.receipt.run_id ?? expectedRunId, cursor = afterSeq, iterator;
  invariant(!expectedRunId || !current.receipt.run_id || expectedRunId === current.receipt.run_id, 'A2A_INBOUND_RUN_CONFLICT');
  try {
    const read = events.read;
    const source = snapshotOnly ? (async function* () {
      let nextCursor = afterSeq;
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const page = await step(() => {
          invariant(events.read === read, 'A2A_INBOUND_AUTHORITY_LOST');
          return read.call(events, current.sessionId, nextCursor, 100, { signal });
        }, signal, guard);
        invariant(Array.isArray(page) && page.length <= 100, 'A2A_INBOUND_EVENT_SOURCE_INVALID');
        if (!page.length) return;
        let last = nextCursor;
        for (const fact of page) {
          invariant(integer(fact?.seq) && fact.seq > last, 'A2A_INBOUND_EVENT_SOURCE_INVALID');
          last = fact.seq; yield fact;
        }
        nextCursor = last;
      }
      invariant(false, 'A2A_INBOUND_RECONCILIATION_LIMIT');
    })() : await step(() => events.subscribe(current.sessionId, cursor, { signal }), signal, guard);
    invariant(typeof source?.[Symbol.asyncIterator] === 'function', 'A2A_INBOUND_EVENT_SOURCE_INVALID');
    iterator = source[Symbol.asyncIterator]();
    for (;;) {
      const next = await step(() => iterator.next(), signal, guard);
      if (next.done) break;
      const fact = copy(next.value);
      invariant(object(fact) && fact.schema_version === 1 && uuid(fact.event_id)
        && integer(fact.seq) && fact.seq >= 1 && fact.session_id === current.sessionId
        && text(fact.timestamp) && text(fact.event_type) && object(fact.payload)
        && (fact.run_id == null || text(fact.run_id))
        && ['control', 'runtime', 'workflow', 'schedule', 'job', 'relationship', 'interaction'].includes(fact.family)
        && Number.isSafeInteger(fact.family_version) && fact.family_version >= 1
        && (!['control', 'runtime', 'interaction'].includes(fact.family)
          || fact.family_version === (fact.family === 'runtime' ? 2 : 1)), 'A2A_INBOUND_FACT_INVALID');
      if (fact.seq <= cursor) continue;
      cursor = fact.seq;
      invariant(!(fact.event_type === 'control.command_rejected' && fact.payload.command_id === current.receipt.command_id),
        'A2A_INBOUND_COMMAND_REJECTED');
      if (fact.family === 'control' && fact.event_type === 'control.run_transition' && fact.causation_id === current.receipt.command_id) {
        invariant(text(fact.run_id) && fact.payload.run_id === fact.run_id, 'A2A_INBOUND_RUN_INVALID');
        invariant(!runId || runId === fact.run_id, 'A2A_INBOUND_RUN_CONFLICT'); runId = fact.run_id;
      }
      if (!runId || fact.run_id !== runId) continue;
      if (fact.family === 'control' && fact.event_type === 'control.run_transition')
        invariant(fact.payload.run_id === fact.run_id, 'A2A_INBOUND_RUN_INVALID');
      guard(); yield fact;
      const boundaries = ['completed', 'failed', 'cancelled', 'interrupted', ...(stopAtWaiting ? ['waiting'] : [])];
      if (fact.family === 'control' && fact.event_type === 'control.run_transition' && boundaries.includes(fact.payload.state)) {
        guard(); return;
      }
    }
    if (snapshotOnly) { guard(); return; }
    invariant(false, 'A2A_INBOUND_STREAM_UNCONFIRMED');
  } finally {
    try { if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {}); } catch {}
  }
}
