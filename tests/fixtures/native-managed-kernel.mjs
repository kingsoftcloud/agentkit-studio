import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { configure, emptyUsage } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeKernelPermitVerifier, nativeKernelPermitBytes } from '../../src/providers/native-kernel-permit.mjs';

export const target = { tenantId: 'tenant', agentInstanceId: 'ar-managed' };
export const scope = { tenantId: target.tenantId, agentId: target.agentInstanceId, workspaceId: 'managed-workspace', userId: 'managed-user' };
export function permitIssuer(options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const verifier = createNativeKernelPermitVerifier({ target, verificationKeys: async () => ({ server: publicKeyPem }), ...options });
  return { verifier, publicKeyPem, signPermit(permit) {
    return { ...permit, signature: sign(null, nativeKernelPermitBytes(permit), privateKey).toString('base64url') };
  }, issue(request, operation = request.command_type, changes = {}) {
    const permit = { schema_version: 1, permit_id: request.authorization_ref, subject_ref: 'server-user',
      tenant_id: request.tenant_id, agent_instance_id: request.agent_instance_id, session_id: request.session_id,
      allowed_operations: [operation], issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
      nonce: randomUUID(), key_id: 'server', alg: 'Ed25519', claims_digest: 'server-claims', ...changes };
    return { ...permit, signature: sign(null, nativeKernelPermitBytes(permit), privateKey).toString('base64url') };
  } };
}
export const command = (fields = {}) => ({ schema_version: 1, command_id: randomUUID(), idempotency_key: randomUUID(),
  tenant_id: target.tenantId, agent_instance_id: target.agentInstanceId, session_id: 'a2a-kernel-managed', command_type: 'enqueue',
  payload: { content: 'Do the work' }, source: { kind: 'a2a', ref: 'server-request' },
  authorization_ref: randomUUID(), submitted_at: new Date().toISOString(), ...fields });
export const configuration = (command, options = {}) => configure({
  profile: { profileId: 'managed', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'managed-profile/v1' },
  hostBindingDigest: 'managed-host/v1', contract: { objective: 'Complete the admitted Server request' },
  inputMessages: [{ role: 'user', content: typeof command.payload.content === 'string' ? command.payload.content : JSON.stringify(command.payload.content) }],
  ...options,
});
export const response = (fields = {}) => ({ kind: 'final_candidate', text: 'Managed answer', toolCalls: [], usage: emptyUsage(), ...fields });
export const binding = (command, ports = { model: { generate: async () => response() }, tools: { execute: async () => ({ status: 'ok', content: '' }) } }, options = {}) => ({
  scope, buildId: 'managed-build', configuration: configuration(command, options), ports,
});
export const tool = (options = {}) => ({ name: 'write', description: 'Write a fixture', parameters: { type: 'object', properties: {} },
  readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 1000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal', ...options });
