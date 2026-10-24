import { createA2aGatewayIdentityVerifier } from '../../src/providers/native-a2a-ingress-identity.mjs';
import { createInternalA2AControlPlane } from '../../src/providers/native-a2a-control-plane.mjs';
import { createA2aInboundAdmission } from '../../src/providers/native-a2a-inbound-admission.mjs';
process.once('message', async ({ directory, publicKeyPem, targetBinding, baseUrl, action, request }) => {
  let client, service;
  try {
    const verifier = createA2aGatewayIdentityVerifier({ publicKeyPem, targetBinding });
    client = createInternalA2AControlPlane({ baseUrl, tokenProvider: { getToken({ assertCurrent }) { assertCurrent(); return 'registry-workload'; } } });
    service = createA2aInboundAdmission({ directory, verifier, controlPlane: client, assertCurrent: () => true });
    const input = { request: { ...request, body: Buffer.from(request.bodyBase64, 'base64') },
      remoteTaskId: 'remote-original', remoteContextId: 'context-original', signal: new AbortController().signal };
    const result = action === 'inspect' ? service.inspect(input) : await service.submit(input);
    await new Promise(resolve => process.send({ type: 'result', pid: process.pid, result }, resolve));
  } catch (error) {
    process.exitCode = 1;
    await new Promise(resolve => process.send({ type: 'error', code: error?.code ?? 'unexpected' }, resolve));
  } finally { service?.close(); client?.close(); process.disconnect(); }
});
