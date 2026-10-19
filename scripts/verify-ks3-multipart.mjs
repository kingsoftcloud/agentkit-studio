/** Qualify the publisher's actual network/credentials before changing a feed. */
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { resolveKs3OriginCredentials } from '../src/ks3-release-store.mjs';
import { uploadKs3Multipart } from '../src/ks3-release-multipart.mjs';

const { values } = parseArgs({ options: { origin: { type: 'string' }, output: { type: 'string' } } });
const origin = values.origin;
if (!origin || !values.output) throw new Error('--origin and --output are required');
const parsed = new URL(origin);
if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('probe requires a plain HTTPS release origin');
const credentials = resolveKs3OriginCredentials(process.env, origin);
const directory = await mkdtemp(join(tmpdir(), 'studio-ks3-probe-'));
const bytes = randomBytes(11 * 1024 * 1024);
const path = join(directory, 'probe.bin');
const objectKey = `dsh-desk/bin/mac-arm64/ks3-multipart-probe-${randomUUID()}.bin`;
const url = new URL(objectKey, origin);
const started = Date.now();
let created = false;
let report;
try {
  await writeFile(path, bytes, { mode: 0o600 });
  const upload = await uploadKs3Multipart({ ...credentials, url, objectKey, path, size: bytes.length, contentType: 'application/octet-stream',
    onProgress: event => console.log(`KS3 real probe: ${event.completedParts}/${event.totalParts} parts`) });
  created = true;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`KS3 probe public download failed: ${response.status}`);
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (!downloaded.equals(bytes)) throw new Error('KS3 real multipart probe bytes differ');
  report = { accepted: true, realKs3: true, origin, objectKey, bytes: bytes.length, ...upload,
    sha256: createHash('sha256').update(bytes).digest('hex'), elapsedMs: Date.now() - started };
  // Record success only after the public probe object is removed below.
} finally {
  try {
    if (created) {
      const date = new Date().toUTCString();
      const canonical = `DELETE\n\n\n${date}\n/${credentials.bucket}/${objectKey}`;
      const authorization = `KSS ${credentials.accessKey}:${createHmac('sha1', credentials.secretKey).update(canonical).digest('base64')}`;
      const removed = await fetch(url, { method: 'DELETE', headers: { Date: date, Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(300_000) });
      await removed.body?.cancel();
      if (!removed.ok) throw new Error(`KS3 probe cleanup failed: ${removed.status}`);
      if (report) {
        await mkdir(dirname(values.output), { recursive: true });
        await writeFile(values.output, JSON.stringify({ ...report, cleanedUp: true }, null, 2) + '\n', { mode: 0o600 });
        console.log('KS3 real multipart probe accepted and cleaned up.');
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
