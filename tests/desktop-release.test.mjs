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
  const result = await run(process.execPath, ['scripts/desktop-release.mjs', 'verify-feed', '--origin', origin, '--allow-loopback', '--channel', 'preview', '--version', version, '--output', output], { cwd: root })
  assert.match(result.stdout, /desktop feed verified/)
  const evidence = JSON.parse(await readFile(join(output, `feed-preview-${version}.json`), 'utf8'))
  assert.equal(evidence.range.status, 206)
  assert.equal(evidence.zipSha512, sha512)
})

test('desktop feed verifier rejects example origins before network access', async () => {
  await assert.rejects(run(process.execPath, ['scripts/desktop-release.mjs', 'verify-feed', '--origin', 'https://updates.example.com', '--channel', 'preview', '--version', '0.2.0-rc.2.20261012.1'], { cwd: root }), /example domain/)
})
