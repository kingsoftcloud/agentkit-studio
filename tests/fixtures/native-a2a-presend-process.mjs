import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../../src/providers/native-a2a-host.mjs';
const [mode, root, origin, ownerKind = 'native'] = process.argv.slice(2);
const dsh = ownerKind === 'dsh';
const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot, { recursive: true });
const prepared = (dsh ? prepareDshA2AHost : prepareNativeA2AHost)({
  env: { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true' },
  bindings: [{ local_name: 'remote', binding_id: 'binding', space_id: 'space', target_agent_id: 'remote', expected_version_id: 'version' }],
});
const record = () => {
  const directory = join(root, 'state', readdirSync(join(root, 'state'))[0]);
  return JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith('.json')))));
};
const barrier = () => {
  writeFileSync(join(root, mode + '-ready'), String(process.pid));
  const deadline = Date.now() + 10000, buffer = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(root, mode + '-release'))) {
    if (Date.now() > deadline) throw Error('pre-send process barrier timed out: ' + mode);
    Atomics.wait(buffer, 0, 0, 10);
  }
};
const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const ownerBinding = dsh ? { agentId: 'agent', agentRevision: 1, buildId: 'build' } : { scope };
let checks = 0, stopped = false;
const owner = prepared.forSession({ ...ownerBinding, sessionId: 'session', workspaceRoot, stateRoot: join(root, 'state'),
  assertCurrent: () => {
    checks++;
    // Genuine production authority checks: before admission, or inside wire()
    // after the fsynced sending marker but before entering fetch().
    if (!stopped && (mode === 'dispatch-before' && checks === 3
      || mode === 'dispatch-after' && record().phase === 'sending')) { stopped = true; barrier(); }
    return true;
  }, assertControl: () => true, authorizeControl: async ({ readOnly }) => {
    process.send({ approval: true, readOnly, pid: process.pid });
    if (mode === 'cancel-before') barrier();
    return 'allow';
  } });
const signal = new AbortController().signal;
if (mode === 'prepare') {
  const request = await owner.invocation.resolve({ agent: 'remote', message: 'initial', signal,
    [dsh ? 'dshRequest' : 'nativeRequest']: { ...ownerBinding, sessionId: 'session', ...(!dsh ? { runId: 'original-run' } : {}),
      operationKey: 'operation', call: { callId: 'call' } } });
  process.send({ prepared: true, pid: process.pid, identity: request.identity });
  barrier();
} else if (mode.startsWith('dispatch')) {
  const result = await owner.invocation.dispatch({ request: record().request, signal });
  process.send({ result, pid: process.pid });
} else {
  const result = await owner.control.execute({ kind: 'cancel', commandId: 'original-cancel',
    operation_locator: record().request.identity, authority: { actor: 'fresh-process-human' }, signal });
  // Kill after actual local terminal commit, before acknowledging the command.
  if (mode === 'cancel-after') barrier();
  process.send({ result, pid: process.pid });
}
owner.close(); await prepared.close(); process.disconnect();
