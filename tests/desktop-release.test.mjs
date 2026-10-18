import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const run = promisify(execFile)
const root = new URL('..', import.meta.url).pathname

test('desktop feed verifier checks public bytes and HTTP ranges', async t => {
  const version = '0.2.0-rc.2.20261012.1'
  const zipName = `deepseek-harness-${version}-mac-arm64.zip`
  const bytes = Buffer.from('signed zip bytes used by the feed verifier\n')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  let feed = Buffer.from(`version: ${version}\npath: https://127.0.0.1/binary/${zipName}\nsha512: ${sha512}\nfiles:\n  - url: http://127.0.0.1:PORT/dsh-desk/bin/mac-arm64/${zipName}\n    size: ${bytes.length}\n    sha512: ${sha512}\n`)
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    const isFeed = path.endsWith('/preview-mac.yml')
    const isZip = path.endsWith(`/${zipName}`)
    if (!isFeed && !isZip) { response.writeHead(404); response.end(); return }
    const body = isFeed ? feed : bytes
    if (request.method === 'HEAD') { response.writeHead(200, { 'content-length': body.length, 'accept-ranges': 'bytes' }); response.end(); return }
    const range = request.headers.range
    if (isZip && range === 'bytes=0-0') { response.writeHead(206, { 'content-length': 1, 'content-range': `bytes 0-0/${body.length}`, 'accept-ranges': 'bytes' }); response.end(body.subarray(0, 1)); return }
    response.writeHead(200, { 'content-length': body.length, 'accept-ranges': 'bytes' }); response.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  feed = Buffer.from(feed.toString('utf8').replaceAll('PORT', String(address.port)))
  const output = await mkdtemp(join(tmpdir(), 'studio-feed-'))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }) })
  const result = await run(process.execPath, ['scripts/desktop-release.mjs', 'verify-feed', '--origin', origin, '--layout', 'legacy', '--allow-loopback', '--channel', 'preview', '--version', version, '--output', output], { cwd: root })
  assert.match(result.stdout, /desktop feed verified/)
  const evidence = JSON.parse(await readFile(join(output, `feed-preview-${version}.json`), 'utf8'))
  assert.equal(evidence.range.status, 206)
  assert.equal(evidence.zipSha512, sha512)
})

test('desktop feed verifier rejects example origins before network access', async () => {
  await assert.rejects(run(process.execPath, ['scripts/desktop-release.mjs', 'verify-feed', '--origin', 'https://updates.example.com', '--channel', 'preview', '--version', '0.2.0-rc.2.20261012.1'], { cwd: root }), /example domain/)
})

// The App embeds this path. An intact compatibility feed must not hide a missing
// canonical feed, including when both buckets contain the same ZIP bytes.
test('Studio verifier requests the packaged canonical feed and rejects a legacy-only publication', async t => {
  const version = '0.2.1-rc.2.20261018.3';
  const bytes = Buffer.from('canonical Studio ZIP');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const requests = []; let canonical = true; let origin;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith('/preview-mac.yml')) {
      if (request.url.startsWith('/studio/') && !canonical) { response.writeHead(404); response.end(); return; }
      const body = `version: ${version}\nfiles:\n  - url: ${origin}/studio/${version}/AgentKit-Studio-mac-arm64.zip\n    size: ${bytes.length}\n    sha512: ${sha512}\n`;
      response.writeHead(200); response.end(body); return;
    }
    if (request.url !== `/studio/${version}/AgentKit-Studio-mac-arm64.zip`) { response.writeHead(404); response.end(); return; }
    if (request.headers.range) { response.writeHead(206, { 'accept-ranges': 'bytes', 'content-range': `bytes 0-0/${bytes.length}` }); response.end(bytes.subarray(0, 1)); return; }
    response.writeHead(200, { 'content-length': bytes.length }); response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const output = await mkdtemp(join(tmpdir(), 'studio-canonical-feed-'));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); });
  const args = ['scripts/desktop-release.mjs', 'verify-feed', '--origin', origin, '--allow-loopback', '--channel', 'preview', '--version', version, '--output', output];
  await run(process.execPath, args, { cwd: root });
  const report = JSON.parse(await readFile(join(output, `feed-preview-${version}.json`)));
  assert.equal(report.feedUrl, `${origin}/studio/feeds/mac-arm64/preview-mac.yml`);
  assert.equal(report.layout, 'studio');
  assert.ok(!requests.some(path => path.startsWith('/dsh-desk/')));
  canonical = false;
  await assert.rejects(run(process.execPath, args, { cwd: root }), /404/);
});
