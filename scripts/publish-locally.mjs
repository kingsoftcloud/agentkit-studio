#!/usr/bin/env node
/** Publish a signed desktop candidate from an operator machine.
 *
 * GitHub-hosted runners cannot reliably reach the KS3 origin, so a maintainer
 * runs this after the candidate build finishes:
 *
 *   node scripts/publish-locally.mjs mac --run <run-id> --studio-ref <sha> \
 *     --expected-previous-version 0.2.1-rc.2
 *   node scripts/publish-locally.mjs win --run <run-id> --studio-ref <sha> \
 *     --version 0.2.1-rc.2.20261021.2 --expected-previous-version 0.2.1-rc.2
 *   node scripts/publish-locally.mjs alias --channel preview
 *
 * The command only reuses artifacts that already carry CI signing evidence: it
 * downloads the signed candidate, verifies SHA-256 sums, publishes the feed and
 * then refreshes the stable `studio/latest` alias. Credentials come from the
 * Host configuration or KSYUN_* environment variables, never from the shell
 * history.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import product from '../src/product.json' with { type: 'json' };

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const repository = 'kingsoftcloud/agentkit-studio';
const updateOrigin = product.desktop.updates.origin;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: 'string' },
    'studio-ref': { type: 'string' },
    version: { type: 'string' },
    channel: { type: 'string', default: product.desktop.updates.channel },
    'expected-previous-version': { type: 'string' },
    candidate: { type: 'string' },
    output: { type: 'string', default: '.artifacts/local-publish' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const [command] = positionals;
if (!['mac', 'win', 'alias'].includes(command)) throw new Error('usage: publish-locally.mjs <mac|win|alias> [options]');
if (!['preview', 'stable'].includes(values.channel)) throw new Error('--channel must be preview or stable');
const channel = values.channel;

async function gh(...args) {
  const { stdout } = await execute('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function ghJson(path) {
  return JSON.parse(await gh('api', `repos/${repository}/${path}`));
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifySums(directory) {
  const sums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  if (sums.length === 0) throw new Error('SHA256SUMS is empty');
  for (const line of sums) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/u);
    if (!match) throw new Error(`unreadable SHA256SUMS line: ${line}`);
    const actual = await sha256(join(directory, match[2].replace(/^\.\//u, '')));
    if (actual !== match[1]) throw new Error(`checksum mismatch for ${match[2]}`);
    console.log(`checksum ok: ${match[2]}`);
  }
}

async function downloadArtifact(run, matcher, directory) {
  const artifacts = await ghJson(`actions/runs/${run}/artifacts`);
  const matches = artifacts.artifacts?.filter(artifact => matcher.test(artifact.name)) ?? [];
  if (matches.length !== 1) throw new Error(`expected one artifact matching ${matcher}, found ${matches.length}`);
  await mkdir(directory, { recursive: true });
  console.log(`downloading ${matches[0].name} (${matches[0].size_in_bytes} bytes) from run ${run}`);
  await gh('run', 'download', run, '--repo', repository, '-n', matches[0].name, '-D', directory);
  return matches[0].name;
}

async function publishMac() {
  if (!values.run && !values.candidate) throw new Error('--run or --candidate is required');
  if (!values.candidate && !/^[0-9a-f]{40}$/u.test(values['studio-ref'] ?? '')) throw new Error('--studio-ref must be a full commit SHA');
  const directory = values.candidate ? resolve(values.candidate) : join(root, values.output, 'mac-arm64');
  if (values['dry-run'] && !values.candidate) {
    const artifacts = await ghJson(`actions/runs/${values.run}/artifacts`);
    const matches = (artifacts.artifacts ?? []).filter(artifact => new RegExp(`-${channel}-mac-arm64$`, 'u').test(artifact.name));
    if (matches.length !== 1) throw new Error(`expected one artifact matching -${channel}-mac-arm64, found ${matches.length}`);
    console.log(JSON.stringify({ stage: 'dry-run', platform: 'mac-arm64', run: values.run, artifact: matches[0].name, bytes: matches[0].size_in_bytes, channel, updateOrigin }, null, 2));
    return;
  }
  if (!values.candidate) await downloadArtifact(values.run, new RegExp(`-${channel}-mac-arm64$`, 'u'), directory);
  await verifySums(directory);
  const record = JSON.parse(await readFile(join(directory, 'mac-arm64-release.json'), 'utf8'));
  if (record.version !== values.version && values.version) throw new Error(`candidate version ${record.version} differs from --version ${values.version}`);
  const feed = YAML.parse(await readFile(join(directory, `${channel}-mac.yml`), 'utf8'));
  if (feed.version !== record.version) throw new Error('candidate feed and release record disagree');
  if (values['dry-run']) { console.log(JSON.stringify({ stage: 'dry-run', platform: 'mac-arm64', directory, version: record.version, channel, updateOrigin }, null, 2)); return; }
  const args = ['scripts/desktop-release.mjs', 'publish', '--candidate', directory, '--origin', updateOrigin,
    '--storage-origin', updateOrigin, '--layout', 'studio', '--update-mode', 'incremental', '--channel', channel];
  if (values['expected-previous-version']) args.push('--expected-previous-version', values['expected-previous-version']);
  console.log(`publishing mac feed ${record.version}`);
  console.log(await runNode(args));
  console.log(await runNode(['scripts/publish-download-alias.mjs', '--origin', updateOrigin, '--channel', channel]));
}

async function publishWin() {
  if (!values.run) throw new Error('--run is required');
  if (!/^[0-9a-f]{40}$/u.test(values['studio-ref'] ?? '')) throw new Error('--studio-ref must be a full commit SHA');
  if (!values.version) throw new Error('--version is required for Windows');
  if (!values['expected-previous-version']) throw new Error('--expected-previous-version is required for Windows');
  const directory = join(root, values.output, 'win-x64');
  if (values['dry-run']) { console.log(JSON.stringify({ stage: 'dry-run', platform: 'win-x64', run: values.run, version: values.version, channel, updateOrigin }, null, 2)); return; }
  await rm(directory, { recursive: true, force: true });
  const scratch = await mkdtemp(join(tmpdir(), 'studio-win-publish-'));
  try {
    console.log(await runNode(['scripts/prepare-windows-candidate.mjs', '--repository', repository, '--run', values.run,
      '--source', values['studio-ref'], '--version', values.version, '--require-ui', '--output', join(scratch, 'candidate')]));
    await execute('unzip', ['-q', join(scratch, 'candidate', 'candidate.zip'), '-d', join(scratch, 'unpacked')], { maxBuffer: 16 * 1024 * 1024 });
    const releases = await findDirectories(join(scratch, 'unpacked'), 'windows-release');
    const proofs = await findFiles(join(scratch, 'unpacked'), 'windows-install.json');
    if (releases.length !== 1 || proofs.length !== 1) throw new Error('candidate bundle does not contain exactly one release and proof');
    console.log(await runNode(['scripts/publish-windows-candidate.mjs', '--candidate', releases[0], '--proof', proofs[0],
      '--source', values['studio-ref'], '--version', values.version, '--previous', values['expected-previous-version'],
      '--origin', updateOrigin, '--channel', channel]));
    console.log(await runNode(['scripts/publish-download-alias.mjs', '--origin', updateOrigin, '--channel', channel]));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function publishAlias() {
  if (values['dry-run']) { console.log(JSON.stringify({ stage: 'dry-run', platform: 'alias', channel, updateOrigin }, null, 2)); return; }
  console.log(await runNode(['scripts/publish-download-alias.mjs', '--origin', updateOrigin, '--channel', channel]));
}

async function runNode(args) {
  const { stdout, stderr } = await execute(process.execPath, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (stderr.trim()) console.error(stderr.trim());
  return stdout.trim();
}

async function findDirectories(directory, name) {
  const { readdir } = await import('node:fs/promises');
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name === name) found.push(path); else found.push(...await findDirectories(path, name)); }
  }
  return found;
}

async function findFiles(directory, name) {
  const { readdir } = await import('node:fs/promises');
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

if (command === 'mac') await publishMac();
else if (command === 'win') await publishWin();
else await publishAlias();
