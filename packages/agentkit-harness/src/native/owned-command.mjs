import { canonical, copy, backgroundCommandRef, NativeError } from '../../../agentkit-harness-core/dist/index.mjs';
const check = (value, code) => { if (!value) throw new NativeError(code); };
const same = (a, b) => canonical(a) === canonical(b);

/** The backend is a fact in the canonical launch receipt, never a model hint. */
export function ownedCommandReceipt({ scope, store, current, ref: input }) {
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
  return { ref, backend: ['local_process', 'e2b'].includes(backend) ? backend : null };
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
