import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDesktopTelemetry, resolveDesktopTelemetryConfig } from '../src/telemetry/desktop.mjs';
import { validEventProps } from '../src/telemetry/contract.mjs';
import { stageDesktopTelemetryInputs } from '../scripts/desktop-telemetry-inputs.mjs';

const endpoint = 'https://telemetry.example.test/v1/logs';
const release = { endpoint, defaultBasic: true, policyRevision: 'test-1' };
const dimensions = { app_version: '0.0.18', channel: 'nightly', platform: 'darwin', arch: 'arm64' };
const ack = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
const logRecords = body => JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords;
const eventNames = body => logRecords(body).map(record => record.body.stringValue);

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-telemetry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetches = [];
  let now = Date.parse('2026-11-19T15:59:00Z');
  const options = { directory, dimensions, config: resolveDesktopTelemetryConfig({ release, packaged: false }),
    now: () => now, random: () => 0, batchDelay: 120_000,
    fetchImpl: async (url, request) => { fetches.push({ url, request }); return ack(); },
    ...overrides };
  return { directory, options, fetches, advance: ms => { now += ms; }, telemetry: await createDesktopTelemetry(options) };
}

test('release defaults require a packaged first-party receiver and policy revision', () => {
  assert.equal(resolveDesktopTelemetryConfig({ release, packaged: true }).defaultEnabled, true);
  assert.equal(resolveDesktopTelemetryConfig({ release, packaged: false }).defaultEnabled, false);
  assert.equal(resolveDesktopTelemetryConfig({ release, packaged: true, selfHosted: endpoint }).defaultEnabled, false);
  assert.equal(resolveDesktopTelemetryConfig({ release: { endpoint }, packaged: true }).defaultEnabled, false);
  assert.equal(resolveDesktopTelemetryConfig({ release, packaged: true, disabled: '0' }).disabled, true);
  assert.equal(resolveDesktopTelemetryConfig({ release, selfHosted: 'https://user:pass@example.test/v1/logs' }).endpoint, null);
});

test('the workflow policy is validated and written as a package resource', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-telemetry-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inline = JSON.stringify(release);
  const staged = await stageDesktopTelemetryInputs(directory, { AGENTKIT_TELEMETRY_RELEASE_POLICY: inline });
  assert.deepEqual(JSON.parse(await readFile(join(staged.directory, 'policy.json'), 'utf8')), release);
  await staged.dispose();
  await assert.rejects(stageDesktopTelemetryInputs(directory, {
    AGENTKIT_TELEMETRY_RELEASE_POLICY: JSON.stringify({ ...release, endpoint: 'http://telemetry.example.test/v1/logs' }),
  }), /Invalid desktop telemetry release policy/);
  await assert.rejects(stageDesktopTelemetryInputs(directory, {
    AGENTKIT_TELEMETRY_RELEASE_POLICY: inline, AGENTKIT_TELEMETRY_RELEASE_FILE: 'second-policy.json',
  }), /Use one desktop telemetry release policy input/);
});

test('development requires opt-in and sends one active event per Beijing day', async t => {
  const { telemetry, options, directory, fetches, advance } = await fixture(t);
  telemetry.beginLaunch();
  telemetry.activity();
  await telemetry.flush();
  assert.equal(fetches.length, 0);
  await assert.rejects(access(join(directory, 'outbox.jsonl')));
  await telemetry.setPreference('basic', true);
  assert.deepEqual(telemetry.status().enabled, { basic: true, crash: false, run: false });
  telemetry.activity();
  telemetry.activity();
  telemetry.track('app_crash', { source: 'main', phase: 'startup', error_code: 'OTHER' });
  await telemetry.writes;
  const expected = telemetry.preview();
  assert.deepEqual(eventNames(expected), ['app_install', 'desktop_active_day']);
  await telemetry.flush();
  assert.equal(fetches[0].request.body, expected);
  assert.equal(fetches[0].request.credentials, 'omit');
  assert.deepEqual(Object.keys(fetches[0].request.headers), ['content-type']);
  await telemetry.drain();
  const restarted = await createDesktopTelemetry(options);
  restarted.activity();
  assert.equal(restarted.status().queued, 0);
  advance(120_000);
  restarted.activity();
  assert.deepEqual(eventNames(restarted.preview()), ['desktop_active_day']);
  assert.equal(restarted.status().installId, telemetry.status().installId);
  await restarted.drain();
});

