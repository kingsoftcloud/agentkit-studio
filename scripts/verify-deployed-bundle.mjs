/** Explicit opt-in real HTTPS acceptance; never creates, updates, or deletes cloud Agents. */
import assert from 'node:assert/strict';
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { verifyPortableBundle } from '../src/portable-bundle.mjs';
import { readSse } from '../src/sse.mjs';
import { validateDeploymentCases, verifyDeploymentCase } from './deployed-runtime-proof.mjs';

const { values } = parseArgs({ options: { execute: { type: 'boolean' },
  ...Object.fromEntries(['archive', 'endpoint', 'token-file', 'cases', 'output'].map(name => [name, { type: 'string' }])) } });
if (!values.execute || !['archive', 'endpoint', 'token-file', 'cases', 'output'].every(name => values[name])) {
  console.log('Usage: node scripts/verify-deployed-bundle.mjs --execute --archive BUNDLE.zip --endpoint HTTPS_ORIGIN --token-file PRIVATE_TOKEN --cases CASES.json --output NEW_PRIVATE_DIRECTORY');
  process.exitCode = 2;
} else {
  let root;
  try {
    const endpoint = new URL(values.endpoint);
    assert(endpoint.protocol === 'https:' && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password);
    const tokenPath = resolve(values['token-file']), info = await lstat(tokenPath);
    assert(info.isFile() && !(info.mode & 0o077));
    const token = (await readFile(tokenPath, 'utf8')).trim();
    assert(token.length >= 24 && !/[\r\n\0]/.test(token));
    const { manifest, definition } = verifyPortableBundle(await readFile(resolve(values.archive)));
    const cases = JSON.parse(await readFile(resolve(values.cases), 'utf8'));
    validateDeploymentCases(cases, manifest, definition);
    root = resolve(values.output);
    await mkdir(root, { mode: 0o700 }); // Refuse an existing output directory and preserve prior evidence.
    const save = (name, data) => writeFile(join(root, name), JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    const responseURL = new URL('/v1/responses', endpoint), results = [];
    const noAuth = await fetch(responseURL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '你好', stream: true }), redirect: 'error', signal: AbortSignal.timeout(20000) });
    await noAuth.body?.cancel();
    assert([401, 403].includes(noAuth.status));
    for (const item of cases) {
      const requestId = randomUUID(), frames = [], started = Date.now();
      let firstTextMs, status, bytes = 0, result;
      await save(`${item.id}-intent.json`, { requestId, agentId: manifest.agentId, buildId: manifest.buildId, startedAt: new Date().toISOString() });
      console.log(JSON.stringify({ phase: 'case-start', case: item.id, runtime: definition.spec.runtime.type }));
      try {
        const response = await fetch(responseURL, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ input: item.input, request_id: requestId, stream: true }), redirect: 'error', signal: AbortSignal.timeout(180000) });
        status = response.status;
        if (status !== 200) { await response.body?.cancel(); throw Object.assign(Error('HTTP failure'), { code: 'PROBE_HTTP_FAILED' }); }
        for await (const frame of readSse(response.body)) {
          bytes += Buffer.byteLength(JSON.stringify(frame));
          if (bytes > 16 * 1024 * 1024 || frames.length >= 50000) throw Object.assign(Error('Stream exceeded evidence limit'), { code: 'PROBE_STREAM_LIMIT' });
          frames.push(frame);
          if (firstTextMs === undefined && frame.type === 'response.output_text.delta') firstTextMs = Date.now() - started;
        }
        result = { id: item.id, requestId, ...verifyDeploymentCase(frames, item, manifest), firstTextMs, milliseconds: Date.now() - started };
      } catch (error) {
        result = { id: item.id, requestId, passed: false, status,
          code: /^PROBE_[A-Z_]+$/.test(error.code || '') ? error.code : 'PROBE_REQUEST_FAILED', milliseconds: Date.now() - started };
      } finally { await save(`${item.id}-frames.json`, frames); }
      results.push(result); await save(`${item.id}-proof.json`, result); console.log(JSON.stringify(result));
    }
    const passed = results.every(result => result.passed);
    await save('proof.json', { passed, scope: 'deployed-HTTPS-real-runtime', runtime: definition.spec.runtime.type,
      agentId: manifest.agentId, buildId: manifest.buildId, bundleId: manifest.bundleId, unauthorizedStatus: noAuth.status, results });
    if (!passed) process.exitCode = 1;
  } catch (error) {
    // Never print raw network errors, response bodies, credential paths, or tokens.
    console.error(JSON.stringify({ passed: false, code: /^PROBE_[A-Z_]+$/.test(error.code || '') ? error.code : 'PROBE_SETUP_FAILED' })); process.exitCode = 1;
  }
}
