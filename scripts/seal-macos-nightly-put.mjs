import { createHash, createHmac, constants, publicEncrypt } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [archive, envelope] = process.argv.slice(2);
const version = '0.2.2-rc.1.20261125.2';
const releaseDigest = 'b9b04f2a22ae03838acb7203da08d5df3c64b4d5c222a840ac203bd94e3e5769';
const object = `studio/${version}/AgentKit-Studio-mac-arm64.zip`;
const origin = 'https://agentkit.ks3-cn-beijing.ksyuncs.com';
const minVersion = '0.2.2-rc.1.20261124.1';
if (!archive || basename(archive) !== `deepseek-harness-${version}-mac-arm64.zip` || !envelope) throw new Error('Only the exact signed nightly ZIP is eligible');

const file = new URL(object, origin);
const head = await fetch(file, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) });
if (head.status !== 404) throw new Error(`Expected a missing versioned KS3 ZIP, HTTP ${head.status}`);
const feed = await fetch(new URL('studio/feeds/mac-arm64/nightly-mac.yml', origin), { redirect: 'error', signal: AbortSignal.timeout(30000) });
if (!feed.ok) throw new Error('Unable to check the current macOS Nightly manifest');
if (!(await feed.text()).split('\n').includes(`version: ${minVersion}`)) throw new Error('macOS Nightly has changed since source qualification');

const { size } = await stat(archive);
const md5 = createHash('md5');
const sha256 = createHash('sha256');
for await (const bytes of createReadStream(archive)) { md5.update(bytes); sha256.update(bytes); }
if (size !== 516254219 || sha256.digest('hex') !== releaseDigest) throw new Error('The exact signed archive is required');
const contentMd5 = md5.digest('base64');
const date = new Date().toUTCString();
const accessKey = process.env.STUDIO_DOWNLOAD_PROD_KS3_ACCESS_KEY;
const secretKey = process.env.STUDIO_DOWNLOAD_PROD_KS3_SECRET_KEY;
if (!accessKey || !secretKey) throw new Error('The protected publishing environment has no KS3 credentials');
const canonical = [
  'PUT', contentMd5, 'application/zip', date, 'x-kss-acl:public-read',
  'x-kss-forbid-overwrite:true', `/agentkit/${object}`,
].join('\n');
const authorization = `KSS ${accessKey}:${createHmac('sha1', secretKey).update(canonical).digest('base64')}`;
const key = await readFile(new URL('studio-nightly-uploader.pub.pem', import.meta.url));
const sealed = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  Buffer.from(JSON.stringify({ date, authorization, contentMd5 })));
await writeFile(envelope, sealed, { mode: 0o600 });
console.log('Prepared an encrypted request for one exact, non-overwriting publication object.');
