// Automatic memory-extraction scheduling primitive.
//
// Modified Apache-2.0 code; attribution and license: THIRD_PARTY_NOTICES.md.
// A single-flight, one-pending-coalesced scheduler that
// runs an extraction `execute` over a snapshot window after a durable cursor.
// The cursor is in-memory only here; persistent cursor/job storage belongs to
// the Host. A failed `onCursor` persistence callback does not advance the
// in-memory cursor, matching the reference's "errors do not advance" rule
// extended to the post-await commit.

export type MemoryExtractionExecutionStatus = 'success' | 'no-op' | 'error' | 'aborted';

/** Generic extraction snapshot. `directMemoryWrite` marks a message whose
 * durable memory mutation already covers this window (reference: a manual
 * Write/Edit inside the memory directory); its presence suppresses
 * re-extraction of the same window. */
export interface MemoryExtractionSnapshot {
  readonly boundaryId: string;
  readonly messages: readonly MemoryExtractionMessage[];
}

export interface MemoryExtractionMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly synthetic?: boolean;
  readonly modelOnly?: boolean;
  readonly directMemoryWrite?: boolean;
}

export type MemoryExtractionDecision =
  | { readonly decision: 'run'; readonly messageCount: number }
  | { readonly decision: 'skip'; readonly messageCount: number;
    readonly reason: 'direct-memory-write' | 'no-user-prose' };

export interface MemoryExtractionExecutionInput {
  readonly abortSignal: AbortSignal;
  readonly messageCount: number;
  readonly snapshot: MemoryExtractionSnapshot;
}

export interface MemoryExtractionScheduler {
  drain(): Promise<void>;
  getCursor(): string | undefined;
  hasPendingWork(): boolean;
  schedule(snapshot: MemoryExtractionSnapshot | Promise<MemoryExtractionSnapshot>): void;
  shutdown(): void;
}

const MINIMUM_USER_WORDS = 3;

/** Count messages after the cursor; an absent or unfound cursor covers all. */
export function countMessagesAfterCursor(
  messages: readonly MemoryExtractionMessage[],
  cursor: string | undefined,
): number {
  if (!cursor) return messages.length;
  const cursorIndex = messages.findIndex(message => message.id === cursor);
  return cursorIndex < 0 ? messages.length : messages.length - cursorIndex - 1;
}

/** Eligibility gate mirroring extraction.evaluateMemoryExtraction. */
export function evaluateMemoryExtraction(
  snapshot: MemoryExtractionSnapshot,
  cursor?: string,
): MemoryExtractionDecision {
  const messageCount = countMessagesAfterCursor(snapshot.messages, cursor);
  const after = messagesAfterFoundCursor(snapshot.messages, cursor);

  if (after !== undefined && after.some(message => message.directMemoryWrite === true)) {
    return { decision: 'skip', messageCount, reason: 'direct-memory-write' };
  }
  if (!containsEligibleUserProse(after ?? snapshot.messages)) {
    return { decision: 'skip', messageCount, reason: 'no-user-prose' };
  }
  return { decision: 'run', messageCount };
}

/** Create a single-flight, one-pending-coalesced extraction scheduler.
 *
 * `execute` runs the extraction over one snapshot window; it receives the
 * scheduler's abort signal so `shutdown` can abort an in-flight run. `schedule`
 * accepts a snapshot or a Promise that resolves to one; acquisition rejections
 * are caught and never advance the cursor. `onCursor(boundaryId, snapshot)` is
 * awaited after a `success`/`no-op` (or skip) and must resolve before the
 * in-memory cursor advances; a rejected or throwing `onCursor` leaves the
 * cursor where it was. The scheduler never advances after `shutdown`.
 *
 * `schedule` promises always carry rejection handlers (coalescing and shutdown
 * never leave an unhandled rejection). `shutdown` aborts running `execute`
 * immediately and does not wait for an unabortable snapshot acquisition. */
