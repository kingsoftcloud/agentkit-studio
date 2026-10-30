// Unit tests for the durable requestId ledger. Core-free: this exercises only
// rpc-ledger.mjs against a real SQLite file (and a :memory: variant), proving
// the cross-restart idempotency and conflict guarantees the RPC protocol
// promises — without the kernel or adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpcRequestLedger, digestRequest } from '../src/rpc-ledger.mjs';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-ledger-'));
  return { dir, file: join(dir, 'ledger.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('recordPending: new -> pending -> completed lifecycle', () => {
  const { file, cleanup } = tmpFile();
  try {
    const ledger = new RpcRequestLedger(file);
    const d = digestRequest('task/submit', { objective: 'a' });
    assert.deepEqual(ledger.recordPending('r1', 'task/submit', d, 'rk1'), { state: 'new' });
    // Same requestId + same digest while pending returns pending (no re-run).
    assert.deepEqual(ledger.recordPending('r1', 'task/submit', d, 'rk1'),
      { state: 'pending', runKey: 'rk1', response: null });
    ledger.complete('r1', { phase: 'completed' }, 'rk1');
    // After completion, a retry returns the stored response (idempotent).
    assert.deepEqual(ledger.recordPending('r1', 'task/submit', d, 'rk1'),
      { state: 'completed', runKey: 'rk1', response: { phase: 'completed' } });
    assert.equal(ledger.lookup('r1').status, 'completed');
    ledger.close();
  } finally { cleanup(); }
});

test('recordPending rejects a requestId reused with different parameters as a conflict', () => {
  const { file, cleanup } = tmpFile();
  try {
    const ledger = new RpcRequestLedger(file);
    const dA = digestRequest('task/submit', { objective: 'a' });
    const dB = digestRequest('task/submit', { objective: 'b' });
    ledger.recordPending('r1', 'task/submit', dA, 'rk1');
    let conflict = null;
    try { ledger.recordPending('r1', 'task/submit', dB, 'rk1'); }
    catch (e) { conflict = e; }
    assert.ok(conflict, 'a different digest for the same requestId must conflict');
    assert.equal(conflict.code, 'request_id_conflict');
    assert.equal(conflict.requestId, 'r1');
    // A different method also conflicts even with the same digest payload.
    const dC = digestRequest('task/submit', { objective: 'a' });
    try { ledger.recordPending('r1', 'task/status', dC, 'rk1'); }
    catch (e) { assert.equal(e.code, 'request_id_conflict'); }
    ledger.close();
  } finally { cleanup(); }
});

test('the ledger is durable across a process restart (reopen)', () => {
  const { file, cleanup } = tmpFile();
  try {
    const d = digestRequest('task/submit', { objective: 'a' });
    let ledger = new RpcRequestLedger(file);
    ledger.recordPending('r1', 'task/submit', d, 'rk1');
    ledger.complete('r1', { phase: 'completed', finalText: 'done' }, 'rk1');
    ledger.recordPending('r2', 'task/submit', d, 'rk2'); // left pending (crash)
    ledger.close();
    // A new process reopens the same file: completed rows and pending rows survive.
    ledger = new RpcRequestLedger(file);
    assert.equal(ledger.lookup('r1').status, 'completed');
    assert.deepEqual(ledger.lookup('r1').response, { phase: 'completed', finalText: 'done' });
    assert.equal(ledger.lookup('r2').status, 'pending');
    // Re-submitting the pending requestId does NOT re-run: it returns pending.
    assert.equal(ledger.recordPending('r2', 'task/submit', d, 'rk2').state, 'pending');
    // lookupByRunKey finds the row to complete it after a background drive.
    assert.equal(ledger.lookupByRunKey('rk2').requestId, 'r2');
    ledger.complete('r2', { phase: 'interrupted' }, 'rk2');
    assert.equal(ledger.lookup('r2').status, 'completed');
    ledger.close();
  } finally { cleanup(); }
});

test(':memory: ledger works for ephemeral use and closes cleanly', () => {
  const ledger = new RpcRequestLedger(':memory:');
  const d = digestRequest('task/submit', { objective: 'x' });
  assert.equal(ledger.recordPending('m1', 'task/submit', d, 'mk1').state, 'new');
  ledger.complete('m1', { phase: 'completed' });
  assert.equal(ledger.lookup('m1').status, 'completed');
  ledger.close();
  assert.throws(() => ledger.recordPending('m2', 'task/submit', d, 'mk2'), /ledger_closed/);
});

test('invalid requestId is rejected', () => {
  const { file, cleanup } = tmpFile();
  try {
    const ledger = new RpcRequestLedger(file);
    assert.throws(() => ledger.recordPending('', 'task/submit', 'd', 'k'), /invalid_request_id/);
    assert.throws(() => ledger.recordPending(null, 'task/submit', 'd', 'k'), /invalid_request_id/);
    ledger.close();
  } finally { cleanup(); }
});

test('digestRequest is order-independent for object params', () => {
  assert.equal(digestRequest('m', { a: 1, b: 2 }), digestRequest('m', { b: 2, a: 1 }));
  assert.notEqual(digestRequest('m', { a: 1 }), digestRequest('m', { a: 2 }));
  assert.notEqual(digestRequest('m', { a: 1 }), digestRequest('m2', { a: 1 }));
});
