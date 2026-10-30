import { configure, initialSnapshot, canonical } from '../dist/index.mjs';
import { createHash } from 'node:crypto';
export const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const acceptance = (overrides = {}) => ({ id: 'test', required: true, verifierRef: 'fixture', verifierVersion: '1',
  verificationMethod: 'deterministic', description: 'Verify fixture behavior', ...overrides });
export const verificationReport = (request, overrides = {}) => ({ status: 'passed', reason: 'fixture',
  candidateId: request.candidate.candidateId, contractRevision: request.contract.revision,
  binding: request.candidate.binding, workspaceRevision: request.candidate.workspaceRevision,
  checks: [{ id: 'test', status: 'passed', verifierId: 'fixture', verifierVersion: '1', verificationMethod: 'deterministic',
    evidence: 'Actual fixture result', evidenceRefs: ['fixture://verified-result'] }], ...overrides });
export const tool = (overrides = {}) => ({ name: 'read', description: 'Read a fixture', parameters: { type: 'object', properties: {} },
  readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 1000,
  contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal', ...overrides });
export function fixture(overrides = {}) {
  const config = configure({
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' },
    contract: { objective: 'Complete the task' }, hostBindingDigest: 'fixture-host/v1', ...overrides,
  });
  const snapshot = initialSnapshot({ scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config, digest(config));
  return { config, snapshot };
}
