import type { CommitBatch, StoredRun, RunSnapshot } from './contracts.mjs';

/** Evidence needed to validate one atomic append, not the historical ledger. */
export interface LedgerCommitState extends Pick<StoredRun, 'configuration' | 'snapshot' | 'lease' | 'fence' | 'commands' | 'intents'> {
  existingEventIds: string[];
  existingReceiptKeys: string[];
  duplicateCommit: StoredRun['commits'][number] | null;
}
export interface LedgerCommitChanges {
  snapshot: RunSnapshot;
  events: StoredRun['events'];
  intents: StoredRun['intents'];
  receipts: StoredRun['receipts'];
  commands: StoredRun['commands'];
  commit: StoredRun['commits'][number];
}

/** Memory/reference backends and SQL use the same Core validation boundary. */
export function projectLedgerCommitState(record: StoredRun, batch: CommitBatch): LedgerCommitState {
  const keys = new Set([...batch.intents, ...batch.receipts].map(item => item.operationKey));
  const received = new Set(record.receipts.map(item => item.operationKey));
  const intents = record.intents.filter(item => keys.has(item.operationKey) || !received.has(item.operationKey));
  const referenced = new Set([...intents.map(item => item.operationKey), ...keys]);
  const eventIds = new Set(batch.events.map(event => event.eventId));
  return { configuration: record.configuration, snapshot: record.snapshot, lease: record.lease, fence: record.fence,
    commands: record.commands.filter(row => !row.consumed), intents,
    existingEventIds: record.events.filter(event => eventIds.has(event.eventId)).map(event => event.eventId),
    existingReceiptKeys: [...received].filter(key => referenced.has(key)),
    duplicateCommit: record.commits.find(item => item.commitId === batch.commitId) ?? null };
}
export function applyLedgerCommitChanges(record: StoredRun, changes: LedgerCommitChanges | null): StoredRun {
  if (!changes) return record;
  const consumed = new Map(changes.commands.map(row => [row.command.commandId, row]));
  return { ...record, snapshot: changes.snapshot,
    commands: record.commands.map(row => consumed.get(row.command.commandId) ?? row),
    events: [...record.events, ...changes.events], intents: [...record.intents, ...changes.intents],
    receipts: [...record.receipts, ...changes.receipts], commits: [...record.commits, changes.commit] };
}
