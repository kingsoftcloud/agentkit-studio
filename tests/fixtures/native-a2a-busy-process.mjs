import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareNativeA2AHost } from '../../src/providers/native-a2a-host.mjs';
const [mode, root, origin] = process.argv.slice(2);
const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot, { recursive: true });
const prepared = prepareNativeA2AHost({ env: { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true' },
  bindings: [{ local_name: 'remote', binding_id: 'binding', space_id: 'space', target_agent_id: 'remote', expected_version_id: 'version' }] });
const record = () => {
  const directory = join(root, 'state', readdirSync(join(root, 'state'))[0]);
  return JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith('.json')))));
};
let paused = false;
const owner = prepared.forSession({ scope, sessionId: 'session', workspaceRoot, stateRoot: join(root, 'state'),
  assertCurrent: () => mode === 'dispatch', assertControl: ({ kind }) => {
    if (mode === 'continue-race' && kind === 'continue' && !paused
      && JSON.stringify(record().projection.snapshots).includes('after-continuation-observe')) {
      // Stop at a real authority check AFTER the observation has been durably
      // published, BEFORE the sending marker. Another real process can cancel.
      paused = true; writeFileSync(join(root, 'continuation-ready'), String(process.pid));
      const deadline = Date.now() + 10000, buffer = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(join(root, 'continuation-release'))) {
        if (Date.now() > deadline) throw Error('continuation admission barrier timed out');
        Atomics.wait(buffer, 0, 0, 10);
      }
    }
    return true;
  }, authorizeControl: async ({ readOnly }) => {
    process.send({ approval: true, readOnly, pid: process.pid }); return 'allow';
  } });
const signal = new AbortController().signal;
if (mode === 'dispatch') {
  const request = await owner.invocation.resolve({ agent: 'remote', message: 'initial', signal,
    nativeRequest: { scope, sessionId: 'session', runId: 'original-run', operationKey: 'operation', call: { callId: 'call' } } });
  const result = await owner.invocation.dispatch({ request, signal }); process.send({ result, pid: process.pid });
} else {
  const input = { kind: mode === 'inspect' ? 'get' : 'cancel', commandId: mode === 'inspect' ? 'inspect' : 'original-cancel',
    operation_locator: record().request.identity, authority: { actor: 'fresh-process-human' }, signal };
  if (mode === 'continue-race') {
    const inspected = await owner.control.execute({ ...input, kind: 'get', commandId: 'continue-inspect' });
    try {
      const result = await owner.control.execute({ ...input, kind: 'continue', commandId: 'continue',
        pauseDigest: inspected.pauseDigest, parts: [{ text: 'original answer' }] });
      process.send({ result, pid: process.pid });
    } catch (error) { process.send({ error: error.code ?? error.message, pid: process.pid }); }
  } else {
    const result = await owner.control.execute(input); process.send({ result, pid: process.pid });
  }
}
owner.close(); await prepared.close(); process.disconnect();
