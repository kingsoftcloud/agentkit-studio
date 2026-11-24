/** Shared persistence for Studio command receipts. Keep the v1 record format stable. */
import { constants, closeSync, fstatSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicPrivate, openPrivate } from '../host/private-state.mjs';

export const LOCAL_BACKGROUND_CONTRACT = 'agentkit.local-background-command/v1';
export const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export class LocalCommandError extends Error {
  constructor(code) { super(code); this.name = 'LocalCommandError'; this.code = code; }
}
export function check(condition, code) { if (!condition) throw new LocalCommandError(code); }

/** The canonical v1 digest also identifies historical command directories. */
export const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');

export function writeRecord(directory, record) {
  atomicPrivate(join(directory, 'record.json'), JSON.stringify(record) + '\n');
}
export function unknownRecord(directory, record, outcomeReason) {
  const next = { ...record, status: 'unknown', exitCode: null, completedAt: Date.now(), evidenceIncomplete: true, outcomeReason };
  writeRecord(directory, next); return next;
}

export function readWindow(path, cursor, maxBytes) {
  check(Number.isSafeInteger(cursor) && cursor >= 0, 'invalid_background_output_cursor');
  const fd = openPrivate(path, constants.O_RDONLY);
  try {
    const size = fstatSync(fd).size;
    check(cursor <= size, 'background_output_cursor_past_end');
    const data = Buffer.alloc(Math.min(maxBytes, size - cursor));
    const length = readSync(fd, data, 0, data.length, cursor);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, length), { stream: true }); }
    catch { throw new LocalCommandError('background_output_cursor_not_utf8_boundary'); }
    const next = cursor + Buffer.byteLength(text);
    return { text, cursor: next, hasMore: next < size };
  } finally { closeSync(fd); }
}
