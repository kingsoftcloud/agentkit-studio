import { createA2aGatewayIdentityVerifier } from '../../src/providers/native-a2a-ingress-identity.mjs';
import { createInternalA2AControlPlane } from '../../src/providers/native-a2a-control-plane.mjs';
import { createA2aInboundAdmission } from '../../src/providers/native-a2a-inbound-admission.mjs';
import { createA2aInboundTaskStore } from '../../src/providers/native-a2a-inbound-task-store.mjs';
process.once('message', async ({ directory, taskDirectory, publicKeyPem, targetBinding, baseUrl, action, rows, request }) => {
  let client, admission;
  const send = value => new Promise(resolve => process.send({ ...value, pid: process.pid }, resolve));
  try {
    request = { ...request, body: Buffer.from(request.bodyBase64, 'base64') };
    const verifier = createA2aGatewayIdentityVerifier({ publicKeyPem, targetBinding }), identity = verifier.verify(request);
    client = createInternalA2AControlPlane({ baseUrl, tokenProvider: { getToken({ assertCurrent }) { assertCurrent(); return 'registry-workload'; } } });
    const events = { async *subscribe() { for (const row of rows) yield row; } };
    admission = createA2aInboundAdmission({ directory, verifier, controlPlane: client, events, assertCurrent: () => true });
    const store = createA2aInboundTaskStore({ directory: taskDirectory, assertCurrent: () => true });
    const input = { request, remoteTaskId: 'remote-original', remoteContextId: 'context-original', signal: new AbortController().signal };
    const duplicates = [];
    for await (const fact of admission.facts(input)) {
      if (action === 'before-projection') { await send({ type: 'boundary', cursor: store.get(identity, { taskId: input.remoteTaskId }).cursor }); await new Promise(() => {}); }
      const result = store.apply(identity, { taskId: input.remoteTaskId, contextId: input.remoteContextId }, fact); duplicates.push(result.duplicate);
      if (action === 'after-projection-before-ack') { await send({ type: 'boundary', cursor: result.cursor }); await new Promise(() => {}); }
    }
    await send({ type: 'result', duplicates, view: store.get(identity, { taskId: input.remoteTaskId }) });
  } catch (error) { process.exitCode = 1; await send({ type: 'error', code: error?.code ?? 'unexpected' }); }
  finally { admission?.close(); client?.close(); process.disconnect(); }
});
