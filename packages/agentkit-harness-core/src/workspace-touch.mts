import type { NativeEvent, RunSnapshot } from './contracts.mjs';
import { copy, invariant, scopeKey } from './values.mjs';
import { validateInstructionScopes, type InstructionScopes } from './instruction-scopes.mjs';

export const WORKSPACE_TOUCH_EVIDENCE = 'agentkit.workspace-touch-evidence/v1';
type Identity = Pick<RunSnapshot, 'scope' | 'runId' | 'sessionId' | 'revision' | 'eventSeq'>;
export interface WorkspaceTouchObservation {
  seq: number; toolName: string; path?: string; writtenPaths: string[]; changedPaths: string[];
}
/** Authoritative committed event facts for input refresh, never a UI cache or
 * permission grant. The consumer still owns tool selection and path semantics. */
export interface WorkspaceTouchEvidence {
  contract: typeof WORKSPACE_TOUCH_EVIDENCE;
  identity: Identity;
  afterModelSeq: number;
  observations: WorkspaceTouchObservation[];
  instructionScopes?: InstructionScopes;
}
export function workspaceTouchEvidence(identity: Identity, afterModelSeq: number,
  observations: WorkspaceTouchObservation[], instructionScopes?: InstructionScopes): WorkspaceTouchEvidence {
  scopeKey(identity.scope);
  invariant([identity.runId, identity.sessionId].every(value => typeof value === 'string' && value.trim())
    && [identity.revision, identity.eventSeq, afterModelSeq].every(value => Number.isSafeInteger(value) && value >= 0)
    && afterModelSeq <= identity.eventSeq && Array.isArray(observations), 'invalid_workspace_touch_evidence');
  let previous = afterModelSeq;
  for (const item of observations) {
    invariant(item && Number.isSafeInteger(item.seq) && item.seq > previous && item.seq <= identity.eventSeq
      && typeof item.toolName === 'string' && item.toolName.trim()
      && Object.keys(item).every(key => ['seq', 'toolName', 'path', 'writtenPaths', 'changedPaths'].includes(key))
      && (item.path === undefined || typeof item.path === 'string')
      && [item.writtenPaths, item.changedPaths].every(paths => Array.isArray(paths)
        && paths.every(path => typeof path === 'string')), 'invalid_workspace_touch_evidence');
    previous = item.seq;
  }
  const { scope, runId, sessionId, revision, eventSeq } = identity;
  return copy({ contract: WORKSPACE_TOUCH_EVIDENCE, identity: { scope, runId, sessionId, revision, eventSeq }, afterModelSeq, observations,
    ...(instructionScopes === undefined ? {} : { instructionScopes: validateInstructionScopes(instructionScopes) }) });
}

/** Reference projection for memory/backends without the indexed read API. */
export function projectWorkspaceTouchEvidence(record: { snapshot: Identity & { context?: RunSnapshot['context'] }; events: NativeEvent[] }): WorkspaceTouchEvidence {
  const { scope, runId, sessionId, revision, eventSeq } = record.snapshot;
  let after = 0;
  for (const event of record.events) if (event.kind === 'model.completed' && event.seq <= eventSeq) after = event.seq;
  const observations = record.events.flatMap(event => {
    const value = event.payload, content = value.content as Record<string, unknown> | null;
    if (event.seq <= after || event.seq > eventSeq || event.kind !== 'tool.completed' || value.status !== 'ok'
      || typeof value.name !== 'string' || !value.name.trim()) return [];
    return [{ seq: event.seq, toolName: value.name,
      ...(typeof content?.path === 'string' ? { path: content.path } : {}),
      writtenPaths: Array.isArray(content?.written) ? content.written.flatMap(item => item && typeof item === 'object'
        && typeof item.path === 'string' ? [item.path] : []) : [],
      changedPaths: Array.isArray(content?.changed_paths) ? content.changed_paths.filter(path => typeof path === 'string') : [] }];
  });
  return workspaceTouchEvidence({ scope, runId, sessionId, revision, eventSeq }, after, observations,
    record.snapshot.context?.instructionScopes as InstructionScopes | undefined);
}
