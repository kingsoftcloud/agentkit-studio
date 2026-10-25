/** Trusted Host callback authorization. A registry record is deliberately
 * insufficient: every use checks the live original grant and Server signature.
 * No signing key, request-supplied key, endpoint or public management API. */
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { validateTeamsCallbackPermit } from './native-teams-context-contract.mjs';
import { canonicalTeamsJson } from './native-teams-json.mjs';

export const NATIVE_TEAMS_CALLBACK_AUTHORITY_CONTRACT = 'agentkit.native-teams-callback-authority/v1';
const code = 'NATIVE_TEAMS_CALLBACK_UNAUTHORIZED';
const check = condition => invariant(condition, code);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const required = ['authorityId', 'agentInstanceId', 'sessionId', 'commandId', 'policyDigest', 'attemptEpoch', 'grantRevision',
  'groupId', 'teamRunId', 'memberId', 'bundleDigest', 'leaderEpoch'];

export function nativeTeamsCallbackPermitBytes(raw) {
  const permit = validateTeamsCallbackPermit(raw); delete permit.signature;
  // Teams uses RFC8785 / UTF16 key order, unlike legacy AgentControl permits.
  return Buffer.from(canonicalTeamsJson(permit));
}

export function createNativeTeamsCallbackPermitVerifier({ verificationKeys, issuer, clock = Date.now } = {}) {
  check(typeof verificationKeys === 'function' && typeof issuer === 'string' && issuer.length > 0 && typeof clock === 'function');
  return Object.freeze({ async verify(raw, { operation, expected, grantExpiresAt } = {}) {
    try {
      // The caller and rotating key source may be asynchronous. Freeze exactly
      // the claims being authenticated before yielding to either of them.
      const permit = validateTeamsCallbackPermit(raw), scope = copy(expected);
      check(object(scope) && required.every(key => Object.hasOwn(scope, key)) && permit.issuer === issuer
        && typeof operation === 'string' && permit.allowedOperations.includes(operation)
        && Object.entries(scope).every(([key, value]) => Object.hasOwn(permit, key) && canonical(permit[key]) === canonical(value)));
      const deadline = grantExpiresAt === null ? null : Date.parse(grantExpiresAt);
      if (permit.permitKind === 'execute') check(typeof grantExpiresAt === 'string' && Number.isFinite(deadline)
        && Date.parse(permit.expiresAt) <= deadline);
      const keys = await verificationKeys(), pem = keys instanceof Map ? keys.get(permit.kid)
        : object(keys) && Object.hasOwn(keys, permit.kid) ? keys[permit.kid] : null;
      check(typeof pem === 'string' && Buffer.byteLength(pem) <= 64 * 1024);
      const publicKey = createPublicKey(pem), signature = Buffer.from(permit.signature, 'base64url');
      check(publicKey.asymmetricKeyType === 'ed25519' && signature.length === 64 && signature.toString('base64url') === permit.signature
        && verifySignature(null, nativeTeamsCallbackPermitBytes(permit), publicKey, signature));
      const now = clock(); check(Number.isSafeInteger(now) && Date.parse(permit.issuedAt) <= now && now < Date.parse(permit.expiresAt)
        && (permit.permitKind !== 'execute' || now < deadline));
      return permit;
    } catch { invariant(false, code); }
  } });
}

export function createNativeTeamsCallbackAuthority({ contexts, executionGrants, verifier, expectedIncarnation } = {}) {
  check(contexts?.contract === 'agentkit.managed-native-teams-context/v1'
    && executionGrants?.contract === 'agentkit.managed-native-execution-grants/v1' && typeof verifier?.verify === 'function'
    && typeof expectedIncarnation === 'string' && contexts.incarnation() === expectedIncarnation);
  const opts = Object.freeze({ expectedIncarnation });
  function expected(context, grant) {
    return { authorityId: context.ref.authorityId, agentInstanceId: context.grant.agent_instance_id,
      sessionId: context.ref.sessionId, commandId: context.ref.commandId, policyDigest: context.policy_digest,
      attemptEpoch: context.ref.attemptEpoch, grantRevision: grant.revision, groupId: context.ref.groupId,
      teamRunId: context.ref.teamRunId, memberId: context.ref.memberId, bundleDigest: context.ref.bundleDigest, leaderEpoch: context.ref.leaderEpoch };
  }
  return Object.freeze({ contract: NATIVE_TEAMS_CALLBACK_AUTHORITY_CONTRACT,
    async authorize(contextRef, operation) {
      const context = contexts.get(contextRef, opts); check(context);
      const grant = executionGrants.require(context.grant), permit = contexts.getCallback(contextRef, grant.revision, opts);
      check(permit && permit.permitKind === 'execute');
      const verified = await verifier.verify(permit, { operation, expected: expected(context, grant), grantExpiresAt: grant.expires_at });
      // Key refresh must never hide revocation, suspension, store replacement
      // or a new grant revision that committed while verification was awaiting.
      const current = executionGrants.require(context.grant), original = contexts.get(contextRef, opts);
      check(current.revision === grant.revision && canonical(original) === canonical(context)
        && canonical(verified) === canonical(permit));
      return { context: copy(original), grant: copy(current), permit: copy(verified) };
    },
  });
}
