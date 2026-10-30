import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeKernelPermitVerifier, nativeKernelPermitBytes } from '../src/providers/native-kernel-permit.mjs';
import { permitIssuer, command, target } from './fixtures/native-managed-kernel.mjs';

test('actual Ed25519 Server permit verifies resource/operation/ref and normalized UTC signature bytes', async () => {
  const issuer = permitIssuer(), request = command(), permit = issuer.issue(request);
  assert.equal((await issuer.verifier.verify(permit, request, 'enqueue')).permitId, request.authorization_ref);
  const normalized = issuer.issue(request, 'enqueue', { issued_at: '2026-10-24T09:00:00.123456+08:00', expires_at: '2026-10-24T09:04:00.999999+08:00' });
  const bytes = nativeKernelPermitBytes(normalized).toString();
  assert.match(bytes, /"issued_at":"2026-10-24T01:00:00Z"/u); assert.match(bytes, /"expires_at":"2026-10-24T01:04:00Z"/u);
  const verifier = createNativeKernelPermitVerifier({ target, verificationKeys: async () => ({ server: issuer.publicKeyPem }), clock: () => Date.parse('2026-10-24T01:02:00Z') });
  await verifier.verify(normalized, request, 'enqueue');
});
for (const [name, changes] of Object.entries({ signature: { signature: 'bad' }, key: { key_id: 'unknown' }, algorithm: { alg: 'RS256' },
  tenant: { tenant_id: 'another' }, agent: { agent_instance_id: 'another' }, session: { session_id: 'another' },
  operation: { allowed_operations: ['get_status'] }, authorization: { permit_id: 'another' },
  expired: { expires_at: new Date(0).toISOString() }, future: { issued_at: new Date(Date.now() + 100000).toISOString() },
  ttl: { issued_at: new Date(Date.now() - 400000).toISOString() } })) {
  test(`Server permit rejects ${name} without exposing signed material`, async () => {
    const issuer = permitIssuer(), request = command(), permit = issuer.issue(request);
    const changed = name === 'signature' ? { ...permit, ...changes } : issuer.signPermit({ ...permit, ...changes });
    await assert.rejects(issuer.verifier.verify(changed, request, 'enqueue'), { code: 'NATIVE_KERNEL_PERMIT_INVALID', message: 'NATIVE_KERNEL_PERMIT_INVALID' });
  });
}
test('verification snapshots input before asynchronous key rotation and does not trust prototype keys', async () => {
  const issuer = permitIssuer(), request = command(), permit = issuer.issue(request);
  let unlock; const wait = new Promise(resolve => { unlock = resolve; });
  const verifier = createNativeKernelPermitVerifier({ target, verificationKeys: async () => { await wait; return { server: issuer.publicKeyPem }; } });
  const verifying = verifier.verify(permit, request, 'enqueue'); permit.session_id = 'other'; request.session_id = 'other'; unlock(); await verifying;
  const denied = createNativeKernelPermitVerifier({ target, verificationKeys: async () => Object.create({ server: issuer.publicKeyPem }) });
  const original = command(); await assert.rejects(denied.verify(issuer.issue(original), original, 'enqueue'), { code: 'NATIVE_KERNEL_PERMIT_INVALID' });
});

test('microsecond validity and impossible dates do not gain authority through Date truncation', async () => {
  const now = Date.parse('2026-10-24T01:00:00Z'), issuer = permitIssuer({ clock: () => now }), request = command();
  const permit = issuer.issue(request, 'enqueue', { issued_at: '2026-10-24T01:00:00.000001Z', expires_at: '2026-10-24T01:01:00Z' });
  await assert.rejects(issuer.verifier.verify(permit, request, 'enqueue'), { code: 'NATIVE_KERNEL_PERMIT_INVALID' });
  const valid = issuer.issue(request, 'enqueue', { issued_at: '2026-10-24T00:59:00Z', expires_at: '2026-10-24T01:00:00.000001Z' });
  await issuer.verifier.verify(valid, request, 'enqueue');
  for (const invalid of ['2026-02-30T01:00:00Z', '2026-10-24T24:00:00Z', '0000-01-01T01:00:00Z'])
    await assert.rejects(issuer.verifier.verify({ ...valid, issued_at: invalid }, request, 'enqueue'), { code: 'NATIVE_KERNEL_PERMIT_INVALID' });
});

test('Server signing bytes have exact Python-compatible key order and second normalization', () => {
  const value = { expires_at: '2026-10-24T09:02:00.500001+08:00', issued_at: '2026-10-24T09:00:00.123456+08:00',
    extra: { '\u{10000}': 'supplementary', '\ue000': 'bmp' }, signature: 'omit' };
  assert.equal(nativeKernelPermitBytes(value).toString(), '{"expires_at":"2026-10-24T01:02:00Z","extra":{"":"bmp","𐀀":"supplementary"},"issued_at":"2026-10-24T01:00:00Z"}');
});
