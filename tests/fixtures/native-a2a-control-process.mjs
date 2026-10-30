import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { prepareNativeA2AHost } from '../../src/providers/native-a2a-host.mjs';
const [mode, kind, root, origin] = process.argv.slice(2);
const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const workspaceRoot = join(root, 'workspace'), stateRoot = join(root, 'state');
mkdirSync(workspaceRoot, { recursive: true });
const prepared = prepareNativeA2AHost({ env: { KSADK_A2A_SERVICE_URL: origin, KSADK_A2A_ALLOW_PRIVATE: 'true' },
  bindings: [{ local_name: 'remote', binding_id: 'binding', space_id: 'space', target_agent_id: 'remote', expected_version_id: 'version' }] });
const owner = prepared.forSession({ scope, sessionId: 'session', stateRoot, workspaceRoot,
  assertCurrent: () => mode === 'run', assertControl: () => true, authorizeControl: async () => 'allow' });
const signal = new AbortController().signal;
let command, locator;
if (mode === 'run') {
  const request = await owner.invocation.resolve({ agent: 'remote', message: 'initial', signal,
    nativeRequest: { scope, sessionId: 'session', runId: 'original-run', operationKey: 'original-operation', call: { callId: 'original-call' } } });
  await owner.invocation.dispatch({ request, signal }); locator = request.identity;
  const before = await owner.control.execute({ kind: 'get', commandId: 'before', operation_locator: locator, authority: {}, signal });
  command = { kind, commandId: 'one-effect', operation_locator: locator,
    ...(kind === 'continue' ? { pauseDigest: before.pauseDigest, parts: [{ data: { answer: 42 } }] } : {}) };
} else {
  const directory = join(stateRoot, readdirSync(stateRoot)[0]);
  const record = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(file => file.endsWith('.json')))));
  const saved = Object.values(record.controls).find(entry => entry.command.commandId === 'one-effect').command;
  locator = saved.operation_locator;
  command = { kind: saved.kind, commandId: saved.commandId, operation_locator: locator,
    ...(kind === 'continue' ? { pauseDigest: saved.pauseDigest, parts: saved.parts } : {}) };
}
const result = await owner.control.execute({ ...command, authority: {}, signal });
if (mode === 'run') throw Error('process must be killed while the actual effect request remains open');
const observed = await owner.control.execute({ kind: 'get', commandId: 'cold-observe', operation_locator: locator, authority: {}, signal });
let blocked = null;
if (kind === 'continue' && observed.state === 'input_required') {
  try { await owner.control.execute({ ...command, commandId: 'unsafe-new-id', authority: {}, signal }); }
  catch (error) { blocked = error.code; }
}
process.stdout.write(JSON.stringify({ pid: process.pid, result, observed, blocked }) + '\n');
owner.close(); await prepared.close();
