import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NATIVE_PACKAGES } from './native-package-integrity.mjs';

// Explicit maintainer operation. Download immutable exact-version metadata;
// never execute a package's lifecycle scripts while generating its evidence.
const root = fileURLToPath(new URL('../', import.meta.url));
const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'native-registry-pins-'));
const pins = { schemaVersion: 'agentkit.native-registry-pins/v1', packages: {} };
try {
  for (const name of NATIVE_PACKAGES) {
    const version = product.dependencies[name];
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error(`Use an exact registry version for ${name}`);
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
    if (!response.ok) throw Error(`Registry metadata unavailable for ${name}@${version}: ${response.status}`);
    const release = await response.json(), url = new URL(release.dist?.tarball);
    if (release.name !== name || release.version !== version || url.protocol !== 'https:'
      || url.hostname !== 'registry.npmjs.org' || url.username || url.password)
      throw Error('Registry release identity or archive origin mismatch');
    const download = await fetch(url);
    if (!download.ok) throw Error(`Registry archive unavailable: ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    if (integrity !== release.dist.integrity) throw Error('Registry archive integrity mismatch');
    const archive = resolve(temporary, name.split('/')[1] + '.tgz');
    writeFileSync(archive, bytes);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
    if (entries.some(path => !path.startsWith('package/') || path.includes('\\') || path.split('/').includes('..')))
      throw Error('Unsafe Native archive path');
    const types = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
    if (types.some(line => !['-', 'd'].includes(line[0]))) throw Error('Native archive contains a link or special file');
    const unpack = mkdtempSync(join(temporary, 'unpacked-'));
    execFileSync('tar', ['-xzf', archive, '-C', unpack]);
    const metadata = JSON.parse(readFileSync(join(unpack, 'package/package.json'), 'utf8'));
    if (metadata.name !== name || metadata.version !== version) throw Error('Registry package identity mismatch');
    const files = {};
    for (const entry of entries.sort()) {
      const path = join(unpack, entry), stat = lstatSync(path);
      if (stat.isDirectory()) continue;
      if (!stat.isFile()) throw Error('Unexpected Native archive entry');
      files[entry.slice('package/'.length)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    pins.packages[name] = { version, integrity, files };
  }
  writeFileSync(join(root, 'scripts/native-package-pins.json'), JSON.stringify(pins, null, 2) + '\n');
  console.log('Pinned exact registry archives and installed file digests for three Native packages.');
} finally { rmSync(temporary, { recursive: true, force: true }); }
