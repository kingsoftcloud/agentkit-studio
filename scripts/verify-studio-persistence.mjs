/** Verify persisted Session generations across real Desktop Host restarts and Studio activation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { withAssembledDesktopHost } from './assembled-desktop-host.mjs';
import { fingerprintPatchedSource } from './patched-source-fingerprint.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['source', 'runtime', 'node', 'report'].map(name => [name, { type: 'string' }])) });
for (const name of ['source', 'runtime', 'node', 'report']) assert.ok(values[name], `Specify --${name}`);
const source = resolve(values.source), runtime = resolve(values.runtime), output = resolve(values.report);
const identity = await fingerprintPatchedSource(source);
const { createPluginProfile, readRuntimeProfileBundles } = await import(pathToFileURL(join(source, 'apps/desktop/lib/types/project-manager.js')).href);
const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
const home = await mkdtemp(join(tmpdir(), 'studio-persistence-proof-'));
const dshHome = join(home, 'dsh'), profile = join(dshHome, 'profiles/desktop-agentkit-studio');
const sessions = join(dshHome, 'sessions');
const report = { evidence: 'assembled-desktop-host-real-session-persistence-and-installed-Studio-resource-adapter', source: identity, passed: false, phases: [], diagnosticFiles: [],
  limits: ['The Skill Service is a controlled loopback HTTP backend. The installed Studio resource adapter, resource event producer, Loader and JSONL persistence are real; no real cloud availability or model inference is claimed.',
    'The historical v3 log and unknown-required v4 log are independently authored fixtures created once, rather than rewritten existing logs.',
    'Uses the assembled Desktop Host, not the Electron application shell or installed update.'] };
let restored = false;
const resourceCalls = [];
const resourceId = 'bcb4df65-2448-4c8a-99ca-62a12d26bce9';
const server = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk;
    const call = JSON.parse(text);
    assert.equal(call.action, 'ListSkillsBySpaceId');
    assert.equal(call.params.SpaceId, resourceId);
    resourceCalls.push({ action: call.action, status: restored ? 200 : 404 });
    response.writeHead(restored ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(restored ? { data: { Skills: [] } } : { code: 'NOT_FOUND' }));
  } catch { response.writeHead(500); response.end(); }
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function logFiles() {
  const files = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry.name)) files.set(relative(sessions, path), await readFile(path));
    }
  }
  await visit(sessions); return files;
}
try {
  const resourceOrigin = await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => accept(`http://127.0.0.1:${server.address().port}`));
  });
  createPluginProfile(profile, readRuntimeProfileBundles(runtime));
  const module = join(profile, 'node_modules/studio-persistence-probe');
  await mkdir(module, { recursive: true });
  await save(join(module, 'package.json'), { name: 'studio-persistence-probe', version: '0.0.0', type: 'module', exports: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } });
  await writeFile(join(module, 'index.mjs'), await readFile(new URL('../tests/fixtures/studio-persistence-probe.mjs', import.meta.url)));
  await writeFile(join(module, 'cordis.patch.yml'), '- insert:\n    - id: studio-persistence-probe\n      name: studio-persistence-probe\n');
  const profileManifest = await json(join(profile, 'package.json'));
  profileManifest.dependencies['studio-persistence-probe'] = '0.0.0';
  profileManifest.dsh.profile.bundles.push('studio-persistence-probe');
  await save(join(profile, 'package.json'), profileManifest);
  const rows = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 11, surfaceOp: 'append', data: { id: 'legacy-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'An independently authored old log.' }] } },
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  for (const [id, version, events] of [
    ['studio-legacy-proof', 3, rows],
    ['studio-required-proof', 4, [{ type: 'studio/future-required', seq: 0, time: 1, data: { version: 1 } }]],
  ]) {
    const path = join(sessions, '_no-cwd', id, `session.v${version}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [{ type: 'session', version, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }, ...events].map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  let expected;
  for (const [label, phase, studioEnabled] of [
    ['write-with-missing-resource', 'create', true], ['read-with-Studio-disabled', 'read', false],
    ['read-after-Studio-reenabled', 'read', true], ['resume-after-resource-restored', 'resume', true],
    ['read-restored-history-with-Studio-disabled', 'read', false],
  ]) {
    restored = phase === 'resume' || restored;
    const before = await logFiles();
    const resultPath = join(home, `${label}.json`), input = join(home, 'input.json');
    await save(input, { phase, output: resultPath, studio: join(runtime, 'node_modules/@kingsoftcloud/agentkit-studio'), resourceId, resourceOrigin, expected });
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(sessions)}\n    compression: none\n- id: agentkit-studio\n  disabled: ${!studioEnabled}\n`);
    const diagnostics = join(dirname(output), 'persistence-diagnostics', `${label}-${Date.now()}.log`);
    report.diagnosticFiles.push(diagnostics);
    let proof;
    await withAssembledDesktopHost({ runtime, node: values.node, profile, diagnostics, environment: {
      DSH_HOME: dshHome, AGENTKIT_HOME: join(home, 'agentkit'), DSH_CLIENT_VERSION: manifest.version,
      STUDIO_PERSISTENCE_PROBE_INPUT: input,
    } }, async ({ url }) => {
      const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      assert.equal(login.status, 303);
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), origin = new URL(url).origin;
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'settings/get', payload: {}, rpcId: label }), signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, studioEnabled ? 200 : 405);
      if (studioEnabled) assert.equal((await response.json()).result.ok, true);
            const deadline = Date.now() + 15000;
      for (;;) {
        try { proof = await json(resultPath); break; }
        catch (error) {
          if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
          await new Promise(accept => setTimeout(accept, 25));
        }
      }
      assert.equal(proof.passed, true, 'The persistence fixture must complete successfully');
    });
    const after = await logFiles();
    for (const [name, bytes] of before) {
      assert.ok(after.has(name), 'Existing generation files must remain present');
      if (phase === 'resume' && name.includes('/studio-persistence-proof/')) {
        assert.deepEqual(after.get(name).subarray(0, bytes.length), bytes, 'Resume must preserve every existing byte');
        assert.ok(after.get(name).length > bytes.length, 'Recovery must append the successful resource event');
      } else assert.deepEqual(after.get(name), bytes, 'Reading and plugin activation must not rewrite stored generations');
    }
    expected = proof;
    report.phases.push({ label, studioEnabled, ...proof, acknowledgedShutdown: true,
      storedFiles: Object.fromEntries([...after].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }])) });
  }
  assert.deepEqual(resourceCalls, [{ action: 'ListSkillsBySpaceId', status: 404 }, { action: 'ListSkillsBySpaceId', status: 200 }]);
  assert.deepEqual(await fingerprintPatchedSource(source), identity);
  report.resourceCalls = resourceCalls;
  report.passed = true;
} catch (error) {
  report.failure = { code: error.code || 'PERSISTENCE_ACCEPTANCE_FAILED', message: String(error.message).split('\n')[0].replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]').slice(0, 240) };
  process.exitCode = 1;
} finally {
  await new Promise(accept => server.close(accept));
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(dirname(output), { recursive: true });
  await save(output, report);
}
console.log(JSON.stringify({ passed: report.passed, phases: report.phases.length, failure: report.failure }));
