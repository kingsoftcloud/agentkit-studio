import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { resolveProductInputs, resolveWorkflowProductOutputs, resolveWorkflowSourceOutputs } from '../scripts/product-config.mjs';

test('empty workflow fields resolve from the product definition and explicit release fields override them', () => {
  const defaults = resolveWorkflowProductOutputs({ buildVersion: '', updateOrigin: '', storageOrigin: '', channel: '' });
  const product = resolveProductInputs();
  assert.equal(defaults.name, product.name);
  assert.equal(defaults.app_id, product.appId);
  assert.equal(defaults.update_origin, product.settings.DSH_DESKTOP_UPDATE_ORIGIN);
  assert.equal(defaults.channel, product.settings.DSH_DESKTOP_UPDATE_CHANNEL);
  assert.equal(defaults.storage_origin, defaults.update_origin);
  const release = resolveWorkflowProductOutputs({ buildVersion: '0.2.0-rc.2.20261015.3', channel: 'stable', updateOrigin: 'https://updates.example.org', storageOrigin: 'https://binaries.example.org' });
  assert.equal(release.channel, 'stable');
  assert.equal(release.build_version, '0.2.0-rc.2.20261015.3');
  assert.equal(release.update_origin, 'https://updates.example.org');
  assert.equal(release.storage_origin, 'https://binaries.example.org');
  assert.throws(() => resolveWorkflowProductOutputs({ channel: 'invalid' }));
});

test('workflow tooling reads the qualified source product instead of its own defaults', t => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-workflow-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'src'));
  const configuration = JSON.parse(readFileSync('src/product.json', 'utf8'));
  configuration.brand.name = 'Qualified Product'; configuration.desktop.appId = 'org.example.qualified';
  writeFileSync(join(directory, 'src/product.json'), JSON.stringify(configuration));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@kingsoftcloud/agentkit-studio', version: '1.2.3' }));
  writeFileSync(join(directory, 'studio.plugin.json'), JSON.stringify({ requiredDsh: '2.3.4' }));
  const values = resolveWorkflowSourceOutputs(directory);
  assert.equal(values.name, 'Qualified Product'); assert.equal(values.app_id, 'org.example.qualified');
  assert.equal(values.plugin_version, '1.2.3'); assert.equal(values.build_version, '2.3.4');
  assert.equal(values.product_definition, 'source');
  delete configuration.copy;
  writeFileSync(join(directory, 'src/product.json'), JSON.stringify(configuration));
  assert.equal(resolveWorkflowSourceOutputs(directory).name, 'Qualified Product', 'schema 1 product definitions before copy overrides remain readable');
});

test('historical signed sources keep their frozen identity and require explicit release parameters', t => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-workflow-legacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = { name: '@kingsoftcloud/agentkit-studio', version: '0.0.1' };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(metadata));
  const inputs = { buildVersion: '0.2.0-rc.2.20261015.3', channel: 'preview', updateOrigin: 'https://historical.example.org' };
  for (const key of ['buildVersion', 'channel', 'updateOrigin']) assert.throws(() => resolveWorkflowSourceOutputs(directory, { ...inputs, [key]: '' }), /explicit/);
  const values = resolveWorkflowSourceOutputs(directory, inputs);
  assert.equal(values.name, 'AgentKit Studio'); assert.equal(values.app_id, 'com.kingsoftcloud.agentkit-studio');
  assert.equal(values.plugin_version, metadata.version); assert.equal(values.update_origin, inputs.updateOrigin);
  assert.equal(values.product_definition, 'legacy-workflow-v1');
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src/product.json'), 'null');
  assert.throws(() => resolveWorkflowSourceOutputs(directory, inputs), /invalid public/);
  rmSync(join(directory, 'src/product.json'));
  metadata.version = '9.0.0'; writeFileSync(join(directory, 'package.json'), JSON.stringify(metadata));
  assert.throws(() => resolveWorkflowSourceOutputs(directory, inputs), /supported/);
});

