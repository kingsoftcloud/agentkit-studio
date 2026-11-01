import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, lstatSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { NATIVE_PACKAGES } from './native-package-integrity.mjs';

// Maintainer operation: use the reviewed lockfile and registry integrity, never
// local package contents, as release evidence. Lifecycle scripts are not run.
const root = fileURLToPath(new URL('../', import.meta.url));
const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'native-registry-pins-'));
const pins = { schemaVersion: 'agentkit.native-registry-pins/v2', packages: {}, dependencyPackages: {} };
const loaded = new Map();
async function releaseEvidence(name, version) {
  const key = `${name}@${version}`;
  if (loaded.has(key)) return loaded.get(key);
  const expectedIntegrity = lock.packages?.[key]?.resolution?.integrity;
  if (!expectedIntegrity) throw Error(`Release missing from reviewed lockfile: ${key}`);
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  if (!response.ok) throw Error(`Registry metadata unavailable for ${key}: ${response.status}`);
  const release = await response.json(), url = new URL(release.dist?.tarball);
  if (release.name !== name || release.version !== version || url.protocol !== 'https:'
    || url.hostname !== 'registry.npmjs.org' || url.username || url.password) throw Error('Registry identity or origin mismatch');
  const download = await fetch(url);
  if (!download.ok) throw Error(`Registry archive unavailable: ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (integrity !== release.dist.integrity || integrity !== expectedIntegrity) throw Error(`Registry/lock integrity mismatch: ${key}`);
  const area = mkdtempSync(join(temporary, 'release-')), archive = join(area, 'package.tgz');writeFileSync(archive, bytes);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  if (entries.some(path => !path.startsWith('package/') || path.includes('\\') || path.split('/').includes('..'))) throw Error('Unsafe archive path');
  const types = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  if (types.some(line => !['-', 'd'].includes(line[0]))) throw Error('Archive contains a link or special file');
  execFileSync('tar', ['-xzf', archive, '-C', area]);
  const metadata = JSON.parse(readFileSync(join(area, 'package/package.json'), 'utf8'));
  if (metadata.name !== name || metadata.version !== version) throw Error('Archive package identity mismatch');
  const files = {};
  for (const entry of entries.sort()) {
    const path = join(area, entry), stat = lstatSync(path);if (stat.isDirectory()) continue;
    if (!stat.isFile()) throw Error('Unexpected archive entry');
    files[entry.slice('package/'.length)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  const result = { version, integrity, files }; loaded.set(key, result); return result;
}
async function installedDependencies(directory, evidence) {
  const manifest = join(directory, 'package.json');
  if (createHash('sha256').update(readFileSync(manifest)).digest('hex') !== evidence.files['package.json']) throw Error('Installed manifest differs from registry');
  const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
  const declared = { ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies };
  const nested = join(directory, 'node_modules');if (!existsSync(nested)) return;
  const names = readdirSync(nested).flatMap(name => name.startsWith('@') ? readdirSync(join(nested, name)).map(child => `${name}/${child}`) : [name]);
  for (const name of names) {
    const path = join(nested, name), stat = lstatSync(path);
    if (!Object.hasOwn(declared, name) || !stat.isDirectory() || stat.isSymbolicLink()) throw Error(`Unexpected installed dependency: ${name}`);
    const installed = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (installed.name !== name) throw Error('Installed dependency identity mismatch');
    const evidence = await releaseEvidence(name, installed.version);pins.dependencyPackages[`${name}@${installed.version}`] = evidence;
    await installedDependencies(path, evidence);
  }
}
try {
  const require = createRequire(join(root, 'package.json'));
  for (const name of NATIVE_PACKAGES) {
    const version = product.dependencies[name];if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error(`Use an exact version for ${name}`);
    const evidence = await releaseEvidence(name, version);pins.packages[name] = evidence;
    let directory = dirname(require.resolve(name));while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
    await installedDependencies(directory, evidence);
  }
  writeFileSync(join(root, 'scripts/native-package-pins.json'), JSON.stringify(pins, null, 2) + '\n');
  console.log('Pinned exact registry archives, own files and separately installed dependency files against the reviewed lockfile.');
} finally { rmSync(temporary, { recursive: true, force: true }); }