export function createMemoryExtractionScheduler(
  execute: (input: MemoryExtractionExecutionInput) => Promise<MemoryExtractionExecutionStatus>,
  { initialCursor, onCursor }: { initialCursor?: string; onCursor?: (boundaryId: string, snapshot: MemoryExtractionSnapshot) => Promise<void> } = {},
): MemoryExtractionScheduler {
  let cursor = initialCursor;
  let latestPending: Promise<SnapshotAcquisition> | undefined;
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdownController = new AbortController();

  const advanceCursor = async (snapshot: MemoryExtractionSnapshot): Promise<void> => {
    const boundaryId = snapshot.boundaryId;
    if (!boundaryId) return;
    if (onCursor) await onCursor(boundaryId, snapshot);
    // Re-check shutdown after the awaited persistence callback: a shutdown
    // that lands while onCursor is in flight must not advance the cursor,
    // mirroring the post-execute re-check. A failed onCursor throws and the
    // caller's catch prevents the assignment below from running.
    if (shuttingDown) return;
    cursor = boundaryId;
  };

  const processSnapshot = async (snapshot: MemoryExtractionSnapshot): Promise<void> => {
    const decision = evaluateMemoryExtraction(snapshot, cursor);
    if (decision.decision === 'skip') {
      // A skip still commits the boundary, but only after a successful onCursor.
      // advanceCursor re-checks shutdown after the await and throws on failure;
      // the catch here swallows the throw without advancing.
      if (!shuttingDown) await advanceCursor(snapshot).catch(() => {});
      return;
    }
    let status: MemoryExtractionExecutionStatus;
    try {
      status = await execute({ abortSignal: shutdownController.signal, messageCount: decision.messageCount, snapshot });
    } catch {
      return;
    }
    // Re-check shutdown after the await; a shutdown during execute must not
    // advance even on a reported success. onCursor failure must not advance.
    if (shuttingDown) return;
    if (status !== 'success' && status !== 'no-op') return;
    await advanceCursor(snapshot);
  };

  const run = async (first: Promise<SnapshotAcquisition>): Promise<void> => {
    try {
      let current: Promise<SnapshotAcquisition> | undefined = first;
      while (current && !shuttingDown) {
        const acquisition = await waitForSnapshotAcquisitionOrShutdown(current, shutdownController.signal);
        if (acquisition.status === 'shutdown' || shuttingDown) break;
        if (acquisition.status === 'acquired') {
          try {
            await processSnapshot(acquisition.snapshot);
          } catch {
            // processSnapshot swallows execute errors itself; a throw from
            // advanceCursor (onCursor) is caught here and does not advance.
          }
        }
        current = shuttingDown ? undefined : latestPending;
        latestPending = undefined;
      }
    } finally {
      if (shuttingDown) latestPending = undefined;
      running = undefined;
    }
  };

  return {
    async drain() {
      // drain waits for the cooperative completion of any in-flight run even
      // after shutdown; shutdown itself is nonblocking and does not abort the
      // run promise synchronously.
      while (running) await running;
    },
    getCursor() {
      return cursor;
    },
    hasPendingWork() {
      // Once shutdown has begun, no new work is accepted and in-flight runs
      // drain cooperatively; report no pending work so callers can treat
      // shutdown as terminal without losing the drain() wait.
      if (shuttingDown) return false;
      return running !== undefined || latestPending !== undefined;
    },
    schedule(snapshot) {
      if (shuttingDown) {
        // A snapshot (or Promise) handed to a shut-down scheduler is dropped.
        // Attach a rejection handler so a rejected Promise does not surface as
        // an unhandled rejection after the scheduler stopped observing it.
        Promise.resolve(snapshot).catch(() => {});
        return;
      }
      const acquisition = acquireSnapshot(snapshot);
      if (running) {
        latestPending = acquisition;
        return;
      }
      running = run(acquisition);
      // Attach a rejection handler so a run rejection (defensive: processSnapshot
      // catches) never surfaces as an unhandled rejection on this scheduler.
      running.catch(() => {});
    },
    shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      latestPending = undefined;
      shutdownController.abort();
    },
  };
}

type SnapshotAcquisition =
  | { readonly status: 'acquired'; readonly snapshot: MemoryExtractionSnapshot }
  | { readonly status: 'error' };

type SnapshotAcquisitionWait = SnapshotAcquisition | { readonly status: 'shutdown' };

function acquireSnapshot(snapshot: MemoryExtractionSnapshot | Promise<MemoryExtractionSnapshot>): Promise<SnapshotAcquisition> {
  return Promise.resolve(snapshot).then(
    value => ({ status: 'acquired', snapshot: value }),
    () => ({ status: 'error' }),
  );
}

function waitForSnapshotAcquisitionOrShutdown(
  acquisition: Promise<SnapshotAcquisition>,
  signal: AbortSignal,
): Promise<SnapshotAcquisitionWait> {
  if (signal.aborted) return Promise.resolve({ status: 'shutdown' });
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: SnapshotAcquisitionWait): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish({ status: 'shutdown' });
    signal.addEventListener('abort', onAbort, { once: true });
    void acquisition.then(result => finish(result));
  });
}

function messagesAfterFoundCursor(
  messages: readonly MemoryExtractionMessage[],
  cursor: string | undefined,
): readonly MemoryExtractionMessage[] | undefined {
  if (!cursor) return messages;
  const cursorIndex = messages.findIndex(message => message.id === cursor);
  return cursorIndex < 0 ? undefined : messages.slice(cursorIndex + 1);
}

function containsEligibleUserProse(messages: readonly MemoryExtractionMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.synthetic === true || message.modelOnly === true) continue;
    if (countWords(message.text) >= MINIMUM_USER_WORDS) return true;
  }
  return false;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}
