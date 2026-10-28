import { createRequire } from 'node:module';
/**
 * Verify Studio Native Vision through the packed production Host, real DSH SDK
 * preset/ToolRegistry/SessionController (full mounted host with authenticated
 * HTTP control RPC and production preset admission), NativeKernel/SQLite, real
 * Chromium browser, and deterministic local model HTTP SSE for both the primary
 * text model and the vision observer model.
 *
 * Usage:
 *   node scripts/verify-studio-native-vision.mjs \
 *     --source <built DSH SDK checkout> \
 *     --archive <packed studio .tgz> \
 *     --chromium <path to Chromium/Chrome executable>
 *
 * The mounted Host wires the ledger-owned vision binding for an Agent spec with:
 *   bindings.modelProfileIds = ['fixture']       (text-only primary, modelName 'main')
 *   bindings.visionModelProfileId = 'observer'   (image-capable observer)
 *   runtime.type = 'harness'
 * The workspace has a real HTML page. The browser tool screenshots it via real
 * Chromium. The observer model receives the data:image and returns a fixed
 * untrusted caption. The primary model receives the text-only caption (no image
 * media) and completes.
 *
 * Verifies (exact, not >=):
 *   - Exactly 1 completed Run in SQLite
 *   - Exactly 2 primary + 1 observer HTTP model calls (total 3)
 *   - snapshot.usage.modelCalls === 2, descendantUsage.modelCalls === 1
 *   - Exactly one tool result with resourceUsage.modelCalls === 1 (the vision
 *     caption); resourceUsageReported === true; untrusted caption + original
 *     browser facts (browser_channel, browser_action_seq, body_text_preview)
 *     preserved; no image media in the tool result context
 *   - Observer request carries the screenshot image; primary second request none
 *   - Cold-before count snapshot saved, then a REAL Host/SDK process restart
 *     (close DSH subprocess, spawn fresh with same config, resumeSession via
 *     real SessionController/SDK history read — no new prompt). Model/tool/
 *     browser-action counts must NOT increase (real comparison).
 *   - Entire store.load record canonical (not just snapshot) unchanged after
 *     the real restart + history replay
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    archive: { type: 'string' },
    chromium: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});

assert.ok(values.source, 'Use --source <built DSH SDK checkout>');
assert.ok(values.archive, 'Use --archive <packed studio .tgz>');
assert.ok(values.chromium, 'Use --chromium <Chromium executable path>');

const source = resolve(values.source);
const archive = resolve(values.archive);
const chromium = resolve(values.chromium);
const repository = fileURLToPath(new URL('..', import.meta.url));
const sdkCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

// Record the exact production archive under test.
const archiveBuf = await readFile(archive);
const archiveSha = createHash('sha256').update(archiveBuf).digest('hex');
console.log(`Archive: ${archive}`);
console.log(`Archive SHA256: ${archiveSha}`);

const root = await mkdtemp(join(tmpdir(), 'studio-native-vision-'));
console.log(`Vision proof root: ${root}`);

// Track HTTP model calls for counting and request inspection.
let mainCalls = 0, observerCalls = 0;
const mainRequests = [], observerRequests = [];

// Deterministic local model HTTP server. Routes by body.model: 'main' for the
// primary text model, 'observer' for the vision captioning model.
const server = createHttpServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);

    if (body.model === 'main') {
      mainCalls++;
      mainRequests.push(body);
      console.log(`[main] call ${mainCalls}: ${body.messages.length} messages, tools=${body.tools?.length || 0}`);

      // First call: emit a tool call to browser_inspect_workspace.
      if (mainCalls === 1) {
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        const toolCallChunk = {
          id: 'main-1', model: 'main',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'browser-call-1', type: 'function',
            function: { name: 'browser_inspect_workspace',
              arguments: JSON.stringify({ path: 'app', wait_ms: 0 }) } }] }, finish_reason: null }],
        };
        response.write('data: ' + JSON.stringify(toolCallChunk) + '\n\n');
        const toolCallEnd = {
          id: 'main-1', model: 'main',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
        response.end('data: ' + JSON.stringify(toolCallEnd) + '\n\ndata: [DONE]\n\n');
        return;
      }

      // Second call: primary model receives the tool result (text-only caption,
      // no image media) and completes. Verify the tool result has no image.
      const toolMsg = body.messages.find(m => m.role === 'tool');
      if (toolMsg) {
        const toolJson = JSON.stringify(toolMsg);
        assert.equal(toolJson.includes('data:image/'), false,
          'primary model tool result must not carry image media');
        console.log(`[main] tool result (first 160): ${String(toolMsg.content).slice(0, 160)}`);
      }

      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const answerChunk = {
        id: 'main-2', model: 'main',
        choices: [{ index: 0, delta: { content: 'I can see a login form on the page.' }, finish_reason: null }],
      };
      response.write('data: ' + JSON.stringify(answerChunk) + '\n\n');
      const answerEnd = {
        id: 'main-2', model: 'main',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      };
      response.end('data: ' + JSON.stringify(answerEnd) + '\n\ndata: [DONE]\n\n');
      return;
    }

    if (body.model === 'observer') {
      observerCalls++;
      observerRequests.push(body);
      console.log(`[observer] call ${observerCalls}: ${body.messages.length} messages`);

      // Verify the observer received an image in the messages.
      const hasImage = JSON.stringify(body.messages).includes('data:image/');
      console.log(`[observer] has image: ${hasImage}`);
      assert.ok(hasImage, 'observer model received image data');

      // Return a fixed untrusted caption.
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const captionChunk = {
        id: 'observer-1', model: 'observer',
        choices: [{ index: 0, delta: { content: 'A login form with username and password fields and a submit button.' }, finish_reason: null }],
      };
      response.write('data: ' + JSON.stringify(captionChunk) + '\n\n');
      const captionEnd = {
        id: 'observer-1', model: 'observer',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 15 },
      };
      response.end('data: ' + JSON.stringify(captionEnd) + '\n\ndata: [DONE]\n\n');
      return;
    }

    throw new Error(`Unexpected model: ${body.model}`);
  } catch (error) {
    console.error('Model server error:', error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end('verification failed');
  }
});

let harness, failed = false;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const modelPort = server.address().port;
  const modelUrl = `http://127.0.0.1:${modelPort}/v1`;
  console.log(`Model server: ${modelUrl}`);

  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph);
  execFileSync('tar', ['-xzf', archive, '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });

  // The new fixture is not yet in the packed archive; copy it into the extracted
  // package so its ../../src imports resolve to the packed production source and
  // its @kingsoftcloud/agentkit-studio import resolves to the packed Host.
  await mkdir(join(installed, 'tests/fixtures'), { recursive: true });
  await copyFile(join(repository, 'tests/fixtures/studio-native-vision.mjs'),
    join(installed, 'tests/fixtures/studio-native-vision.mjs'));

  // Symlink the SDK's built @deepseek-ai packages into the host graph.
  const dshDeps = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const entry of await readdir(dshDeps)) {
    try { await symlink(join(dshDeps, entry), join(dependencies, '@deepseek-ai', entry)); } catch { /* exists */ }
  }
  // The idle SDK snapshot omits three mounted-host plugin packages from its
  // apps/cli hoist; their built lib/ exists under packages/. Symlink them from
  // source so the mounted host resolves dsh-client-connection,
  // dsh-api-session-controller and dsh-agent-preset-registry. The pnpm
  // workspace keeps each package's own @deepseek-ai deps resolvable.
  const missingFromSource = [
    ['packages/client/connection', 'dsh-client-connection'],
    ['packages/api/session-controller', 'dsh-api-session-controller'],
    ['packages/preset/agent-preset-registry', 'dsh-agent-preset-registry'],
  ];
  for (const [rel, pkgName] of missingFromSource) {
    try { await symlink(join(source, rel), join(dependencies, '@deepseek-ai', pkgName)); } catch { /* exists */ }
  }

  // Symlink ordinary Studio dependencies from this checkout's node_modules.
  for (const entry of await readdir(join(repository, 'node_modules'))) {
    if (entry === '@deepseek-ai' || entry.startsWith('.')) continue;
    try { await symlink(join(repository, 'node_modules', entry), join(dependencies, entry)); } catch { /* exists */ }
  }

  // Node-only PATH so the host spawns no Python.
  const nodeOnlyBin = join(root, 'node-only-bin');
  await mkdir(nodeOnlyBin);
  await symlink(process.execPath, join(nodeOnlyBin, 'node'));

  // Profile packages for the mounted host: the packed Studio is the
  // @kingsoftcloud/agentkit-studio the host bootstrap imports.
  const profilePackages = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
  await mkdir(profilePackages, { recursive: true });
  await symlink(installed, join(profilePackages, 'agentkit-studio'));

  // DSH patch YAML to mount the vision fixture with the full mounted-host
  // plugin chain (webserver + connection + model-selection-settings +
  // preset-registry with the production 'standard' default).
  const patch = join(root, 'vision.patch.yml');
  const fixturePath = pathToFileURL(join(installed, 'tests/fixtures/studio-native-vision.mjs')).href;
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:',
    '    - id: studio-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:',
    "        host: '127.0.0.1'", '        port: 0',
    '    - id: studio-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: studio-proof-model-selection-settings', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: studio-proof-preset-registry', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:',
    "        default: standard",
    '    - id: studio-native-vision-proof', `      name: ${JSON.stringify(fixturePath)}`, '      config:',
    `        directory: ${JSON.stringify(root)}`,
    `        repository: ${JSON.stringify(installed)}`,
    `        modelUrl: ${JSON.stringify(modelUrl)}`,
    `        chromium: ${JSON.stringify(chromium)}`,
    `        mountHost: true`,
    '',
  ].join('\n'));

  const patches = [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch];
  const options = {
    dshBin: join(source, 'apps/cli/lib/bin.js'),
    profile: 'sdk',
    patches,
    dshHome: join(root, 'home'),
    cwd: root,
    processCwd: root,
    provider: 'agentkit-studio-fixture',
    model: 'main',
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    env: {
      ...process.env,
      PATH: nodeOnlyBin,
      AGENTKIT_PYTHON: '/unavailable/python',
      AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      AGENTKIT_KSADK_PYTHON: '/unavailable/python',
      AGENTKIT_KSADK_ROOT: '/unavailable/ksadk',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_STUDIO_NATIVE_CHROMIUM_EXECUTABLE: chromium,
    },
  };

  harness = new DeepSeekHarness(options);
  const session = harness.session('vision-session');
  const result = await session.run('Open the page and describe what you see.');
  assert.equal(result.finalResponse, 'I can see a login form on the page.');
  console.log(`\nTurn finalResponse: ${result.finalResponse}`);
  console.log(`HTTP calls: main=${mainCalls}, observer=${observerCalls}`);

  // Verify HTTP call counts.
  assert.equal(mainCalls, 2, `primary model HTTP calls: expected exactly 2, got ${mainCalls}`);
  assert.equal(observerCalls, 1, `observer model HTTP calls: expected exactly 1, got ${observerCalls}`);
  assert.equal(mainCalls + observerCalls, 3, 'total HTTP model calls: expected 3');

  // The primary's second request (after the tool result) must carry no image
  // media; the observer must have received the screenshot image.
  assert.equal(mainRequests.length, 2, `primary requests captured: expected 2, got ${mainRequests.length}`);
  assert.equal(JSON.stringify(mainRequests[1]).includes('data:image/'), false,
    'primary second request must not carry image media');
  assert.equal(observerRequests.length, 1, `observer requests captured: expected 1, got ${observerRequests.length}`);
  assert.ok(JSON.stringify(observerRequests[0]).includes('data:image/'),
    'observer request carried the screenshot image');

  // Read the SQLite store and verify the tool receipt with the vision caption.
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
  const dbPath = join(root, 'studio/native-harness/runs.sqlite');
  const store = new SqliteRunStore(dbPath);
  const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
  const scope = {
    tenantId: 'local',
    workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'),
    userId: 'local-user', agentId,
  };

  const allRuns = store.list(scope, 'vision-session');
  assert.equal(allRuns.length, 1, `exactly one Run in SQLite: got ${allRuns.length}`);
  const runId = allRuns[0].runId;
  const record = store.load(scope, runId);
  assert.equal(record.snapshot.phase, 'completed', `Run phase: expected completed, got ${record.snapshot.phase}`);
  assert.equal(record.snapshot.usage.modelCalls, 2,
    `snapshot usage.modelCalls: expected 2 (two primary calls), got ${record.snapshot.usage.modelCalls}`);
  assert.equal(record.snapshot.descendantUsage.modelCalls, 1,
    `descendantUsage.modelCalls: expected 1 (one observer call), got ${record.snapshot.descendantUsage.modelCalls}`);

  // === Exactly one vision tool result; its resourceUsage.modelCalls === 1. ===
  const allResults = record.receipts.flatMap(r => r.result?.results ?? []);
  const modelCallOnes = allResults.filter(res => res.resourceUsage?.modelCalls === 1);
  assert.equal(modelCallOnes.length, 1, `exactly one tool result with resourceUsage.modelCalls===1: got ${modelCallOnes.length}`);
  const visionResult = modelCallOnes[0];
  assert.ok('vision_description' in (visionResult.content || {}),
    'the modelCalls===1 result is the vision tool result');
  console.log(`Vision caption: ${visionResult.content.vision_description}`);
  assert.equal(visionResult.content.vision_description_trust, 'untrusted_model_output',
    'vision caption is untrusted model output');
  assert.equal(visionResult.resourceUsageReported, true,
    'vision resourceUsageReported: expected true');
  // Original browser facts are preserved alongside the caption.
  assert.equal(visionResult.content.browser_channel, 'host-launched', 'browser channel preserved');
  assert.ok(typeof visionResult.content.browser_action_seq === 'number' && visionResult.content.browser_action_seq > 0,
    'browser_action_seq preserved');
  assert.ok(typeof visionResult.content.body_text_preview === 'string' && visionResult.content.body_text_preview.length > 0,
    'body_text_preview (page text) preserved');
  // The image is stripped from the tool result the primary model sees.
  assert.ok(!visionResult.context?.media?.length,
    'no image media in the vision tool result context (stripped for primary)');

  // === Cold-before snapshot: exact counts + the ENTIRE record canonical. ===
  const coldBefore = {
    mainCalls, observerCalls,
    toolResultsWithModelCalls: modelCallOnes.length,
    browserActionSeq: visionResult.content.browser_action_seq,
    runCount: allRuns.length,
  };
  const admissionPath = join(root, 'tool-admissions.jsonl');
  const admissionsBefore = await readFile(admissionPath, 'utf8');
  const admissions = admissionsBefore.trim().split('\n').map(JSON.parse);
  assert.equal(admissions.length, 1, 'one actual DSH tool admission');
  assert.equal(admissions[0].name, 'browser_inspect_workspace');
  assert.deepEqual(admissions[0].arguments, { path: 'app', wait_ms: 0 });
  const processPath = join(root, 'host-processes.jsonl');
  const originalProcesses = (await readFile(processPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(originalProcesses.length, 1);
  assert.equal(originalProcesses[0].node, process.version);
  assert.equal(originalProcesses[0].path, nodeOnlyBin);
  assert.notEqual(originalProcesses[0].pid, process.pid);
  const recordCanonical = canonical(record);
  console.log(`Cold-before snapshot: ${JSON.stringify(coldBefore)}`);
  console.log(`Full record canonical length: ${recordCanonical.length}`);
  store.close();

  // === Real Host/SDK process restart: close the DSH subprocess, spawn a fresh
  // one with the SAME config, and restore the persisted session via the real
  // SessionController/SDK history read. session/resume loads history through
  // agents.resume(), sends NO new input, and does not replay history as new
  // notifications. No new prompt is run — this is a history read, not a replay. ===
  await harness.close();
  assert.throws(() => process.kill(originalProcesses[0].pid, 0), { code: 'ESRCH' }, 'old actual Host process reaped');
  harness = new DeepSeekHarness(options);
  const resumed = await harness.resumeSession('vision-session');
  assert.equal(resumed.id, 'vision-session');
  // Wait for the fixture's resume handler (mounted-host probe + preset
  // recompose) to finish — it does control-RPC reads, never a model call.
  const probePath = join(root, 'mounted-host-http.jsonl');
  const resumeDeadline = Date.now() + 15000;
  let resumeProbe;
  while (Date.now() < resumeDeadline) {
    const rows = (await readFile(probePath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
    resumeProbe = rows.find(row => row.source === 'resume');
    if (resumeProbe) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(resumeProbe, 'real resumed Host must finish its preset/history probe before the deadline');
  assert.equal(resumeProbe.sessionId, 'vision-session');
  assert.equal(resumeProbe.historyHasAnswer, true, 'restored Session contains the original assistant response');
  assert.equal(resumeProbe.historyHasCompletedTurn, true);
  const processesAfter = (await readFile(processPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(processesAfter.length, 2, 'one original and one restarted Host process');
  assert.notEqual(processesAfter[0].pid, processesAfter[1].pid);
  assert.equal(processesAfter[1].pid, resumeProbe.pid);
  assert.equal(processesAfter[1].node, process.version);
  assert.equal(processesAfter[1].path, nodeOnlyBin);
  assert.equal(await readFile(admissionPath, 'utf8'), admissionsBefore, 'no additional actual DSH tool dispatch after restart');

  // === Assert model/tool/browser-action counts did NOT increase during the
  // real history replay (real comparison — NOT the self-comparison tautology). ===
  assert.equal(mainCalls, coldBefore.mainCalls,
    `no new primary model calls after Host restart+resume: ${coldBefore.mainCalls} -> ${mainCalls}`);
  assert.equal(observerCalls, coldBefore.observerCalls,
    `no new observer calls after Host restart+resume: ${coldBefore.observerCalls} -> ${observerCalls}`);

  // === Reopen SQLite and compare the ENTIRE store.load record canonical
  // (snapshot + receipts + configuration + intents + commits + events + fence +
  // lease + projections + commands), not just the snapshot. ===
  const reopened = new SqliteRunStore(dbPath);
  const coldRecord = reopened.load(scope, runId);
  const coldRunCount = reopened.list(scope, 'vision-session').length;
  assert.equal(coldRunCount, 1);
  const coldCanonical = canonical(coldRecord);
  assert.equal(coldCanonical, recordCanonical,
    'entire store.load record unchanged after real Host restart + SessionController history replay');
  // Re-verify the exact counts from the cold record.
  assert.equal(coldRecord.snapshot.usage.modelCalls, 2, 'cold snapshot usage.modelCalls === 2');
  assert.equal(coldRecord.snapshot.descendantUsage.modelCalls, 1, 'cold descendantUsage.modelCalls === 1');
  const coldVisionOnes = coldRecord.receipts.flatMap(r => r.result?.results ?? [])
    .filter(res => res.resourceUsage?.modelCalls === 1);
  assert.equal(coldVisionOnes.length, 1, 'cold record has exactly one modelCalls===1 tool result');
  assert.equal(coldVisionOnes[0].content.vision_description, visionResult.content.vision_description,
    'cold vision caption unchanged');
  assert.equal(coldRecord.snapshot.phase, 'completed', 'cold run phase completed');
  reopened.close();

  // Save evidence.
  const evidence = {
    archive: { path: archive, sha256: archiveSha },
    sdk: { source, commit: sdkCommit },
    node: process.version,
    chromium,
    proofRoot: root,
    httpCalls: { main: mainCalls, observer: observerCalls, total: mainCalls + observerCalls },
    coldBefore,
    coldAfter: { mainCalls, observerCalls, runCount: coldRunCount },
    actualToolAdmissions: admissions.length,
    hostProcesses: processesAfter,
    resumeProbe,
    runId,
    agentId,
    sessionId: 'vision-session',
    visionCaption: visionResult.content.vision_description,
    recordCanonicalLength: recordCanonical.length,
    canonicalMatchAfterHostRestart: coldCanonical === recordCanonical,
  };
  await writeFile(join(root, 'vision-proof-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence saved: ${join(root, 'vision-proof-evidence.json')}`);

  process.stdout.write('\nPASS: real Chromium, observer image caption, primary text-only completion, exactly 2+1 HTTP calls, '
    + 'usage.modelCalls===2 / descendantUsage===1 / tool resourceUsage.modelCalls===1, '
    + 'real Host restart + SessionController history replay with no new model/tool/browser calls, '
    + 'entire store.load record canonical unchanged\n');
} catch (error) {
  failed = true;
  const detail = { code: error.code, message: error.message, stack: error.stack,
    counts: { mainCalls, observerCalls, mainRequests: mainRequests.length, observerRequests: observerRequests.length } };
  await writeFile(join(root, 'vision-proof-failure.json'), JSON.stringify(detail, null, 2)).catch(() => {});
  console.error('Vision proof FAILED:', error.message, error.stack);
  throw error;
} finally {
  if (harness) await harness.close().catch(() => {});
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  if (!values.keep && !failed) await rm(root, { recursive: true, force: true });
}
