/** Qualify the pinned updater's ZIP/blockmap reconstruction over loopback HTTP Range. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request, createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot = resolve(process.env.AGENTKIT_DSH_ROOT || join(studioRoot, '../../deepseek-harness'));
const reportPath = resolve(process.env.AGENTKIT_DESKTOP_DIFF_REPORT || join(studioRoot, '.artifacts', 'desktop-differential.json'));
const requireDesktop = createRequire(join(dshRoot, 'apps/desktop/package.json'));
const updaterFile = requireDesktop.resolve('electron-updater/out/AppUpdater.js');
const requireUpdater = createRequire(updaterFile);
const { HttpExecutor, CancellationToken } = requireUpdater('builder-util-runtime');
const { GenericDifferentialDownloader } = requireUpdater('./differentialDownloader/GenericDifferentialDownloader.js');
const blockmapFile = requireDesktop.resolve('app-builder-lib/out/targets/differentialUpdateInfoBuilder.js');
const { buildBlockMap } = createRequire(blockmapFile)('./blockmap/blockmap.js');
assert.equal(requireUpdater('../package.json').version, '6.8.9', 'Qualify the pinned updater version');

// Node transport only; production keeps DSH's ElectronHttpExecutor and native installer.
class LoopbackHttpExecutor extends HttpExecutor {
  createRequest(options, callback) { return request(options, callback); }
}

const root = await mkdtemp(join(tmpdir(), 'studio-desktop-differential-'));
const requests = [];
let server;
try {
  const oldFile = join(root, 'studio-1.0.0.zip');
  const newFile = join(root, 'studio-1.0.1.zip');
  const payload = join(root, 'payload.bin');
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 251;
  await writeFile(payload, bytes);
  await execute('zip', ['-q', '-0', '-X', '-j', oldFile, payload]);
  bytes.fill(0x5a, 900_000, 960_000);
  await writeFile(payload, bytes);
  await execute('zip', ['-q', '-0', '-X', '-j', newFile, payload]);
  await buildBlockMap(oldFile, 'gzip', `${oldFile}.blockmap`);
  const info = await buildBlockMap(newFile, 'gzip', `${newFile}.blockmap`);
  const files = new Map([
    ['/studio-1.0.0.zip.blockmap', await readFile(`${oldFile}.blockmap`)],
    ['/studio-1.0.1.zip.blockmap', await readFile(`${newFile}.blockmap`)],
    ['/studio-1.0.1.zip', await readFile(newFile)],
  ]);
  let corrupt = false;
  server = createServer((incoming, outgoing) => {
    const path = new URL(incoming.url, 'http://localhost').pathname;
    const data = files.get(path);
    if (!data) { outgoing.writeHead(404).end(); return; }
    const range = incoming.headers.range;
    const match = /^bytes=(\d+)-(\d+)$/u.exec(range || '');
    if (range && !match) { outgoing.writeHead(416).end(); return; }
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : data.length - 1;
    if (start > end || end >= data.length) { outgoing.writeHead(416).end(); return; }
    const body = corrupt && path.endsWith('.zip') ? Buffer.alloc(end - start + 1, 0x21) : data.subarray(start, end + 1);
    requests.push({ path, range: range || null, bytes: body.length, corrupt });
    outgoing.writeHead(match ? 206 : 200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    outgoing.end(body);
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executor = new LoopbackHttpExecutor();
  const token = new CancellationToken();
  const loadMap = async file => JSON.parse(gunzipSync(await executor.downloadToBuffer(new URL(`${origin}/${file}.blockmap`), {
    cancellationToken: token,
  })).toString('utf8'));
  const [oldMap, newMap] = await Promise.all([loadMap('studio-1.0.0.zip'), loadMap('studio-1.0.1.zip')]);
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(key => [key, () => {}]));
  const reconstruct = path => new GenericDifferentialDownloader(info, executor, {
    newUrl: new URL(`${origin}/studio-1.0.1.zip`), oldFile, newFile: path,
    cancellationToken: token, isUseMultipleRangeRequest: false, requestHeaders: {}, logger,
  }).download(oldMap, newMap);
  const output = join(root, 'reconstructed.zip');
  await reconstruct(output);
  const sha512 = createHash('sha512').update(await readFile(output)).digest('base64');
  assert.equal(sha512, info.sha512, 'Reconstructed ZIP must match the full target');
  await execute('unzip', ['-tq', output]);
  const transfers = requests.filter(item => item.path.endsWith('.zip') && !item.corrupt);
  assert.ok(transfers.length > 0 && transfers.every(item => item.range), 'A full download cannot count as differential success');
  const downloadedBytes = transfers.reduce((count, item) => count + item.bytes, 0);
  assert.ok(downloadedBytes < info.size, 'Reuse bytes from the previous cached ZIP');
  corrupt = true;
  await assert.rejects(reconstruct(join(root, 'corrupt.zip')), /checksum|sha512|digest|mismatch/iu);
  const report = {
    status: 'loopback-differential-passed', updaterVersion: '6.8.9',
    engine: 'official GenericDifferentialDownloader', blockmap: 'official buildBlockMap gzip v2',
    transport: 'Node HTTP loopback single Range', targetBytes: info.size, downloadedBytes,
    reusedBytes: info.size - downloadedBytes, rangeRequests: transfers.length,
    sha512Matches: true, reconstructedZipValid: true, corruptTransferRejected: true,
    installedUpgrade: false, signatureQualification: false, cdnQualification: false, requests,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (server?.listening) await new Promise((accept, reject) => {
    server.close(error => error ? reject(error) : accept()); server.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true });
}
