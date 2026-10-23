// A real independent Host process used by the SIGKILL boundary tests.
import { prepareNativeA2AHost } from '../../src/providers/native-a2a-host.mjs';
import { spec, scope } from './native-a2a-internal-peer.mjs';
import { join } from 'node:path';
process.once('message', async input => {
  const factory = prepareNativeA2AHost({ env: input.env, bindings: [spec] });
  const owner = factory.forSession({ scope, sessionId: 'session', workspaceRoot: input.workspaceRoot, stateRoot: join(input.root, 'state'),
    assertCurrent: () => true, assertControl: () => true, authorizeControl: async () => 'allow' });
  const signal = new AbortController().signal;
  try {
    const request = input.request ?? await owner.invocation.resolve({ agent: 'research', message: 'Hello😀', signal,
      nativeRequest: { scope, sessionId: 'session', runId: 'run', operationKey: 'original-operation', call: { callId: 'call' } } });
    process.send({ type: 'request', pid: process.pid, request });
    const result = input.action === 'get' ? await owner.control.execute({ kind: 'get', commandId: 'explicit-after-crash',
      operation_locator: request.identity, authority: { user: 'approved' }, signal }) : await owner.invocation.dispatch({ request, signal });
    process.send({ type: 'result', pid: process.pid, result });
  } catch (error) { process.send({ type: 'error', code: error.code, message: error.message }); process.exitCode = 1; }
  finally { owner.close(); await factory.close(); process.disconnect(); }
});