test('a new official installation defaults every category on and preserves per-category opt-outs', async t => {
  const config = resolveDesktopTelemetryConfig({ release: { ...release, defaultBasic: false }, packaged: true });
  const { telemetry, options } = await fixture(t, { config });
  assert.deepEqual(telemetry.status().enabled, { basic: true, crash: true, run: true });
  telemetry.activity();
  assert.deepEqual(eventNames(telemetry.preview()), ['app_install', 'desktop_active_day']);
  await telemetry.setPreference('crash', false);
  await telemetry.drain();
  const restarted = await createDesktopTelemetry(options);
  assert.deepEqual(restarted.status().enabled, { basic: true, crash: false, run: true });
  await restarted.drain();
});

test('new release defaults preserve an older journal and fail closed on an unreadable journal', async t => {
  const config = resolveDesktopTelemetryConfig({ release, packaged: true });
  const { telemetry, options, directory, fetches } = await fixture(t, { config: { ...config, defaultEnabled: false } });
  await telemetry.setPreference('basic', true);
  await telemetry.drain();
  const upgraded = await createDesktopTelemetry({ ...options, config });
  assert.deepEqual(upgraded.status().enabled, { basic: true, crash: false, run: false });
  await upgraded.drain();
  await writeFile(join(directory, 'outbox.jsonl'), 'invalid journal\n');
  const unreadable = await createDesktopTelemetry({ ...options, config });
  assert.deepEqual(unreadable.status().enabled, { basic: false, crash: false, run: false });
  assert.equal(unreadable.status().installId, null);
  assert.equal(fetches.length, 0);
  await unreadable.drain();
});

test('the fixed sample is local and independent of policy, queue and installation identity', async t => {
  const { telemetry, directory, fetches } = await fixture(t, {
    config: resolveDesktopTelemetryConfig({ release: {}, packaged: true }),
  });
  const example = telemetry.preview('example');
  assert.deepEqual(eventNames(example), ['desktop_active_day']);
  assert.equal(telemetry.preview('example'), example);
  assert.deepEqual(eventNames(telemetry.preview('queued')), []);
  assert.equal(telemetry.status().installId, null);
  assert.equal(fetches.length, 0);
  await assert.rejects(access(join(directory, 'outbox.jsonl')));
});

test('address or policy changes drop queued data and require fresh opt-in', async t => {
  const { telemetry, options, directory, fetches } = await fixture(t);
  await telemetry.setPreference('basic', true);
  telemetry.activity();
  await telemetry.setPreference('crash', false);
  const next = await createDesktopTelemetry({
    ...options,
    config: resolveDesktopTelemetryConfig({ release: { ...release, policyRevision: 'test-2' }, packaged: false }),
  });
  assert.deepEqual(next.status().enabled, { basic: false, crash: false, run: false });
  assert.deepEqual(eventNames(next.preview()), []);
  assert.equal(fetches.length, 0);
  assert.equal(next.status().noticePending, true);
  assert.equal(JSON.parse((await readFile(join(directory, 'outbox.jsonl'), 'utf8')).split('\n')[0]).choices.crash, false);
  assert.equal((await readFile(join(directory, 'outbox.jsonl'), 'utf8')).trim().split('\n').length, 1);
  await next.drain();
});

