/** Opt-in real bundle acceptance through a fresh Docker container and state volume. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { verifyPortableBundle } from '../src/portable-bundle.mjs';
import { readSse } from '../src/sse.mjs';

const { values } = parseArgs({ options: {
  execute: { type: 'boolean' }, keep: { type: 'boolean' },
  ...Object.fromEntries(['archive', 'env-file', 'cases', 'image', 'platform'].map(key => [key, { type: 'string' }])),
} });
if (!values.execute || !values.archive || !values['env-file'] || !values.cases || !values.image) {
  console.log('Usage: node scripts/verify-container-bundle.mjs --execute --archive BUNDLE.zip --env-file PRIVATE.env --cases CASES.json --image IMAGE [--platform linux/amd64] [--keep]. Runs real model/resource calls.');
} else {
  const root = await mkdtemp(join(tmpdir(), 'studio-container-proof-'));
  const name = `studio-proof-${randomBytes(6).toString('hex')}`, volume = `${name}-state`;
  const token = randomBytes(32).toString('hex'), results = [];
  let containerCreated = false, volumeCreated = false, failed = false;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const secretPath = resolve(values['env-file']), secretInfo = await stat(secretPath);
    assert.ok(secretInfo.isFile() && !(secretInfo.mode & 0o077), 'env file must be owner-only');
    const rawEnv = await readFile(secretPath, 'utf8');
    const envNames = new Set(rawEnv.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.slice(0, line.indexOf('='))));
    const zip = await readFile(resolve(values.archive)), { manifest, definition } = verifyPortableBundle(zip);
    for (const item of manifest.requirements) assert.ok(envNames.has(item.name), `missing env reference: ${item.name}`);
    const cases = JSON.parse(await readFile(resolve(values.cases), 'utf8'));
    assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 20);
    for (const item of cases) {
      assert.ok(typeof item.input === 'string' && item.input.trim() && /^[a-z0-9-]+$/.test(item.id));
      assert.ok((item.delayMs || 0) >= 0 && (item.delayMs || 0) <= 60000);
    }
    // Only the reviewed ZIP is mounted. Source directories and personal configuration stay outside.
    const archive = join(root, 'portable.zip'); await writeFile(archive, zip, { mode: 0o644 });
    const runtimeEnv = join(root, 'runtime.env');
    await writeFile(runtimeEnv, `${rawEnv.trim()}\nAGENTKIT_RUNTIME_TOKEN=${token}\nAGENTKIT_BUNDLE_SHA256=${createHash('sha256').update(zip).digest('hex')}\n`, { mode: 0o600 });
    const imageId = docker(['image', 'inspect', values.image, '--format', '{{.Id}}']);
    docker(['volume', 'create', '--label', 'io.agentkit.purpose=acceptance', volume]); volumeCreated = true;
    docker(['create', '--pull', 'never', '--name', name, '--platform', values.platform || 'linux/amd64',
      '--mount', `type=bind,src=${archive},dst=/app/code/portable.zip,readonly`,
      '--mount', `type=volume,src=${volume},dst=/var/lib/agentkit`, '--env-file', runtimeEnv,
      '-p', '127.0.0.1::8080', imageId]); containerCreated = true;
    // Docker has consumed the file; do not retain an additional secret copy with proof logs.
    await rm(runtimeEnv);
    docker(['start', name]);
    let origin;
    async function ready() {
      // Docker may assign a new ephemeral published port after a restart.
      const port = docker(['port', name, '8080/tcp']).split(':').at(-1);
      origin = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 90; i++) {
        try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
        if (docker(['inspect', name, '--format', '{{.State.Running}}']) !== 'true') break;
        await new Promise(r => setTimeout(r, 1000));
      }
      throw Error('container Host did not become ready; inspect private host.log');
    }
    await ready();
    for (const item of cases) {
      console.log(JSON.stringify({ phase: 'case-start', case: item.id, runtime: definition.spec.runtime.type }));
      if (item.restart) { docker(['restart', '--time', '20', name]); await ready(); }
      if (item.delayMs) await new Promise(r => setTimeout(r, item.delayMs));
      const started = Date.now(), frames = [];
      let firstTextMs;
      try {
        const previous = item.continueFrom && results.find(result => result.id === item.continueFrom)?.responseId;
        if (item.continueFrom) assert.ok(previous, 'missing successful prior response');
        const response = await fetch(`${origin}/v1/responses`, { method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: item.input, request_id: randomUUID(), stream: true, ...(previous ? { previous_response_id: previous } : {}) }),
          signal: AbortSignal.timeout(180000) });
        assert.equal(response.status, 200);
        for await (const frame of readSse(response.body)) {
          frames.push(frame);
          if (firstTextMs === undefined && frame.type === 'response.output_text.delta') firstTextMs = Date.now() - started;
        }
        await writeFile(join(root, `${item.id}.json`), JSON.stringify(frames, null, 2), { mode: 0o600 });
        const completed = frames.find(frame => frame.type === 'response.completed');
        assert.ok(completed, `successful completion missing: ${frames.find(frame => frame.type === 'response.failed')?.error?.code || 'unknown'}`);
        const calls = completed.output.filter(output => output.type === 'function_call');
        const toolNames = calls.map(call => call.name);
        for (const expected of item.expectedText || []) assert.ok(completed.output_text.includes(expected), `expected output missing: ${expected}`);
        const streamedText = frames.filter(frame => frame.type === 'response.output_text.delta').map(frame => frame.delta || '').join('');
        if (item.expectedStreamPrefix) assert.ok(streamedText.startsWith(item.expectedStreamPrefix), 'expected answer prefix missing from text stream');
        for (const pattern of item.expectedTools || []) assert.ok(toolNames.some(tool => new RegExp(pattern).test(tool)), `tool missing: ${pattern}`);
        const matchingCalls = calls.filter(call => !item.expectedToolArguments || String(call.arguments).includes(item.expectedToolArguments));
        if (item.expectedToolArguments) assert.ok(matchingCalls.length, 'expected executed tool arguments missing');
        if (item.expectedToolResult) assert.ok(frames.some(frame => frame.type === 'response.tool_result' && !frame.is_error && matchingCalls.some(call => call.call_id === frame.call_id) && frame.output.some(part => String(part.text || '').includes(item.expectedToolResult))), 'expected successful tool result missing');
        const textFrames = frames.filter(frame => frame.type === 'response.output_text.delta').length;
        assert.ok(textFrames > 1, 'incremental text stream missing');
        results.push({ id: item.id, passed: true, responseId: completed.id, toolNames, textFrames, firstTextMs,
          milliseconds: Date.now() - started, usage: completed.usage, restarted: Boolean(item.restart) });
      } catch (error) {
        failed = true;
        await writeFile(join(root, `${item.id}.json`), JSON.stringify(frames, null, 2), { mode: 0o600 });
        results.push({ id: item.id, passed: false, message: error.message, milliseconds: Date.now() - started });
      }
      console.log(JSON.stringify(results.at(-1)));
    }
    const proof = { passed: !failed, scope: 'Linux-container-real-model-and-bound-resources', imageId,
      runtime: definition.spec.runtime.type, agentId: manifest.agentId, buildId: manifest.buildId, bundleId: manifest.bundleId, results };
    await writeFile(join(root, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ passed: !failed, root }));
  } catch (error) {
    failed = true;
    // Docker errors can include service diagnostics; preserve them privately instead of printing env values.
    console.error(JSON.stringify({ passed: false, root, message: error instanceof assert.AssertionError ? error.message : 'Inspect private host.log and invocation inputs' }));
  } finally {
    if (containerCreated) {
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10000 });
      await writeFile(join(root, 'host.log'), (logs.stdout || '') + (logs.stderr || ''), { mode: 0o600 });
      docker(['rm', '-f', name]);
    }
    if (volumeCreated) docker(['volume', 'rm', volume]);
    await rm(join(root, 'runtime.env'), { force: true });
    if (!failed && !values.keep) await rm(root, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
  }
}
