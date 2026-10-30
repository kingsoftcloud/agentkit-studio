import { NativeKernel } from '../../../agentkit-harness-core/dist/index.mjs';
import { scope, digest } from '../../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../src/native/sqlite-store.mjs';

const [filename, position] = process.argv.slice(2);
const store = new SqliteRunStore(filename, { beforeCommit: ({ record }) => {
  if (position === 'inside' && record.snapshot.runId === 'run'
    && record.events.some(event => event.kind === 'child.input_queued')) process.exit(77);
} });
const childScope = { ...scope, agentId: 'child-agent' }, child = store.list(childScope)[0];
const record = store.load(childScope, child.runId), binding = record.configuration.childOwnerBinding;
// This process tests the real cross-ledger transaction. It has no model/tool
// capability and exits before any child wake or execution could occur.
const kernel = new NativeKernel({ store, owner: 'child-control-crash', digest, ports: { children: {
  controlTarget: () => ({ scope: childScope, runId: child.runId, configurationDigest: child.configDigest,
    parentOperationKey: binding.parentOperationKey, parentToolCallId: binding.parentToolCallId }),
  wakeControl: async () => { if (position === 'after') process.exit(78); throw Error('must exit inside transaction'); },
  collect: async () => { throw Error('must not execute a child'); },
} } });
await kernel.runUntilIdle(scope, 'run');
throw Error('crash checkpoint was not reached');