test('stop aborts in-flight request and disk restart cannot replay it', async t => {
  let signal;
  const { telemetry, options } = await fixture(t, { fetchImpl: async (_, request) => {
    signal = request.signal;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new DOMException('Aborted', 'AbortError');
  } });
  await telemetry.setPreference('basic', true);
  telemetry.activity();
  await telemetry.writes;
  const inFlight = telemetry.flush();
  assert.equal(signal.aborted, false);
  await telemetry.stopAll();
  assert.equal(signal.aborted, true);
  await inFlight;
  const restarted = await createDesktopTelemetry(options);
  assert.deepEqual(restarted.status().enabled, { basic: false, crash: false, run: false });
  assert.equal(restarted.status().queued, 0);
  await restarted.drain();
});

test('retry after 429 keeps event IDs immutable through a persisted replay', async t => {
  const requests = [];
  const { telemetry, options, advance } = await fixture(t, { fetchImpl: async (_, request) => {
    requests.push(request.body);
    return requests.length === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '20' } }) : ack();
  } });
  await telemetry.setPreference('basic', true);
  telemetry.activity();
  await telemetry.writes;
  await telemetry.flush();
  assert.equal(telemetry.status().queued, 2);
  assert.equal(telemetry.status().diagnostics.send_failed, 1);
  advance(19_999);
  await telemetry.flush();
  assert.equal(requests.length, 1);
  await telemetry.drain();
  advance(1);
  const restarted = await createDesktopTelemetry(options);
  await restarted.flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.equal(restarted.status().queued, 0);
  await restarted.drain();
});

test('expired records increment local drops and clearing data resets diagnostic counts', async t => {
  const { telemetry, advance, fetches } = await fixture(t);
  await telemetry.setPreference('basic', true);
  telemetry.activity();
  await telemetry.writes;
  advance(8 * 24 * 60 * 60 * 1000);
  await telemetry.flush();
  await telemetry.writes;
  assert.equal(telemetry.status().diagnostics.queue_drop, 2);
  assert.equal(telemetry.status().queued, 0);
  assert.equal(fetches.length, 0);
  assert.equal((await telemetry.stopAll({ clear: true })).diagnostics.queue_drop, 0);
  await telemetry.drain();
});

test('Run summaries require own opt-in, an admitted start, and terminal schema', async t => {
  const { telemetry } = await fixture(t);
  const run = { id: 'local-run-only', engine: 'native-harness' };
  const props = { engine: run.engine, status: 'completed', input_tokens: 2, output_tokens: 3, total_tokens: 5 };
  telemetry.localRun({ ...run, kind: 'start' });
  await telemetry.setPreference('run', true);
  assert.deepEqual(telemetry.status().enabled, { basic: false, crash: false, run: true });
  telemetry.localRun({ ...run, kind: 'finish', props });
  assert.equal(telemetry.status().queued, 0);
  telemetry.localRun({ ...run, kind: 'start' });
  telemetry.localRun({ ...run, kind: 'finish', props });
  telemetry.localRun({ ...run, kind: 'start' });
  telemetry.localRun({ ...run, kind: 'finish', props });
  assert.deepEqual(eventNames(telemetry.preview()), ['run_summary']);
  assert.doesNotMatch(telemetry.preview(), /local-run-only/);
  assert.equal(validEventProps('run_summary', { ...props, total_tokens: 6 }), false);
  assert.equal(validEventProps('run_summary', { ...props, error_message: 'sensitive' }), false);
  assert.equal(validEventProps('update_check_result', { outcome: 'failed', error_code: 'OTHER' }), false);
  await telemetry.drain();
});

test('ordinary time-driven batching does not send an idle heartbeat', async t => {
  const { telemetry, fetches } = await fixture(t, { now: Date.now, batchDelay: 30 });
  await telemetry.setPreference('basic', true);
  await sleep(45);
  assert.equal(fetches.length, 0);
  telemetry.activity();
  await telemetry.writes;
  for (let attempt = 0; attempt < 25 && fetches.length === 0; attempt += 1) await sleep(10);
  assert.equal(fetches.length, 1);
  await telemetry.drain();
});
