import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

const [archive] = process.argv.slice(2);
const version = '0.2.2-rc.1.20261125.2';
const target = `studio/${version}/AgentKit-Studio-mac-arm64.zip`;
const origin = 'https://agentkit.ks3-cn-beijing.ksyuncs.com';
const bucket = 'agentkit';
const acl = 'public-read';
const contentType = 'application/zip';
if (!archive || basename(archive) !== `deepseek-harness-${version}-mac-arm64.zip`) {
  throw new Error('Expected the signed nightly candidate ZIP');
}
const { size } = await stat(archive);
const md5 = createHash('md5');
for await (const chunk of createReadStream(archive)) md5.update(chunk);
const contentMd5 = md5.digest('base64');

const url = new URL(target, origin);
const existing = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) });
if (existing.ok) {
  if (Number(existing.headers.get('content-length')) !== size) throw new Error('Unexpected size at the immutable KS3 path');
  console.log('The versioned ZIP already exists. The release uploader will verify its checksum.');
} else {
  if (existing.status !== 404) throw new Error(`Versioned ZIP HEAD failed with HTTP ${existing.status}`);
  const accessKey = process.env.STUDIO_DOWNLOAD_PROD_KS3_ACCESS_KEY;
  const secretKey = process.env.STUDIO_DOWNLOAD_PROD_KS3_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('Configured KS3 publication credentials are unavailable');
  const date = new Date().toUTCString();
  const canonical = [
    'PUT', contentMd5, contentType, date, `x-kss-acl:${acl}`,
    'x-kss-forbid-overwrite:true', `/${bucket}/${target}`,
  ].join('\n');
  const authorization = `KSS ${accessKey}:${createHmac('sha1', secretKey).update(canonical).digest('base64')}`;
  const client = spawn('/usr/bin/curl', [
    '--config', '-', '--proto', '=https', '--http1.1', '--max-time', '600',
    '--silent', '--fail-with-body', '--write-out', '\n%{http_code}',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  const headers = {
    Date: date, Authorization: authorization, 'Content-MD5': contentMd5, 'Content-Type': contentType,
    'Content-Length': String(size), 'x-kss-acl': acl, 'x-kss-forbid-overwrite': 'true',
  };
  const lines = [
    `url = ${JSON.stringify(url.toString())}`,
    `upload-file = ${JSON.stringify(archive)}`,
    ...Object.entries(headers).map(([name, value]) => `header = ${JSON.stringify(`${name}: ${value}`)}`),
  ];
  let response = '';
  client.stdout.setEncoding('utf8').on('data', chunk => { response = (response + chunk).slice(-16_384); });
  const completed = new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('close', resolve);
  });
  client.stdin.end(lines.join('\n') + '\n');
  const status = await completed;
  const httpStatus = response.match(/\n(\d{3})$/)?.[1] || 'unknown';
  const errorCode = response.match(/<Code>([A-Za-z0-9_]{1,60})<\/Code>/)?.[1] || 'unavailable';
  if (status !== 0 && httpStatus !== '409') throw new Error(`KS3 ZIP upload failed. curl=${status}, HTTP=${httpStatus}, code=${errorCode}`);
  console.log(`KS3 immutable ZIP upload returned HTTP ${httpStatus}. The release uploader will validate the public bytes.`);
}
