/** Packed production Host/DSH registry acceptance for legacy-runtime Node tools. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer as createHttpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import { createZip } from '../src/zip.mjs';
import { browserExecutable } from '../tests/fixtures/browser-executable.mjs';
import { DSH_NODE_BUILTIN_NAMES } from '../src/providers/dsh-node-builtin-catalog.mjs';
const { values } = parseArgs({ options: { source: { type: 'string' }, installation: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' },
  'skill-backend': { type: 'string', default: 'local_process' }, 'command-backend': { type: 'string', default: 'local_process' },
  'memory-backend': { type: 'string', default: 'http' } } });
assert.ok(Boolean(values.source) !== Boolean(values.installation) && values.archive,
  'Use --source <built maintained DSH> OR --installation <fresh registry project>, plus --archive <Studio.tgz>');
const skillBackend = values['skill-backend']; assert.ok(['local_process', 'e2b'].includes(skillBackend));
const commandBackend = values['command-backend']; assert.ok(['local_process', 'e2b'].includes(commandBackend));
const memoryBackend = values['memory-backend']; assert.ok(['http', 'sdk'].includes(memoryBackend));
const repository = fileURLToPath(new URL('..', import.meta.url)), source = values.source ? resolve(values.source) : null;
const installation = values.installation ? resolve(values.installation) : null;
const root = await mkdtemp(join(tmpdir(), 'studio-node-builtins-'));
console.log(`Studio Node builtin evidence: ${root}`);
let harness, download, downloads = 0;
const skillBody = '---\nname: packed-alpha\ndescription: Packed Alpha task\n---\n# Packed Alpha 😀\nRead the supplied JSON.\n';
const skillScript = 'printf forbidden > must-not-execute';
const workflowScript = 'printf x >> "$KSADK_SKILL_WORKDIR/effect"\nprintf "Packed workflow 😀" > "$KSADK_SKILL_OUTPUT_DIR/result.txt"\nprintf "\\000\\001\\377" > "$KSADK_SKILL_OUTPUT_DIR/raw.bin"\nprintf "artifact=artifacts/result.txt\\nartifact=artifacts/raw.bin\\n"';
const skillArchive = createZip([{ name: 'SKILL.md', data: skillBody }, { name: 'scripts/run.sh', data: skillScript },
  { name: 'scripts/run-workflow.sh', data: workflowScript }]);
const sha256 = value => createHash('sha256').update(value).digest('hex');
try {
  const certs = join(root, 'certs'); await mkdir(certs);
  const key = join(certs, 'key.pem'), cert = join(certs, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'pipe' });
  download = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    assert.equal(req.url, '/skill.zip'); assert.equal(req.headers.authorization, undefined); downloads++;
    res.end(skillArchive);
  });
  await new Promise(resolve => download.listen(0, '127.0.0.1', resolve));
  const skillDownloadUrl = `https://127.0.0.1:${download.address().port}/skill.zip`;
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph); execFileSync('tar', ['-xzf', resolve(values.archive), '-C', graph]);
  if (installation) {
    const lock = JSON.parse(await readFile(join(installation, 'package-lock.json'), 'utf8'));
    assert.ok(Object.entries(lock.packages).filter(([path]) => path.startsWith('node_modules/')).every(([, value]) => !value.link));
    await symlink(join(installation, 'node_modules'), dependencies);
  } else {
    await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
    for (const name of await readdir(join(repository, 'node_modules'))) {
      if (name.startsWith('.') || name === '@deepseek-ai') continue;
      await symlink(join(repository, 'node_modules', name), join(dependencies, name));
    }
    const publicPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
    for (const name of await readdir(publicPackages)) await symlink(join(publicPackages, name), join(dependencies, '@deepseek-ai', name));
  }
  const pluginDirectory = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
  await mkdir(pluginDirectory, { recursive: true }); await symlink(installed, join(pluginDirectory, 'agentkit-studio'));
  const nodeBin = join(root, 'node-shell-bin'); await mkdir(nodeBin); await symlink(process.execPath, join(nodeBin, 'node'));
  await symlink('/bin/bash', join(nodeBin, 'bash'));
  const patch = join(root, 'builtins.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:',
    '    - id: builtin-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: builtin-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: builtin-proof-model-selection', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: builtin-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
    '    - id: builtin-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
    '    - id: builtin-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'",
    '    - id: builtin-proof-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: builtin-proof-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-node-builtins.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`,
    `        skillDownloadUrl: ${JSON.stringify(skillDownloadUrl)}`, `        skillArchiveHash: ${JSON.stringify(sha256(skillArchive))}`,
    `        skillBody: ${JSON.stringify(skillBody)}`, `        skillScript: ${JSON.stringify(skillScript)}`, '',
    `        skillBackend: ${JSON.stringify(skillBackend)}`, '',
    `        commandBackend: ${JSON.stringify(commandBackend)}`, '',
    `        memoryBackend: ${JSON.stringify(memoryBackend)}`, '',
    ...(commandBackend === 'local_process' ? [`        browserExecutablePath: ${JSON.stringify(browserExecutable())}`, ''] : []),
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(installation
    ? join(installation, 'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js') : join(source, 'packages/sdk/client/lib/index.js')).href);
  const harnessOptions = { dshBin: installation
    ? join(installation, 'node_modules/@deepseek-ai/dsh/lib/bin.js') : join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [installation ? join(installation, 'node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml')
      : join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-builtin-proof', model: 'unused', initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
    env: { ...process.env, PATH: nodeBin, NODE_EXTRA_CA_CERTS: cert, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_KSADK_PYTHON: '/unavailable/python', AGENTKIT_KSADK_ROOT: '/unavailable/ksadk' } };
  harness = new DeepSeekHarness(harnessOptions);
  await harness.start();
  await writeFile(join(root, 'start-proof'), 'Execute the actual Host proof after initialization.');
  const deadline = Date.now() + 30000; let report;
  while (Date.now() < deadline) {
    try { report = JSON.parse(await readFile(join(root, 'proof.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(report?.passed, true, JSON.stringify(report));
  assert.equal(report.node, process.version); assert.equal(report.path, nodeBin);
  assert.deepEqual(report.runtimes.map(row => row.runtime), ['dsh-native', 'codex']);
  for (const row of report.runtimes) assert.deepEqual(row.builtinNames, [...DSH_NODE_BUILTIN_NAMES].sort());
  assert.ok(report.runtimes.every(row => row.crossSessionReadStateIsolated && row.parser === 'ruff-wasm'));
  assert.ok(report.runtimes.every(row => row.web.calls === 6 && row.web.preAndGuardDeniedWithoutFetch
    && row.web.postPolicyPreserved && row.web.canceled && row.web.fullOutputPersisted && row.web.crossSessionOutputIsolated));
  assert.equal(new Set(report.runtimes.flatMap(row => row.web.outputs.map(output => output.path))).size, 4);
  assert.ok(report.runtimes.every(row => row.commands.backend === commandBackend && row.commands.sessionOwnership
    && row.commands.policyDenial && row.commands.postPolicyPreserved && row.commands.oneShotApprovals === 2));
  if (commandBackend === 'local_process') assert.ok(report.runtimes.every(row => row.commands.duplicateCount === 1
    && row.commands.fullOutputBytes === 120000 && row.commands.backgroundCanceled));
  else assert.ok(report.runtimes.every(row => row.commands.creationUnknown && row.commands.duplicateSuppressed
    && row.commands.noLocalEffect && row.commands.originalDshOwner));
  assert.ok(report.runtimes.every(row => row.components.ok === true && row.components.summary.model === 'deepseek-flash'
    && row.components.workspace.tools.length === 10 && row.components.sandbox.tools.length === (commandBackend === 'e2b' ? 5 : 4)
    && row.components.skill_runtime.enabled === true && row.components.skill_runtime.backend === skillBackend
    && row.components.skill_runtime.request_protocol === 'agentkit.dsh-node-skill-workflow/v1'
    && row.components.sandbox.backend === commandBackend && row.components.sandbox.template_bound === (commandBackend === 'e2b')
    && row.components.summary.isolated_execution === (skillBackend === 'e2b' || commandBackend === 'e2b' ? 'enabled' : 'not_enabled')));
  assert.equal(downloads, 4);
  assert.ok(report.runtimes.every(row => row.code.backend === commandBackend && (commandBackend === 'e2b'
    ? row.code.creationUnknown && row.code.duplicateSuppressed && row.code.originalDshOwner
    : row.code.isolatedSandboxRequired && row.code.executed === false)));
  assert.ok(report.runtimes.every(row => row.skills.instructionsSha256 === sha256(skillBody) && row.skills.serviceRequests === 7
    && row.skills.policyDeniedWithoutRequest && row.skills.postPolicyPreserved && row.skills.scriptsNotExecuted));
  assert.equal(new Set(report.runtimes.map(row => row.skills.rootDir)).size, 2);
  assert.ok(report.runtimes.every(row => row.management.commit === 'c'.repeat(40) && row.management.revision === 2
    && row.management.githubRequests === 6 && row.management.exactBinary && row.management.originalDshOwner
    && row.management.duplicateSuppressed && row.management.oldRevisionPreserved && row.management.nextRevisionAdmitted));
  assert.ok(report.runtimes.every(row => row.knowledge.actualRequests === 1 && row.knowledge.originalDshOwner
    && row.knowledge.duplicateSuppressed && row.knowledge.policyDenied && row.knowledge.postPolicyPreserved));
  assert.ok(report.runtimes.every(row => row.memory.actualRequests === (memoryBackend === 'sdk' ? 3 : 2) && row.memory.backend === memoryBackend && row.memory.originalDshOwner
    && row.memory.duplicateSuppressed && row.memory.policyDenied && row.memory.postPolicyPreserved));
  assert.ok(report.runtimes.every(row => row.workflows.backend === skillBackend && row.workflows.serviceRequests === 2
    && row.workflows.originalDshOwner && row.workflows.oneShotApprovals === 2
    && row.workflows.policyDeniedWithoutRequest && row.workflows.postPolicyPreserved));
  if (skillBackend === 'local_process') assert.ok(report.runtimes.every(row => row.workflows.executedOnce && row.workflows.exactArtifacts));
  else assert.ok(report.runtimes.every(row => row.workflows.refusedSdkCreation && row.workflows.commands === 0
    && row.workflows.outcomeUnknown));
  assert.equal(new Set(report.runtimes.map(row => row.workflows.runtimeId)).size, 2);
  assert.ok(report.runtimes.every(row => row.a2a.sends === 1 && row.a2a.serviceRequests === 3 && row.a2a.originalDshOwner
    && row.a2a.duplicateSuppressed && row.a2a.policyDeniedWithoutRequest && row.a2a.postPolicyPreserved && row.a2a.oneShotApprovals === 2));
  assert.ok(report.runtimes.every(row => commandBackend === 'e2b' ? row.browser.disabledUnderE2b === true
    : row.browser.enabled && row.browser.duplicateSuppressed && row.browser.canvasUniform && row.browser.policyDenied
      && row.browser.postPolicyPreserved && row.browser.oneShotApprovals === 2));
  let cold;
  if (report.runtimes.every(row => row.a2a)) {
    await rm(join(root, 'start-proof')); await harness.close();
    const goneBy = Date.now() + 15000;
    for (;;) {
      try { process.kill(report.pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); break; }
      assert.ok(Date.now() < goneBy, 'original Host must actually exit before cold restore');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (commandBackend === 'local_process') await writeFile(join(root, 'workspace/browser-proof.html'), '<!doctype html><title>must-not-replay</title><p>Cold recovery must return the original receipt.</p>');
    harness = new DeepSeekHarness(harnessOptions); await harness.start();
    await writeFile(join(root, 'start-proof'), 'Restore original calls after original Host PID exited.');
    const coldBy = Date.now() + 30000;
    while (Date.now() < coldBy) {
      try { cold = JSON.parse(await readFile(join(root, 'cold-proof.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(cold?.passed, true, JSON.stringify(cold)); assert.notEqual(cold.pid, report.pid); assert.equal(cold.previousPid, report.pid);
    assert.deepEqual(cold.restoredA2a.map(row => [row.runtime, row.agentId, row.sessionId, row.taskId, row.unchanged]),
      report.runtimes.map(row => [row.runtime, row.agentId, row.sessionId, row.a2a.taskId, true]));
    assert.equal(cold.a2aRequests, 0);
    assert.equal(cold.githubRequests, 0);
    assert.equal(cold.knowledgeRequests, 0);
    assert.equal(cold.memoryRequests, 0);
    assert.deepEqual(cold.restoredMemory, report.runtimes.map(row => ({ runtime: row.runtime, unchanged: true })));
    assert.deepEqual(cold.restoredKnowledge, report.runtimes.map(row => ({ runtime: row.runtime, unchanged: true })));
    assert.deepEqual(cold.restoredManagement, report.runtimes.map(row => ({ runtime: row.runtime, resourceId: row.management.resourceId, revision: 2, unchanged: true })));
    assert.equal(cold.restoredBrowsers.length, commandBackend === 'local_process' ? 2 : 0);
    assert.equal(cold.node, process.version); assert.equal(cold.networkCalls, 0); assert.equal(cold.skillRequests, 0); assert.equal(downloads, 4);
    assert.deepEqual(cold.restored.map(row => [row.runtime, row.agentId, row.sessionId, row.runtimeId, row.taskId, row.unchanged]),
      skillBackend === 'e2b' ? report.runtimes.map(row => [row.runtime, row.agentId, row.sessionId, row.workflows.runtimeId, row.workflows.taskId, true]) : []);
    assert.deepEqual(cold.restoredCommands.map(row => [row.runtime, row.agentId, row.sessionId, row.taskId, row.unchanged]),
      commandBackend === 'e2b' ? report.runtimes.map(row => [row.runtime, row.agentId, row.sessionId, row.commands.taskId, true]) : []);
    assert.deepEqual(cold.restoredCodes.map(row => [row.runtime, row.agentId, row.sessionId, row.taskId, row.unchanged]),
      commandBackend === 'e2b' ? report.runtimes.map(row => [row.runtime, row.agentId, row.sessionId, row.code.taskId, true]) : []);
  }
  await writeFile(join(root, 'accepted-evidence.json'), JSON.stringify({ node: process.version, skillBackend, commandBackend, downloads,
    dependencies: installation ? { kind: 'fresh-installation', installation,
      lockSha256: sha256(await readFile(join(installation, 'package-lock.json'))) }
      : { kind: 'maintained-source', source },
    archiveSha256: sha256(await readFile(resolve(values.archive))), skillArchiveHash: sha256(skillArchive), report, ...(cold ? { cold } : {}) }, null, 2));
  if (installation) console.log('PASS: freshly installed Host mounts packed Studio, registers all 34 Node builtins for DSH Native/Codex, executes the actual tool/policy pipeline and restores original records in a new PID. No repository/source dependency links. Node/bash Host PATH, Python unavailable. Chromium is an existing test prerequisite; model/CLI, Native full turns and online services remain separate acceptance.');
  else console.log(skillBackend === 'local_process' && commandBackend === 'local_process'
    ? 'PASS: packed Host registers Node managed A2A + workspace + web + commands + component_status + five Skill reads + durable local execute_skills for DSH Native and Codex; real HTTP service/CA-verified HTTPS ZIP/scripts/exact text+binary artifacts; stable real DSH identity and duplicate suppression; policy, one-shot approval and post policy retained; Node/bash PATH with invalid Python. Model/Codex CLI and fresh dependency installation are separate acceptance.'
    : `PASS: packed Host DSH Native/Codex selected commands=${commandBackend}, Skills=${skillBackend}; E2B uses actual installed SDK with an explicitly refused endpoint, durable original DSH creation/unknown intent and distinct-PID cold restore with unchanged records. Real HTTP Skill Service + CA-verified HTTPS ZIP, workspace/Web and approvals retained. Node/bash PATH, Python unavailable. Refusal/recovery acceptance; online E2B success, fresh install and model/Codex CLI are separate gates.`);
} finally {
  await harness?.close();
  download?.closeAllConnections(); if (download) await new Promise(resolve => download.close(resolve));
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