test('workflow output CLI emits only normalized public values and its consumers declare the gate dependency', () => {
  const output = execFileSync(process.execPath, ['scripts/product-config.mjs', 'github-outputs'], { encoding: 'utf8', env: { ...process.env,
    STUDIO_PRODUCT_BUILD_VERSION: '0.2.0-rc.2.20261015.3', STUDIO_PRODUCT_CHANNEL: 'stable',
    STUDIO_PRODUCT_UPDATE_ORIGIN: 'https://updates.example.org', STUDIO_PRODUCT_STORAGE_ORIGIN: '', PRIVATE_TEST_SIGNING_VALUE: 'synthetic-private-marker',
  } });
  const values = Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  assert.equal(values.channel, 'stable');
  assert.equal(values.storage_origin, 'https://updates.example.org');
  assert.ok(!output.includes('synthetic-private-marker'));
  const workflow = parse(readFileSync('.github/workflows/release-desktop.yml', 'utf8'));
  for (const job of Object.values(workflow.jobs)) {
    if (JSON.stringify(job).includes('needs.source-gate.outputs')) assert.ok(job.needs.includes('source-gate'));
  }
  assert.ok(workflow.jobs['source-gate'].steps.find(step => step.id === 'product'));
  assert.equal(workflow.on.workflow_dispatch.inputs.publish_feed.default, false);
});

test('candidate archive extraction expands the configured product name in Bash', { skip: process.platform === 'win32' && 'The owning macOS publication step runs Bash.' }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-workflow-archive-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workflow = parse(readFileSync('.github/workflows/release-desktop.yml', 'utf8'));
  const lines = Object.values(workflow.jobs).flatMap(job => (job.steps || []).flatMap(step => (step.run || '').split('\n')))
    .filter(line => line.includes('unzip -p') && line.includes('studio-candidate.asar'));
  assert.equal(lines.length, 1);
  const script = `unzip() {
    test "$1" = '-p' && test "$2" = 'candidate.zip' && test "$3" = "$EXPECTED_ARCHIVE_ENTRY" || return 64
    printf '%s' 'qualified archive bytes'
  }
  zip=candidate.zip
  ${lines[0]}`;
  execFileSync('bash', ['-eu', '-c', script], { env: { ...process.env, RUNNER_TEMP: directory,
    STUDIO_PRODUCT_NAME: 'Configured Product', EXPECTED_ARCHIVE_ENTRY: 'Configured Product.app/Contents/Resources/app.asar' } });
  assert.equal(readFileSync(join(directory, 'studio-candidate.asar'), 'utf8'), 'qualified archive bytes');
});

test('Windows normalizes source-owned product inputs before signing and propagates them to packaging', () => {
  const workflow = parse(readFileSync('.github/workflows/release-windows.yml', 'utf8'));
  const steps = workflow.jobs['windows-x64'].steps;
  const normalizer = steps.findIndex(step => step.id === 'product');
  assert.ok(normalizer >= 0 && normalizer < steps.findIndex(step => step.id === 'certum'));
  const resolver = steps.find(step => step.with?.path === '.product-tools');
  assert.equal(resolver.with.ref, '${{ github.workflow_sha }}');
  const packaging = steps.find(step => step.name === 'Package the official DSH Windows target');
  for (const [name, output] of Object.entries({ BUILD_VERSION: 'build_version', DSH_CLIENT_TITLE: 'name', DSH_DESKTOP_PLUGIN_ROOTS: 'plugin_roots', DSH_DESKTOP_PLUGIN_BUNDLES: 'plugin_bundles', STUDIO_PRODUCT_ICON: 'windows_icon', STUDIO_PRODUCT_TRAY_ICON: 'windows_tray_icon' })) {
    assert.equal(packaging.env[name], '${{ steps.product.outputs.' + output + ' }}');
  }
  const signing = steps.find(step => step.name === 'Configure verified certificate-store signing');
  assert.equal(signing.env.STUDIO_PRODUCT_APP_ID, '${{ steps.product.outputs.app_id }}');
  assert.match(signing.run, /\.product-tools\/scripts\/prepare-windows-signing\.ps1/);
  assert.match(signing.run, /-AppId \$env:STUDIO_PRODUCT_APP_ID/);
});
