import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' } } });
assert.ok(values.source, 'Use --source <built maintained DSH checkout>');
const source = resolve(values.source), root = await mkdtemp(join(tmpdir(), 'native-approval-sdk-'));
const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
const patch = join(root, 'approval.patch.yml');
await writeFile(patch, ['- id: session-persistence-jsonl', "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
  '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
  '- insert:', '    - id: native-durable-approval-sdk-verification',
  `      name: ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../tests/fixtures/native-durable-approval-sdk.mjs', import.meta.url))).href)}`,
  '      config:', `        directory: ${JSON.stringify(root)}`, ''].join('\n'));
const harness = new DeepSeekHarness({ dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk', patches: [patch],
  dshHome: join(root, 'home'), cwd: root, processCwd: root, provider: 'native-approval-fixture', model: 'controlled',
  initializeTimeoutMs: 30_000, requestTimeoutMs: 30_000,
  env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } });
try {
  const session = harness.session('native-durable-approval-sdk');
  for (const mode of ['allowed', 'rejected', 'guard-denied', 'post-blocked']) {
    const result = await session.run(mode);
    assert.equal(result.finalResponse, `${mode} settled`);
    const record = JSON.parse(await readFile(join(root, mode + '.json'), 'utf8'));
    assert.equal(record.phase, 'completed');
    assert.equal(record.results.some(row => row.status === 'uncertain'), false);
    assert.equal(record.dispatches, mode === 'allowed' ? 1 : 0);
    assert.equal(record.asks, mode === 'post-blocked' ? 0 : 1);
    const toolResults = record.results.flatMap(row => row.results);
    assert.equal(toolResults.filter(row => row.status === 'approval_required').length, mode === 'post-blocked' ? 0 : 1);
    assert.equal(toolResults.at(-1).status, mode === 'allowed' ? 'ok' : 'error');
    if (mode === 'allowed') assert.equal(await readFile(join(root, mode + '.txt'), 'utf8'), 'Actual write: allowed');
    else await assert.rejects(readFile(join(root, mode + '.txt')), { code: 'ENOENT' });
  }
  const observations = (await readFile(join(root, 'observations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(observations.find(row => row.mode === 'allowed').elapsedMs >= 1500);
  assert.ok(observations.every(row => row.lease === null && row.dispatches === 0 && row.guards === 0));
  // A terminal safe-read failure closes the real external-turn owner as an
  // error. The next explicit input must execute, not remain queued forever.
  try { await session.run('read-interrupted'); } catch { /* SDK versions may reject an error ending. Inspect the committed record below. */ }
  const readFailure = JSON.parse(await readFile(join(root, 'read-interrupted.json'), 'utf8'));
  assert.equal(readFailure.phase, 'interrupted');
  assert.equal(readFailure.results.at(-1).results[0].status, 'uncertain');
  const next = await session.run('after-read');
  assert.equal(next.finalResponse, 'after-read settled');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'read-interrupted.json'), 'utf8')), readFailure);
  const logs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'));
  const stored = (await Promise.all(logs.map(path => readFile(join(root, 'sessions', path), 'utf8'))))
    .flatMap(text => text.trim().split('\n').map(JSON.parse));
  const unknown = stored.filter(event => event.type === 'tool/result' && event.data.meta?.nativeOutcome?.status === 'uncertain');
  assert.equal(unknown.length, 1, 'The actual SDK persists the typed unknown result');
  assert.equal(unknown[0].data.meta.nativeOutcome.callId, unknown[0].data.message.toolCallId);
  assert.equal(unknown[0].data.meta.nativeOutcome.sessionId, 'native-durable-approval-sdk');
  for (const mode of ['command-preview', 'command-redacted']) {
    const result = await harness.session('native-' + mode + '-sdk').run(mode);
    assert.equal(result.finalResponse, `${mode} settled`);
    const record = JSON.parse(await readFile(join(root, mode + '.json'), 'utf8'));
    assert.equal(record.phase, 'completed'); assert.ok(record.previews.length > 0);
    assert.ok(record.previews.every(view => !view.hasReceipt));
    assert.equal(JSON.stringify(record.previews).includes('PRIVATE'), false);
    assert.equal(record.previews.at(-1).calls[0].display.stdout, '[hidden]\ndone\n');
    const output = record.results.flatMap(row => row.results).find(row => row.content.stdout);
    assert.equal(output.status, 'ok'); assert.equal(output.content.stdout, 'PRIVATE\ndone\n'); assert.equal(output.content.exit_code, 0);
    if (mode === 'command-redacted') assert.equal(output.context.content.includes('PRIVATE'), false);
  }
  console.log(`Native SDK passed: durable approval, terminal read continuation, live operator command previews and independent final model-result redaction. Evidence: ${root}`);
} catch (error) { console.error(`SDK evidence retained at ${root}`); throw error; }
finally { await harness.close(); }
