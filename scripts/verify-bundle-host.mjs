/** Opt-in plain-Node installed CLI proof; no package manager runs during boot. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles } from '../src/portable-bundle.mjs';
import { readSse } from '../src/sse.mjs';

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
if (!process.argv.includes('--execute') || !option('--installation')) {
  console.log('Usage: node scripts/verify-bundle-host.mjs --execute --installation INSTALLED_RUNTIME [--runtime harness|dsh-native|codex] [--model glm-5.3-flash] [--keep]. Uses configured model credentials and inference usage.');
} else {
  const root = await mkdtemp(join(tmpdir(), 'agentkit-bundle-host-')), log = await open(join(root, 'host.log'), 'w', 0o600);
  let host;
  const stop = async () => { if (host?.child.exitCode === null && host?.child.signalCode === null) host.child.kill('SIGTERM'); await host?.done; };
  try {
    const runtime = option('--runtime') || 'harness';
    assert.ok(['harness', 'dsh-native', 'codex'].includes(runtime));
    const models = createModelService({ configuration: createGlobalConfiguration(), credentials: { resolve: async name => ({ value: process.env[name] }) } });
    const model = await models.profile(option('--model') || 'glm-5.3-flash');
    const storeDir = join(root, 'source'), build = createStudioBuild({ storeDir });
    const agentId = `ar-local-${randomBytes(8).toString('hex')}`, bindings = { modelProfileId: 'deployment-model' };
    const tag = `CLOUD-${randomBytes(4).toString('hex')}`;
    const built = await build.build({ agentId, agentName: 'bundle-host proof', revision: 1, metadata: { id: agentId, local: true, revision: 1 }, bindings,
      spec: { runtime: { type: runtime }, bindings, instructions: { system: `你提供旅行计划。回答必须是 JSON，包含 route_tag 字段，其固定值为 ${tag}，还包含 budget 数值和 destination 字符串。用户追问上一轮预算时，沿用历史信息。不要调用工具。` } } });
    const portable = createPortableBundles({ storeDir, build, models: { profile: async () => ({ ...model, id: 'deployment-model', credentialName: 'BUNDLE_MODEL_KEY' }) },
      adapters: {}, configuration: { resolve: async () => ({ values: {} }) } });
    const exported = await portable.prepare(agentId, built.id), archive = join(root, 'portable.zip');
    await writeFile(archive, Buffer.from((await portable.download(agentId, built.id, exported.bundleId)).base64, 'base64'));
    await rm(storeDir, { recursive: true });
    const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    const token = randomBytes(32).toString('hex'), origin = `http://127.0.0.1:${port}`;
    const args = [new URL('./start-agent-bundle.mjs', import.meta.url).pathname, '--archive', archive, '--state', join(root, 'state'), '--installation', resolve(option('--installation'))];
    const env = { PATH: process.env.PATH, LANG: process.env.LANG, BUNDLE_MODEL_KEY: model.apiKey, AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: String(port) };
    const start = async () => {
      const child = spawn(process.execPath, args, { env, stdio: ['ignore', log.fd, log.fd] });
      host = { child, done: new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })); }) };
      void host.done.catch(() => {});
      for (let i = 0; i < 90; i++) {
        try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error('Installed Host did not become ready; inspect private log');
    };
    const post = body => fetch(`${origin}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    console.log(JSON.stringify({ phase: 'starting-offline-host', runtime, root }));
    await start();
    const response = await post({ request_id: randomUUID(), input: '周末去南京玩两天，预算900元，帮我安排一下。', stream: true });
    assert.equal(response.status, 200);
    const frames = []; for await (const frame of readSse(response.body)) frames.push(frame);
    const completed = frames.find(frame => frame.type === 'response.completed' || frame.event === 'response.completed');
    assert.ok(completed?.output_text.includes(tag), 'system-only marker missing');
    assert.ok(completed.output_text.includes('900'), 'budget missing');
    assert.ok(frames.filter(frame => frame.type === 'response.output_text.delta').length > 1, 'streaming missing');
    await stop(); await start();
    const continued = await post({ previous_response_id: completed.id, input: '刚才说的目的地和预算分别是什么？' });
    assert.equal(continued.status, 200);
    const result = await continued.json();
    assert.ok(result.output_text.includes('900') && result.output_text.includes('南京'), 'history lost on restart');
    const proof = { passed: true, scope: 'compiled-CLI-preinstalled-dependencies-real-model', runtime, model: model.modelName,
      sourceBundleDirectoryRemoved: true, systemPromptVerified: true, hostRestartContinuationVerified: true,
      streamingFrames: frames.filter(frame => frame.type === 'response.output_text.delta').length, root };
    await writeFile(join(root, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 }); console.log(JSON.stringify(proof));
  } catch (error) {
    console.error(JSON.stringify({ passed: false, root, message: error.message })); process.exitCode = 1;
  } finally {
    await stop().catch(() => {}); await log.close();
    if (!process.exitCode && !process.argv.includes('--keep')) await rm(root, { recursive: true, force: true });
  }
}
