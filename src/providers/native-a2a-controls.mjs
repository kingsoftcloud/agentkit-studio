/** Explicit control of a previously admitted A2A task. The Host must supply
 * fresh authority and consent, independently of the original execution fence.
 * Commands are committed before potential effects; a lost continuation/cancel
 * is inspected with GetTask, never implicitly sent again. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { a2aTerminal, createA2AProjection } from './native-a2a-protocol.mjs';

export const STUDIO_A2A_CONTROL_CONTRACT = 'agentkit.studio-a2a-task-control/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.trim() && value.length <= 256;
const paused = state => ['input_required', 'auth_required'].includes(state);
const pauseDigest = projection => hash({ state: projection.state, pause: projection.pause ?? null,
  generation: projection.pauseGeneration ?? 0 });

// Host services/consent implementations may ignore AbortSignal. Observing a
// late settlement must not revive the expired control or hold Host shutdown.
export async function awaitA2aControl(work, signal) {
  signal.throwIfAborted(); let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), stopped]);
    signal.throwIfAborted(); return result;
  } finally { signal.removeEventListener('abort', abort); }
}

export function createA2ATaskControl({ binding, owner, checkOwner, assertControl, authorizeControl,
  signal: lifetime, readIdentity, save, wire, lock }) {
  const view = record => ({ contract: STUDIO_A2A_CONTROL_CONTRACT, bindingDigest: binding.bindingDigest,
    operation_locator: copy(record.request.identity), task_id: record.platformTaskId,
    remote_task_id: record.projection.taskId, remote_context_id: record.projection.contextId,
    state: record.projection.state, phase: record.phase,
    pause: paused(record.projection.state) ? copy(record.projection.pause ?? null) : null,
    pauseDigest: paused(record.projection.state) ? pauseDigest(record.projection) : null,
    output_refs: copy(record.projection.output_refs), snapshots: copy(record.projection.snapshots),
    item_kinds: copy(record.projection.item_kinds) });
  async function execute(input) {
    invariant(object(input) && ['get', 'continue', 'cancel'].includes(input.kind) && id(input.commandId)
      && object(input.operation_locator) && object(input.authority) && input.signal instanceof AbortSignal
      && Object.keys(input).every(key => ['kind', 'commandId', 'operation_locator', 'authority', 'signal', 'parts', 'pauseDigest'].includes(key)),
    'A2A_CONTROL_REQUEST_INVALID');
    invariant(typeof assertControl === 'function' && typeof authorizeControl === 'function', 'A2A_CONTROL_AUTHORITY_REQUIRED');
    const { kind, commandId } = input, locator = copy(input.operation_locator), authority = copy(input.authority);
    const parts = input.parts === undefined ? null : copy(input.parts);
    if (kind === 'continue') {
      invariant(typeof input.pauseDigest === 'string' && /^[a-f0-9]{64}$/u.test(input.pauseDigest)
        && Array.isArray(parts) && parts.length > 0 && parts.length <= 64
        && parts.every(part => object(part) && ['text', 'data', 'file'].filter(key => Object.hasOwn(part, key)).length === 1
          && (!Object.hasOwn(part, 'text') || typeof part.text === 'string')
          && (!Object.hasOwn(part, 'file') || object(part.file)))
        && Buffer.byteLength(canonical(parts)) <= 1024 * 1024, 'A2A_CONTROL_INPUT_INVALID');
    } else invariant(parts === null && input.pauseDigest === undefined, 'A2A_CONTROL_REQUEST_INVALID');
    const command = { kind, commandId, operation_locator: locator, parts, pauseDigest: input.pauseDigest ?? null };
    const commandDigest = hash(command), key = hash(commandId);
    const callerSignal = input.signal;
    let signal = AbortSignal.any([callerSignal, lifetime, AbortSignal.timeout(90000)]);
    const stableInput = canonical({ ...input, signal: null });
    let record;
    const check = () => {
      checkOwner(signal);
      invariant(input.signal === callerSignal && canonical({ ...input, signal: null }) === stableInput, 'A2A_CONTROL_REQUEST_DRIFTED');
      const current = assertControl({ authority: copy(authority), owner: copy(owner),
        operation_locator: copy(locator), kind, commandId, signal });
      if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
      invariant(current === true, 'A2A_CONTROL_AUTHORITY_LOST'); signal.throwIfAborted();
    };
    check();
    const release = lock(locator); invariant(release, 'A2A_CALL_BUSY');
    let entry, effectStarted = false;
    try {
      check(); record = readIdentity(locator); invariant(record, 'A2A_CALL_NOT_FOUND');
      invariant(record.request.spec && record.projection?.scopeId === record.request.scopeId, 'A2A_CONTROL_RECORD_INVALID');
      record.controls ??= {};
      entry = record.controls[key];
      if (entry) invariant(entry.contract === STUDIO_A2A_CONTROL_CONTRACT && entry.digest === commandDigest
        && canonical(entry.command) === canonical(command), 'A2A_CONTROL_IDEMPOTENCY_CONFLICT');
      if (kind === 'continue' && !entry && !a2aTerminal.has(record.projection.state)) {
        // A response to a suspended remote call retains the admitted deadline;
        // approval and a replacement Host cannot silently buy it a new budget.
        const deadlineAt = record.deadlineAt ?? record.createdAt + Math.min(90000, Math.ceil((record.request.spec.timeout_seconds ?? 90) * 1000));
        invariant(Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now(), 'A2A_CONTINUATION_DEADLINE_EXCEEDED');
        signal = AbortSignal.any([signal, AbortSignal.timeout(deadlineAt - Date.now())]);
      }
      const consent = await awaitA2aControl(() => authorizeControl({ authority: copy(authority), owner: copy(owner), command: copy(command),
        spec: copy(record.request.spec), task: view(record), readOnly: kind === 'get' || Boolean(entry) || a2aTerminal.has(record.projection.state), signal }), signal);
      check(); invariant(consent === 'allow', 'A2A_CONTROL_PERMISSION_DENIED');
      if (entry) {
        // Reads may be repeated. Potential effects are never retried, even
        // after a crash between this marker and entering the network stack.
        if (kind !== 'get') return copy(entry.result ?? { ...view(record), commandId, outcome: 'unknown',
          error_type: 'A2A_CONTROL_OUTCOME_UNKNOWN' });
      }
      invariant(entry || Object.keys(record.controls).length < 10000, 'A2A_CONTROL_COMMAND_LIMIT');
      if (a2aTerminal.has(record.projection.state)) {
        const result = { ...view(record), commandId, outcome: kind === 'get' ? 'observed' : 'already_terminal' };
        record.controls[key] = { contract: STUDIO_A2A_CONTROL_CONTRACT, digest: commandDigest,
          command, phase: 'resolved', ...(kind === 'get' ? {} : { result }), createdAt: Date.now() };
        check(); save(record.request, record); return result;
      }
      invariant(record.projection.taskId, 'A2A_REMOTE_TASK_NOT_KNOWN');
      const cancelObservation = Object.values(record.controls).find(value => value.cancelReply
        && a2aTerminal.has(value.cancelReply.state))?.cancelReply;
      let projection = createA2AProjection(record.request.scopeId, cancelObservation ?? record.projection);
      const publish = () => {
        check(); record.projection = projection.snapshot();
        record.phase = a2aTerminal.has(record.projection.state) ? 'terminal' : paused(record.projection.state) ? 'paused' : 'unknown';
        if (record.phase === 'terminal' || record.phase === 'paused') {
          record.result = { state: record.projection.state, task_id: record.platformTaskId,
            output_refs: record.projection.output_refs, snapshots: record.projection.snapshots, item_kinds: record.projection.item_kinds };
          delete record.error;
        } else delete record.result;
        save(record.request, record);
      };
      const observe = async () => {
        const task = await wire(record.request, 'GetTask', { id: record.projection.taskId }, signal, false, check);
        check(); projection.task(task); publish();
      };
      if (kind === 'get') {
        await observe();
        const result = { ...view(record), commandId, outcome: 'observed' };
        record.controls[key] = { contract: STUDIO_A2A_CONTROL_CONTRACT, digest: commandDigest,
          command, phase: 'resolved', createdAt: Date.now() };
        check(); save(record.request, record); return result;
      }
      // Re-read the bound task before admitting a new effect. Never discover
      // a replacement route/version or accept remote task/context drift.
      await observe();
      if (a2aTerminal.has(record.projection.state)) {
        const result = { ...view(record), commandId, outcome: 'already_terminal' };
        record.controls[key] = { contract: STUDIO_A2A_CONTROL_CONTRACT, digest: commandDigest,
          command, phase: 'resolved', result, createdAt: Date.now() };
        check(); save(record.request, record); return result;
      }
      if (kind === 'continue') {
        invariant(paused(record.projection.state) && pauseDigest(record.projection) === command.pauseDigest, 'A2A_CONTINUATION_NOT_ALLOWED');
        invariant(!Object.values(record.controls).some(value => value.command.kind === 'continue'
          && value.command.pauseDigest === command.pauseDigest), 'A2A_CONTINUATION_ALREADY_REQUESTED');
      } else invariant(!Object.values(record.controls).some(value => value.command.kind === 'cancel'
        && value.phase !== 'resolved'), 'A2A_CANCEL_ALREADY_REQUESTED');
      invariant(Object.keys(record.controls).length < 10000, 'A2A_CONTROL_COMMAND_LIMIT');
      const message = kind === 'continue' ? { messageId: hash({ identity: locator, commandId }), role: 'ROLE_USER',
        taskId: record.projection.taskId, ...(record.projection.contextId ? { contextId: record.projection.contextId } : {}), parts } : null;
      if (message) invariant(Buffer.byteLength(canonical(message)) <= 1024 * 1024, 'A2A_CONTROL_INPUT_INVALID');
      entry = { contract: STUDIO_A2A_CONTROL_CONTRACT, digest: commandDigest, command, message,
        phase: 'sending', createdAt: Date.now() };
      record.controls[key] = entry;
      check(); save(record.request, record); effectStarted = true;
      if (kind === 'continue') {
        const result = await wire(record.request, 'SendMessage', { message, configuration: { returnImmediately: false } }, signal, false, check);
        check(); projection.apply(result);
        // A confirmed reply can ask the same question again (e.g. validation
        // failed), without a distinct message ID. It is a new input opportunity.
        // Unknown sends never advance this generation and cannot be retried.
        const next = projection.snapshot(); next.pauseGeneration = (record.projection.pauseGeneration ?? 0) + 1;
        projection = createA2AProjection(record.request.scopeId, next); publish();
      } else {
        // A CancelTask reply alone is insufficient: confirm with GetTask.
        const task = await wire(record.request, 'CancelTask', { id: record.projection.taskId }, signal, false, check);
        check();
        const validated = createA2AProjection(record.request.scopeId, record.projection); validated.task(task);
        // Keep a terminal CancelTask observation even if confirmation crashes.
        // A later GetTask cannot silently replace that terminal with another.
        entry.cancelReply = validated.snapshot(); check(); save(record.request, record);
        projection = validated;
        await observe();
      }
      const outcome = kind === 'continue' ? 'submitted' : record.projection.state === 'cancelled' ? 'remote_cancelled'
        : a2aTerminal.has(record.projection.state) ? 'already_terminal' : 'cancel_requested_but_remote_unknown';
      const result = { ...view(record), commandId, outcome };
      entry.phase = outcome === 'cancel_requested_but_remote_unknown' ? 'unknown' : 'resolved'; entry.result = result;
      check(); save(record.request, record); return copy(result);
    } catch (error) {
      if (!effectStarted) throw error;
      // Stale/aborted control authority cannot publish a confirmed result, but
      // its committed intent must retain uncertainty for a replacement Host.
      const unsupported = kind === 'cancel' && error?.code === 'A2A_CANCEL_UNSUPPORTED';
      entry.phase = unsupported ? 'resolved' : 'unknown';
      entry.result = { ...view(record), commandId, outcome: unsupported ? 'cancel_requested_but_remote_unsupported' : 'unknown',
        ...(!unsupported ? { error_type: 'A2A_CONTROL_OUTCOME_UNKNOWN' } : {}) };
      save(record.request, record); return copy(entry.result);
    } finally { release(); }
  }
  return Object.freeze({ contract: STUDIO_A2A_CONTROL_CONTRACT, execute });
}
