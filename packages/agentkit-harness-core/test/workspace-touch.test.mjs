import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkspaceTouchEvidence, workspaceTouchEvidence } from '../dist/index.mjs';
import { fixture } from './fixtures.mjs';

test('instruction evidence retains current committed paths and excludes failed or historical observations and raw contents', () => {
  const { snapshot } = fixture();
  const events = [
    { seq: 1, kind: 'tool.completed', payload: { name: 'read_workspace_file', status: 'ok', content: { path: 'old.ts' } } },
    { seq: 2, kind: 'model.completed', payload: {} },
    { seq: 3, kind: 'tool.completed', payload: { name: 'read_workspace_file', status: 'ok', content: { path: 'pkg/file.ts', text: 'PRIVATE_RAW_BODY' } } },
    { seq: 4, kind: 'tool.completed', payload: { name: 'write_workspace_files', status: 'ok', content: {
      written: [{ path: 'nested/AGENTS.md', private: 'PRIVATE_METADATA' }, null, 'not an object', { path: 7 }] } } },
    { seq: 5, kind: 'tool.completed', payload: { name: 'apply_workspace_patch', status: 'ok', content: { changed_paths: ['new.ts', 'old.ts', 7] } } },
    { seq: 6, kind: 'tool.completed', payload: { name: 'read_workspace_file', status: 'uncertain', content: { path: 'unconfirmed.ts' } } },
  ];
  const view = projectWorkspaceTouchEvidence({ snapshot: { ...snapshot, eventSeq: 6 }, events });
  assert.equal(view.afterModelSeq, 2);
  assert.deepEqual(view.observations, [
    { seq: 3, toolName: 'read_workspace_file', path: 'pkg/file.ts', writtenPaths: [], changedPaths: [] },
    { seq: 4, toolName: 'write_workspace_files', writtenPaths: ['nested/AGENTS.md'], changedPaths: [] },
    { seq: 5, toolName: 'apply_workspace_patch', writtenPaths: [], changedPaths: ['new.ts', 'old.ts'] },
  ]);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_RAW_BODY|PRIVATE_METADATA|unconfirmed.ts|messages|configuration/);
});

test('workspace evidence has a positive identity boundary and rejects invalid cursors and extra observation payloads', () => {
  const { snapshot } = fixture();
  assert.deepEqual(Object.keys(workspaceTouchEvidence(snapshot, 0, []).identity).sort(),
    ['eventSeq', 'revision', 'runId', 'scope', 'sessionId']);
  for (const [identity, after, observations] of [
    [snapshot, 1, []], [{ ...snapshot, eventSeq: 2 }, -1, []],
    [{ ...snapshot, eventSeq: 2 }, 1, [{ seq: 1, toolName: 'read', writtenPaths: [], changedPaths: [] }]],
    [{ ...snapshot, eventSeq: 2 }, 0, [{ seq: 1, toolName: 'read', writtenPaths: [], changedPaths: [], raw: 'PRIVATE' }]],
  ]) assert.throws(() => workspaceTouchEvidence(identity, after, observations), { code: 'invalid_workspace_touch_evidence' });
});
