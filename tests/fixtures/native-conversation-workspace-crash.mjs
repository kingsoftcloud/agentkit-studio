// Test-only separate process: die after the original private Host publication.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonical } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeWorkspaceTools } from '../../packages/agentkit-harness/src/native/workspace-tools.mjs';
import { committedWorkspaceCheckpoint } from '../../packages/agentkit-harness/src/native/workspace-checkpoints.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';

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
