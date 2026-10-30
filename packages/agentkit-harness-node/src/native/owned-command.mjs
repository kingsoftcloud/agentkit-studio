import { canonical, copy, backgroundCommandRef, NativeError } from '@kingsoftcloud/agentkit-harness-core';
const check = (value, code) => { if (!value) throw new NativeError(code); };
const same = (a, b) => canonical(a) === canonical(b);
export const OWNED_COMMAND_OUTPUT_CONTRACT = 'agentkit.owned-command-output/v1';

/** Authenticated Hosts may page an existing process without manufacturing a
 * model tool call. Every read is bound to the current session head and the
 * original committed launch receipt, including reads after a Host restart.
 * Readers have no launch/cancel capability. Raw output still requires the
 * Host's operator-output disclosure policy before publication.
 */
export function createOwnedCommandOutputReader({ scope, store, readers = {}, isClosed = () => false }) {
  const pinned = copy(scope), bindings = Object.fromEntries(Object.entries(readers));
  check(typeof isClosed === 'function' && Object.entries(bindings).every(([name, reader]) =>
    ['local_process', 'e2b'].includes(name) && typeof reader === 'function'), 'invalid_command_output_readers');
  return Object.freeze({ contract: OWNED_COMMAND_OUTPUT_CONTRACT, async read(request) {
    const signal = request?.signal;
    check(signal instanceof AbortSignal, 'command_output_signal_invalid');
    const { signal: _, ...body } = request, sealed = canonical(body);
    check(Object.keys(body).every(key => ['contract', 'scope', 'runId', 'sessionId', 'taskId', 'stdoutCursor', 'stderrCursor', 'maxBytes'].includes(key))
      && body.contract === OWNED_COMMAND_OUTPUT_CONTRACT && same(body.scope, pinned)
      && ['runId', 'sessionId'].every(key => typeof body[key] === 'string' && body[key].trim())
      && /^[a-f0-9]{64}$/.test(body.taskId)
      && [body.stdoutCursor, body.stderrCursor].every(cursor => Number.isSafeInteger(cursor) && cursor >= 0)
      && Number.isSafeInteger(body.maxBytes) && body.maxBytes >= 4 && body.maxBytes <= 65536,
    'command_output_request_invalid');
    const current = () => {
      signal.throwIfAborted(); check(isClosed() === false, 'command_output_closed');
      const { signal: liveSignal, ...live } = request;
      check(liveSignal === signal && canonical(live) === sealed, 'command_output_request_changed');
      const head = store.sessionHead(pinned, body.sessionId);
      check(head?.runId === body.runId, 'command_output_head_changed');
      const record = store.load(pinned, body.runId);
      check(record.snapshot.sessionId === body.sessionId && same(record.snapshot.scope, pinned), 'command_output_owner_mismatch');
      const matches = record.snapshot.backgroundCommands.filter(row => row.ref.taskId === body.taskId);
      check(matches.length === 1 && head.backgroundCommands.some(row => same(row.ref, matches[0].ref)), 'background_command_not_owned');
      return ownedCommandReceipt({ scope: pinned, store, current: record, ref: matches[0].ref, includeCommand: true });
    };
    const owner = current(), reader = bindings[owner.backend];
    check(reader, 'command_output_backend_unavailable');
    const output = await reader({ scope: copy(pinned), sessionId: body.sessionId, runId: body.runId,
      ref: copy(owner.ref), stdoutCursor: body.stdoutCursor, stderrCursor: body.stderrCursor,
      maxBytes: body.maxBytes, waitSeconds: 0, signal });
    check(same(current(), owner), 'command_output_owner_changed');
    check(output && typeof output === 'object' && !Array.isArray(output)
      && ['starting', 'running', 'completed', 'failed', 'canceled', 'timed_out', 'output_limit', 'unknown', 'unavailable'].includes(output.status),
    'command_output_invalid');
    for (const channel of ['stdout', 'stderr']) {
      check(typeof output[channel] === 'string' && Buffer.byteLength(output[channel]) <= body.maxBytes
        && Number.isSafeInteger(output[channel + 'Cursor']) && output[channel + 'Cursor'] >= body[channel + 'Cursor']
        && output[channel + 'Cursor'] - body[channel + 'Cursor'] === Buffer.byteLength(output[channel]), 'command_output_cursor_invalid');
    }
    check((output.exitCode == null || Number.isSafeInteger(output.exitCode))
      && (output.observedExitCode == null || Number.isSafeInteger(output.observedExitCode))
      && [output.outputMayBeTruncated, output.evidenceIncomplete].every(value => value === undefined || typeof value === 'boolean'),
    'command_output_invalid');
    const settled = ['completed', 'failed', 'canceled', 'timed_out', 'output_limit'].includes(output.status);
    return { contract: OWNED_COMMAND_OUTPUT_CONTRACT, sessionId: body.sessionId, runId: body.runId, taskId: body.taskId,
      command: owner.command, status: output.status, stdout: output.stdout, stderr: output.stderr,
      stdoutCursor: output.stdoutCursor, stderrCursor: output.stderrCursor,
      exitCode: settled && output.evidenceIncomplete !== true ? output.exitCode ?? null : null,
      observedExitCode: output.observedExitCode ?? null, evidenceIncomplete: output.evidenceIncomplete === true,
      outputMayBeTruncated: output.outputMayBeTruncated === true };
  } });
}

