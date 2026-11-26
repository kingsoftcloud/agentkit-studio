import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const version = '0.2.2-rc.1.20261125.2';
const repo = 'kingsoftcloud/agentkit-studio';
const target = `studio/${version}/AgentKit-Studio-mac-arm64.zip`;
const url = new URL(target, 'https://agentkit.ks3-cn-beijing.ksyuncs.com');
const [archive] = process.argv.slice(2);

async function head(url) {
  return fetch(url, { method: 'HEAD', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
}

async function main() {
  if (!archive || basename(archive) !== `deepseek-harness-${version}-mac-arm64.zip`) throw new Error('Unexpected candidate ZIP');
  const { size } = await stat(archive);
  const initial = await head(url);
  if (initial.ok) {
    if (Number(initial.headers.get('content-length')) !== size) throw new Error('Existing KS3 ZIP has unexpected size');
    return;
  }
  if (initial.status !== 404) throw new Error(`KS3 ZIP HEAD returned HTTP ${initial.status}`);
  const artifact = process.env.SOURCE_ARTIFACT_ID;
  const token = process.env.GH_TOKEN;
  const accessKey = process.env.STUDIO_DOWNLOAD_PROD_KS3_ACCESS_KEY;
  const secretKey = process.env.STUDIO_DOWNLOAD_PROD_KS3_SECRET_KEY;
  if (!/^[0-9]+$/.test(artifact || '') || !token || !accessKey || !secretKey) throw new Error('Missing authorized publication inputs');

  const md5 = createHash('md5');
  for await (const chunk of createReadStream(archive)) md5.update(chunk);
  const contentMd5 = md5.digest('base64');
  const download = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${artifact}/zip`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'manual', signal: AbortSignal.timeout(30000),
  });
  const location = download.headers.get('location');
  if (download.status !== 302 || !location) throw new Error(`Raw artifact redirect returned HTTP ${download.status}`);
  const source = new URL(location);
  if (source.protocol !== 'https:' || source.username || source.password || !source.hostname.endsWith('.blob.core.windows.net')) {
    throw new Error('Artifact redirect is outside the GitHub Actions cloud storage endpoint');
  }
  const raw = await head(source);
  if (!raw.ok || Number(raw.headers.get('content-length')) !== size) {
    throw new Error(`Artifact download did not expose the exact raw ZIP length. HTTP ${raw.status}`);
  }

  const date = new Date().toUTCString();
  const sourceHeader = encodeURIComponent(source.href);
  const canonical = [
    'PUT', contentMd5, '', date, 'x-kss-acl:public-read', `x-kss-sourceurl:${sourceHeader}`, `/agentkit/${target}?fetch`,
  ].join('\n');
  const authorization = `KSS ${accessKey}:${createHmac('sha1', secretKey).update(canonical).digest('base64')}`;
  const accepted = await fetch(new URL('?fetch', url), {
    method: 'PUT', headers: { Date: date, Authorization: authorization, 'Content-MD5': contentMd5,
      'x-kss-acl': 'public-read', 'x-kss-sourceurl': sourceHeader },
    redirect: 'error', signal: AbortSignal.timeout(60000),
  });
  const code = (await accepted.text()).match(/<Code>([A-Za-z0-9_]{1,60})<\/Code>/)?.[1];
  if (!accepted.ok || code) throw new Error(`KS3 import returned HTTP ${accepted.status} (${code ?? 'no error code'})`);
  console.log('KS3 accepted the exact signed ZIP import. Waiting for the public versioned object.');
  for (let attempt = 0; attempt < 48; attempt++) {
    await setTimeout(5000);
    const remote = await head(url);
    if (remote.ok && Number(remote.headers.get('content-length')) === size) {
      console.log('Imported ZIP has the expected size. The release uploader will verify its digest.');
      return;
    }
    if (remote.ok || remote.status !== 404) throw new Error(`Unexpected imported ZIP response. HTTP ${remote.status}`);
  }
  throw new Error('KS3 accepted the import without exposing the object before the wait expired');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'KS3 ZIP import failed');
  process.exitCode = 1;
});
