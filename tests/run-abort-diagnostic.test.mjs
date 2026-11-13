/** A cancelled run must name its aborter, not only its duration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const source = name => readFile(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

test('every run abort site records its source', async () => {
  const text = await source('build-runtime-http.mjs');
  const aborts = [...text.matchAll(/\.abort\(([^)]*)\)/g)].map(match => match[1]);
  assert.ok(aborts.length >= 6, 'the run boundary must keep every abort site');
  for (const argument of aborts) {
    assert.match(argument, /logAbort\(/, `abort(${argument}) must record its source`);
  }
  // The reason handed to the controller is unchanged: diagnostics never alter
  // cancellation semantics.
  assert.match(text, /function logAbort\(source, reason\) \{[\s\S]*?return reason;/);
});

test('the workspace archive path is observed as a distinct stop source', async () => {
  const text = await source('host/bootstrap.mjs');
  assert.match(text, /ctx\.on\('workspace\/session-stop'/);
  assert.match(text, /source: 'workspace\/session-stop'/);
  assert.match(text, /observeSessionStop\(ctx\)/);
});

test('the abort log payload carries the source, code and call site', async () => {
  const text = await source('build-runtime-http.mjs');
  // The helper logs one JSON payload per abort and returns the reason untouched,
  // so a cancelled run names its aborter without changing cancellation semantics.
  const helper = text.slice(text.indexOf('function logAbort('), text.indexOf('const safeDiagnosticCode'));
  for (const field of ['source', 'code', 'status', 'stack']) assert.match(helper, new RegExp(`${field}`));
  assert.match(helper, /return reason;/);
});
