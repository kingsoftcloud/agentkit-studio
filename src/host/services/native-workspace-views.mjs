import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { validateNativeWorkspaceContext } from '@kingsoftcloud/agentkit-harness-node/native/workspace-context';
import { createWorkspaceGitStatus } from './workspace-status.mjs';

/** Read-only workspace views follow the Run's frozen binding, not the Host cwd. */
export function createStudioNativeWorkspaceViews({ store, workspaceRoot: defaultWorkspaceRoot, lifetimeSignal }) {
  // The durable ledger namespace remains installation-owned; each Run freezes
  // its own physical execution directory independently.
  const workspaceId = createHash('sha256').update(canonical(resolve(defaultWorkspaceRoot))).digest('hex');
  const workspaceRoots = new Map();
  const rootForRecord = source => {
    if (!source) return defaultWorkspaceRoot;
    const { snapshot } = source, cached = workspaceRoots.get(snapshot.runId);
    if (cached?.configDigest === snapshot.configDigest) return cached.root;
    const record = source.configuration ? source : typeof store.authority === 'function'
      ? store.authority(snapshot.scope, snapshot.runId) : store.load(snapshot.scope, snapshot.runId);
    invariant(record && record.snapshot.configDigest === snapshot.configDigest
      && record.snapshot.sessionId === snapshot.sessionId && canonical(record.snapshot.scope) === canonical(snapshot.scope),
      'studio_native_workspace_record_changed');
    const context = record.configuration.hostRecoveryBinding?.workspaceContext;
    const root = context ? validateNativeWorkspaceContext(context).workspaceRoot : defaultWorkspaceRoot;
    if (workspaceRoots.size >= 256) workspaceRoots.delete(workspaceRoots.keys().next().value);
    workspaceRoots.set(snapshot.runId, { configDigest: snapshot.configDigest, root });
    return root;
  };
  const workspaceStatuses = new Map();
  const workspaceStatus = (signal, source) => {
    const root = rootForRecord(source);
    if (!workspaceStatuses.has(root)) {
      if (workspaceStatuses.size >= 256) workspaceStatuses.delete(workspaceStatuses.keys().next().value);
      workspaceStatuses.set(root, createWorkspaceGitStatus({ workspaceRoot: root, lifetimeSignal }));
    }
    return workspaceStatuses.get(root).read(signal);
  };
  return { workspaceId, rootForRecord, workspaceStatus };
}
