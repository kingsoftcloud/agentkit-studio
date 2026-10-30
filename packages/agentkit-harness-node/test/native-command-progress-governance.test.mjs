import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandProgressObserver, COMMAND_PREVIEW_CONTRACT } from '../src/native/command-progress.mjs';
import { LOCAL_COMMAND_PROGRESS_CONTRACT } from '../src/native/local-command-tools.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const chunk = (sequence, text, channel = 'stdout') => ({ contract: LOCAL_COMMAND_PROGRESS_CONTRACT, sequence, text, channel });

test('only Host-projected bytes reach a preview, including secrets split across output chunks', async () => {
  const controller = new AbortController(), frames = [];
  const observer = createCommandProgressObserver({ signal: controller.signal, isCurrent: () => true,
    project: value => value.stdout.endsWith('\n') && !value.truncated
      ? { kind: 'command_preview', stdout: value.stdout.replaceAll('SECRET', '[redacted]'), stderr: '' } : null,
    publish: frame => frames.push(frame) });
  try {
    observer.observe(chunk(1, 'token=SEC')); await tick(); assert.deepEqual(frames, []);
    observer.observe(chunk(2, 'RET\n')); await tick();
    assert.equal(frames.length, 1); assert.equal(frames[0].contract, COMMAND_PREVIEW_CONTRACT);
    assert.deepEqual(frames[0].display, { kind: 'command_preview', stdout: 'token=[redacted]\n', stderr: '' });
    assert.equal(JSON.stringify(frames).includes('SECRET'), false);
  } finally { observer.close(); }
});

for (const reason of ['abort', 'close', 'revoke']) test(`asynchronous projection cannot publish after ${reason}`, async () => {
  const controller = new AbortController(), frames = [];
  let resolve, current = true;
  const observer = createCommandProgressObserver({ signal: controller.signal, isCurrent: () => current,
    project: () => new Promise(done => { resolve = done; }), publish: frame => frames.push(frame) });
  observer.observe(chunk(1, 'before'));
  if (reason === 'abort') controller.abort(); else if (reason === 'close') observer.close(); else current = false;
  resolve({ kind: 'command_preview', stdout: 'must not appear', stderr: '' }); await tick();
  assert.deepEqual(frames, []); observer.close();
});

test('slow projection coalesces bounded input and rejects completion claims in previews', async () => {
  const controller = new AbortController(), frames = [], inputs = [];
  let resolve;
  const observer = createCommandProgressObserver({ signal: controller.signal, maxBytes: 16, isCurrent: () => true,
    project: snapshot => {
      inputs.push(snapshot);
      return inputs.length === 1 ? new Promise(done => { resolve = done; })
        : { kind: 'command_preview', stdout: 'safe', stderr: '', exit: 0 };
    }, publish: frame => frames.push(frame) });
  try {
    observer.observe(chunk(1, '😀'));
    for (let i = 2; i <= 100; i++) observer.observe(chunk(i, 'abcd'));
    resolve(null); await tick();
    assert.equal(inputs.length, 2); assert.equal(inputs[1].sequence, 100); assert.equal(inputs[1].truncated, true);
    assert.ok(Buffer.byteLength(inputs[1].stdout) + Buffer.byteLength(inputs[1].stderr) <= 16);
    assert.deepEqual(frames, []);
  } finally { observer.close(); }
});

test('missing governance fails closed and projection/publisher failures remain observation-only', async () => {
  const controller = new AbortController();
  assert.throws(() => createCommandProgressObserver({ signal: controller.signal, isCurrent: () => true, publish() {} }));
  let projects = 0, publications = 0;
  const observer = createCommandProgressObserver({ signal: controller.signal, isCurrent: () => true,
    project: () => { if (++projects === 1) throw Error('governor unavailable'); return { kind: 'command_preview', stdout: 'safe', stderr: '' }; },
    publish: () => { publications++; return Promise.reject(Error('client disconnected')); } });
  try {
    observer.observe(chunk(1, 'first')); await tick(); assert.equal(publications, 0);
    observer.observe(chunk(2, 'next')); await tick(); assert.equal(publications, 1);
    observer.observe(chunk(1, 'old sequence')); await tick(); assert.equal(publications, 1);
  } finally { observer.close(); }
});

test('throwing projection accessors and asynchronous authority checks are contained', async () => {
  const controller = new AbortController(), frames = [];
  let count = 0;
  const observer = createCommandProgressObserver({ signal: controller.signal, isCurrent: () => true,
    project: () => ++count === 1 ? { get kind() { throw Error('invalid projection'); } }
      : { kind: 'command_preview', stdout: 'safe', stderr: '' }, publish: frame => frames.push(frame) });
  try {
    observer.observe(chunk(1, 'first')); await tick(); assert.deepEqual(frames, []);
    observer.observe(chunk(2, 'second')); await tick(); assert.equal(frames.length, 1);
    const invalidAuthority = createCommandProgressObserver({ signal: controller.signal,
      isCurrent: () => Promise.reject(Error('authority must be synchronous')), project() { throw Error('must not project'); },
      publish() { throw Error('must not publish'); } });
    try { invalidAuthority.observe(chunk(1, 'hidden')); await tick(); } finally { invalidAuthority.close(); }
  } finally { observer.close(); }
});
