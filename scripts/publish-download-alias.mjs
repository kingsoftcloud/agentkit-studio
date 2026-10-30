#!/usr/bin/env node
/** Refresh the stable studio/latest download alias from the published update feeds.
 *
 * The site links to fixed studio/latest/<file> URLs, and latest.json carries the
 * version metadata, so a new release only re-runs this command instead of editing
 * the page. Objects are copied inside KS3, so no release bytes travel through the
 * operator machine.
 */
import { createHash, createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { createGlobalConfiguration } from '../src/global-config.mjs';

const { values } = parseArgs({ options: {
  origin: { type: 'string' },
  bucket: { type: 'string' },
  region: { type: 'string' },
  channel: { type: 'string' },
} });
const origin = new URL(values.origin ?? 'https://agentkit.ks3-cn-beijing.ksyuncs.com');
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.username || origin.password) throw new Error('--origin must be a bare HTTPS origin');
const fromEnvironment = (...names) => names.map(name => process.env[name]).find(Boolean) ?? '';
const bucket = values.bucket || fromEnvironment('STUDIO_DOWNLOAD_PROD_KS3_BUCKET') || 'agentkit';
const region = values.region ?? 'cn-beijing';
const channel = values.channel ?? 'preview';
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !/^cn-(?:beijing|shanghai|guangzhou|ningbo|qinghai|qingyang)$/.test(region)) throw new Error('invalid bucket or region');
if (!['preview', 'stable'].includes(channel)) throw new Error('--channel must be preview or stable');

const ALIAS = 'studio/latest/';
// The Host configuration wins locally; the release workflows pass the bucket
// credentials as STUDIO_DOWNLOAD_PROD_KS3_* secrets instead.
let configuration = {};
try { ({ values: configuration } = await createGlobalConfiguration().resolve()); } catch {}
const credentials = {
  cloudAccessKey: configuration.cloudAccessKey || fromEnvironment('KSYUN_ACCESS_KEY', 'STUDIO_DOWNLOAD_PROD_KS3_ACCESS_KEY'),
  cloudSecretKey: configuration.cloudSecretKey || fromEnvironment('KSYUN_SECRET_KEY', 'STUDIO_DOWNLOAD_PROD_KS3_SECRET_KEY'),
};
if (!credentials.cloudAccessKey || !credentials.cloudSecretKey) throw new Error('KS3 credentials are missing from the Host configuration and the environment');

async function request(method, key, { body, contentType, headers: extra = {} } = {}) {
  const headers = { date: new Date().toUTCString(), ...extra };
  if (contentType) headers['content-type'] = contentType;
  if (body) {
    headers['content-length'] = String(body.length);
    headers['content-md5'] = createHash('md5').update(body).digest('base64');
  }
  const canonical = Object.keys(headers).filter(name => name.startsWith('x-kss-')).sort().map(name => `${name}:${headers[name]}\n`).join('');
  const message = `${method}\n${headers['content-md5'] ?? ''}\n${headers['content-type'] ?? ''}\n${headers.date}\n${canonical}/${bucket}/${key}`;
  headers.authorization = `KSS ${credentials.cloudAccessKey}:${createHmac('sha1', credentials.cloudSecretKey).update(message).digest('base64')}`;
  return fetch(`${origin.origin}/${key}`, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(120000) });
}

async function status(key) {
  const response = await request('HEAD', key);
  await response.body?.cancel();
  return response.status;
}

async function copy(sourceKey, key, expectedBytes) {
  // KS3 answers ObjectAlreayExists instead of overwriting on server-side copy,
  // so a refresh has to remove the previous alias object first.
  const existing = await status(key);
  if (existing !== 404 && existing !== 200) throw new Error(`cannot inspect ${key} (${existing})`);
  if (existing === 200) {
    const removed = await request('DELETE', key);
    await removed.body?.cancel();
    if (!removed.ok && removed.status !== 404) throw new Error(`remove ${key} failed (${removed.status})`);
  }
  const response = await request('PUT', key, {
    headers: { 'content-type': 'application/octet-stream', 'x-kss-copy-source': `/${bucket}/${sourceKey}`, 'x-kss-acl': 'public-read', 'cache-control': 'no-cache' },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`copy ${sourceKey} -> ${key} failed (${response.status}): ${body.slice(0, 200)}`);
  const head = await request('HEAD', key);
  await head.body?.cancel();
  const bytes = Number(head.headers.get('content-length'));
  if (expectedBytes !== undefined && bytes !== expectedBytes) throw new Error(`copied ${key} is ${bytes} bytes, expected ${expectedBytes}`);
  return { key, bytes };
}

async function put(key, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2));
  const response = await request('PUT', key, { body, contentType: 'application/json', headers: { 'x-kss-acl': 'public-read', 'cache-control': 'no-cache' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`upload ${key} failed (${response.status}): ${text.slice(0, 200)}`);
  return { key, bytes: body.length };
}

async function feed(path) {
  const response = await fetch(`${origin.origin}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`feed ${path} is unavailable (${response.status})`); }
  return YAML.parse(await response.text());
}

async function publishPlatform(entry, { diskImage = false } = {}) {
  const file = entry.files?.[0];
  const url = new URL(file?.url ?? '');
  if (url.origin !== origin.origin || !url.pathname.startsWith('/studio/')) throw new Error(`feed URL escapes the Studio origin: ${String(file?.url)}`);
  const sourceKey = url.pathname.slice(1);
  const name = sourceKey.split('/').pop();
  const copied = await copy(sourceKey, `${ALIAS}${name}`, file.size);
  let blockmap;
  if (await status(`${sourceKey}.blockmap`) === 200) blockmap = (await copy(`${sourceKey}.blockmap`, `${ALIAS}${name}.blockmap`)).key;
  let image;
  if (diskImage) {
    const dmgKey = sourceKey.replace(/\.zip$/u, '.dmg');
    if (await status(dmgKey) === 200) image = (await copy(dmgKey, `${ALIAS}${dmgKey.split('/').pop()}`)).key;
  }
  return { version: entry.version, releaseDate: entry.releaseDate, file: copied.key, bytes: copied.bytes, sha512: file.sha512, blockmap, image };
}

const mac = await publishPlatform(await feed(`studio/feeds/mac-arm64/${channel}-mac.yml`), { diskImage: true });
const win = await publishPlatform(await feed(`studio/feeds/win-x64/${channel}.yml`));
const latest = {
  schemaVersion: 1,
  channel,
  publishedAt: new Date().toISOString(),
  origin: origin.origin,
  mac: { version: mac.version, releaseDate: mac.releaseDate, url: `${origin.origin}/${mac.file}`, bytes: mac.bytes, sha512: mac.sha512, blockmap: mac.blockmap ? `${origin.origin}/${mac.blockmap}` : undefined, dmg: mac.image ? `${origin.origin}/${mac.image}` : undefined },
  win: { version: win.version, releaseDate: win.releaseDate, url: `${origin.origin}/${win.file}`, bytes: win.bytes, sha512: win.sha512, blockmap: win.blockmap ? `${origin.origin}/${win.blockmap}` : undefined },
};
await put(`${ALIAS}latest.json`, latest);
const published = await fetch(`${origin.origin}/${ALIAS}latest.json`, { redirect: 'error' });
if (!published.ok) throw new Error(`published alias is unreadable (${published.status})`);
const echoed = await published.json();
if (echoed.mac?.version !== mac.version || echoed.win?.version !== win.version) throw new Error('published alias does not echo the feed versions');
console.log(JSON.stringify({ stage: 'alias-updated', channel, mac: latest.mac, win: latest.win }, null, 2));
