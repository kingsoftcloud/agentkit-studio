import { join } from 'node:path';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../../src/providers/native-a2a-host.mjs';
import { A2A_HOST_DECISION, a2aDecisionDigest } from '../../src/providers/native-a2a-decision.mjs';
import { hostFetch } from '../../src/http-fetch.mjs';
import { spec, scope } from './native-a2a-internal-peer.mjs';
process.once('message', async input => {
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (input.action === 'control' && input.boundary === 'before-transport'
      && (body?.method === 'CancelTask' || body?.method === 'SendMessage' && body.params.message.taskId)) {
      process.send({ type: 'boundary', pid: process.pid }); await new Promise(() => {});
    }
    return hostFetch(url, init);
  };
  const factory = (input.dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env: input.env, bindings: [spec], fetchImpl });
  const owner = factory.forSession({ ...(input.dsh ? { agentId: 'agent', agentRevision: 1, buildId: null } : { scope }),
    sessionId: 'session', workspaceRoot: input.workspaceRoot, stateRoot: join(input.root, 'state'),
    assertCurrent: () => true, assertControl: () => true,
    authorizeControl: async ({ command, readOnly }) => {
      if (readOnly) return 'allow';
      if (input.action !== 'control') throw Error('cold confirmation must not request another grant');
      return { decision: 'allow', commandDigest: a2aDecisionDigest(command), receipt: {
        contract: A2A_HOST_DECISION, sessionId: 'session', presetId: 'fixture-preset', requestId: 'fixture-approval',
        callId: 'fixture-call', toolName: `a2a_${command.kind}_task`, requestDigest: 'a'.repeat(64),
        outcome: 'allowed-once', askedSeq: 1, decidedSeq: 2 } };
    } });
  try {
    const result = await owner.control.execute({ ...input.command, signal: new AbortController().signal });
    await owner.eventDelivery.flush(); process.send({ type: 'result', result, pid: process.pid });
  } catch (error) { process.send({ type: 'error', code: error.code, message: error.message, pid: process.pid }); process.exitCode = 1; }
  finally { owner.close(); await factory.close(); process.disconnect(); }
});
