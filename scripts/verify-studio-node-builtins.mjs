/** Packed production Host/DSH registry acceptance for legacy-runtime Node tools. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
const repository = fileURLToPath(new URL('..', import.meta.url)), source = resolve(values.source);
const root = await mkdtemp(join(tmpdir(), 'studio-node-builtins-'));
console.log(`Studio Node builtin evidence: ${root}`);
let harness;
try {
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph); execFileSync('tar', ['-xzf', resolve(values.archive), '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const name of await readdir(join(repository, 'node_modules'))) {
    if (name.startsWith('.') || name === '@deepseek-ai') continue;
    await symlink(join(repository, 'node_modules', name), join(dependencies, name));
  }
  const publicPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const name of await readdir(publicPackages)) await symlink(join(publicPackages, name), join(dependencies, '@deepseek-ai', name));
  const pluginDirectory = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
  await mkdir(pluginDirectory, { recursive: true }); await symlink(installed, join(pluginDirectory, 'agentkit-studio'));
  const nodeBin = join(root, 'node-only-bin'); await mkdir(nodeBin); await symlink(process.execPath, join(nodeBin, 'node'));
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
    '      config:', `        directory: ${JSON.stringify(root)}`, '',
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  harness = new DeepSeekHarness({ dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-builtin-proof', model: 'unused', initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_KSADK_PYTHON: '/unavailable/python', AGENTKIT_KSADK_ROOT: '/unavailable/ksadk' } });
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
  assert.ok(report.runtimes.every(row => row.crossSessionReadStateIsolated && row.parser === 'ruff-wasm'));
  assert.ok(report.runtimes.every(row => row.web.calls === 6 && row.web.preAndGuardDeniedWithoutFetch
    && row.web.postPolicyPreserved && row.web.canceled && row.web.fullOutputPersisted && row.web.crossSessionOutputIsolated));
  assert.equal(new Set(report.runtimes.flatMap(row => row.web.outputs.map(output => output.path))).size, 4);
  assert.ok(report.runtimes.every(row => row.commands.duplicateCount === 1 && row.commands.fullOutputBytes === 120000
    && row.commands.sessionOwnership && row.commands.policyDenial && row.commands.postPolicyPreserved
    && row.commands.backgroundCanceled && row.commands.oneShotApprovals === 2));
  assert.ok(report.runtimes.every(row => row.components.ok === true && row.components.summary.model === 'deepseek-flash'
    && row.components.workspace.tools.length === 10 && row.components.sandbox.tools.length === 4
    && row.components.skill_runtime.enabled === false && row.components.summary.isolated_execution === 'not_enabled'));
  console.log('PASS: packed Host registers Node workspace + web + commands + component_status for DSH Native and Codex; actual pre/guard/around/post/output, selected model and admitted component facts, command deduplication, foreground/background/scoped stop, full UTF-8 outputs, policies, one-shot approvals and Agent/Session isolation; Node-only PATH. Model/Codex CLI and fresh dependency installation are separate acceptance.');
} finally {
  await harness?.close();
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