/** The backend is a fact in the canonical launch receipt, never a model hint. */
export function ownedCommandReceipt({ scope, store, current, ref: input, includeCommand = false }) {
  const ref = backgroundCommandRef(input), source = store.load(scope, ref.sourceRunId);
  const receipt = source.receipts.find(item => item.operationKey === ref.operationKey);
  const launch = source.intents.find(item => item.operationKey === ref.operationKey);
  const calls = launch?.payload.calls, results = receipt?.result.results;
  const result = Array.isArray(results) && results.length === 1 ? results[0] : null;
  const definition = Array.isArray(calls) && calls.length === 1
    ? source.configuration.tools.find(tool => tool.name === calls[0].name) : null;
  check(same(source.snapshot.scope, scope) && source.snapshot.sessionId === current.snapshot.sessionId
    && receipt?.status === 'committed' && launch?.kind === 'tool'
    && definition?.backgroundCommandPolicy === 'owned-command-launch/v1' && result?.status === 'ok'
    && same(result.backgroundCommandRef ?? null, ref), 'background_command_launcher_receipt_mismatch');
  const backend = typeof result.content?.backend === 'string' && result.content.backend.startsWith('sandbox/')
    ? result.content.backend.slice('sandbox/'.length) : null;
  return { ref, backend: ['local_process', 'e2b'].includes(backend) ? backend : null,
    ...(includeCommand ? { command: typeof calls[0].arguments?.command === 'string' ? calls[0].arguments.command.slice(0, 32768) : '' } : {}) };
}

/** Resolve read/stop authority from the current claimed Native tool operation.
 * Inherited session handles retain their original source run and receipt.
 */
export function createOwnedCommandResolver({ scope, store }) {
  const pinnedScope = copy(scope);
  return (request, taskId) => {
    request.signal.throwIfAborted();
    check(same(request.scope, pinnedScope), 'background_command_scope_mismatch');
    const current = store.load(pinnedScope, request.runId), snapshot = current.snapshot;
    check(['sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].every(key => request[key] === snapshot[key]),
      'background_command_owner_mismatch');
    const intent = current.intents.find(item => item.operationKey === snapshot.pendingIntent), calls = intent?.payload.calls;
    const index = Array.isArray(calls) ? calls.findIndex(call => same(call, request.call)) : -1;
    check(intent?.kind === 'tool' && intent.status === 'running' && index >= 0
      && request.operationKey === (calls.length === 1 ? intent.operationKey : `${intent.operationKey}:call:${index + 1}`),
    'background_command_tool_operation_mismatch');
    const matches = snapshot.backgroundCommands.filter(item => item.ref.taskId === taskId);
    check(matches.length === 1, 'background_command_not_owned');
    return ownedCommandReceipt({ scope: pinnedScope, store, current, ref: matches[0].ref });
  };
}
