// Test-only separate process: die after the original private Host publication.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { committedWorkspaceCheckpoint } from '@kingsoftcloud/agentkit-harness-node/native/workspace-checkpoints';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const store = new SqliteRunStore(join(input.root, 'runs.sqlite'));
const tools = createNativeWorkspaceTools({ workspaceRoot: join(input.root, 'workspace'), stateDir: join(input.root, 'state'),
  sessionId: 'session', authorize: async () => 'allow', enablePatches: true, enableRewind: true });
tools.rewindConversation(input.control, { signal: new AbortController().signal,
  checkpointCommitted: row => committedWorkspaceCheckpoint(row, { store, scope: input.control.scope, sessionId: 'session' }),
  selectCheckpoint: () => input.checkpointId,
  assertCurrent() {
    const record = store.load(input.control.scope, input.control.expectedHeadRunId);
    if (store.sessionHead(input.control.scope, 'session').runId !== input.control.expectedHeadRunId
      || createHash('sha256').update(canonical(record)).digest('hex') !== input.control.sourceDigest) return false;
    if (readFileSync(join(input.root, 'workspace/a.txt'), 'utf8') === 'Before') {
      writeFileSync(join(input.root, 'control-publication-crash.json'), JSON.stringify({ pid: process.pid, commandId: input.control.commandId }));
      process.kill(process.pid, 'SIGKILL');
    }
    return true;
  } });
throw Error('Crash proof did not reach the publication boundary');
