import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createKsxcReleases } from '../src/host/services/ksxc-releases.mjs';

const run = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const KS3 = 'https://ks3-cn-beijing.ksyuncs.com/fe-frame/kscc/ksxc';
const archiveUrl = (version, platform = 'mac-arm64') => `${KS3}/${version}/ksxc-${platform}-${version}.tar.gz`;
const GATEWAY = 'http://mgw.example.test/cli/release/current-version?client=ksxc';
const offline = () => new TypeError('fetch failed');
const notFound = { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
const gatewayNaming = version => ({ ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ code: 200, data: version }), json: async () => ({ code: 200, data: version }) });

// Stands in for the KSXC payload: it answers --version and the initialize
// handshake that probeKsxcPayload() requires before a release is accepted.
const fakePayload = version => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "ksxc ${version}"; exit 0; fi
IFS= read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"1"}}'
cat > /dev/null
`;

async function archiveFor(directory, version, executableName = 'codex', platform = 'mac-arm64') {
  const payload = join(directory, `release-${version}`);
  await mkdir(join(payload, 'bin'), { recursive: true });
  const executable = join(payload, 'bin', executableName);
  await writeFile(executable, fakePayload(version));
  await chmod(executable, 0o755);
  await writeFile(join(payload, 'codex-package.json'), '{}');
  const archive = join(directory, `ksxc-${platform}-${version}.tar.gz`);
  // COPYFILE_DISABLE keeps macOS from adding AppleDouble entries to the fixture.
  await run('tar', ['-czf', archive, '-C', payload, 'bin', 'codex-package.json'],
    { env: { PATH: process.env.PATH, COPYFILE_DISABLE: '1' } });
  const bytes = await readFile(archive);
  return { version, archive, bytes, digest: sha256(bytes), executable: sha256(fakePayload(version)) };
}

/** Serves the company gateway, the KS3 sidecar and the archive from in-memory releases. */
function releaseServer({ releases = {}, gateway = gatewayNaming('1.8.0'), sidecar = 'valid', drop = 'never', platform = 'mac-arm64' } = {}) {
  const requests = [];
  const downloads = { count: 0 };
  // The service hands fetchImpl a URL object, not a string.
  const fetchImpl = async address => {
    const url = String(address);
    requests.push(url);
    if (url === GATEWAY) {
      if (gateway instanceof Error) throw gateway;
      return gateway;
    }
    const item = Object.values(releases).find(release => archiveUrl(release.version, platform) === url.replace(/\.sha256$/, ''));
    if (url.endsWith('.sha256')) {
      if (sidecar === 'missing' || !item) return notFound;
      const text = sidecar === 'malformed' ? 'checksum unavailable'
        : `${sidecar === 'tampered' ? '0'.repeat(64) : item.digest}  ksxc-${platform}-${item.version}.tar.gz`;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => text };
    }
    if (!item) return notFound;
    downloads.count += 1;
    const dropped = drop === 'always' || drop === 'first' && downloads.count === 1;
    const bytes = dropped ? item.bytes.subarray(0, 1024) : item.bytes;
    return { ok: true, status: 200, headers: { get: name => name === 'content-length' ? String(item.bytes.length) : null },
      // A dropped connection ends the body early instead of rejecting the request.
      body: (async function* () { yield bytes; if (dropped) throw new TypeError('terminated'); })() };
  };
  return { fetchImpl, requests, downloads };
}

async function fixture(t, { server: serverOptions = {}, ...instanceOptions } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ksxc-releases-')));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const companyConfigPath = join(dir, 'company.json');
  await writeFile(companyConfigPath, JSON.stringify({ baseUrl: 'http://mgw.example.test', code: 'kc',
    installerUrl: 'https://ks3-cn-beijing.ksyuncs.com/fe-frame/install.sh' }));
  const root = join(dir, 'store');
  // A Windows target carries `codex.exe`; the archive fixture has to match it.
  const executableName = instanceOptions.executableName ?? 'codex';
  const platform = instanceOptions.target?.startsWith('win32-') ? 'win-x64' : 'mac-arm64';
  const first = await archiveFor(dir, '1.8.0', executableName, platform);
  const create = (releases = { '1.8.0': first }, server = {}, options = {}) => {
    const served = releaseServer({ releases, platform, ...server });
    return { server: served, releases: createKsxcReleases({ target: 'darwin-arm64', tarPath: 'tar', ...options,
      root, companyConfigPath, fetchImpl: served.fetchImpl }) };
  };
  const shared = create({ '1.8.0': first }, serverOptions, instanceOptions);
  return { dir, root, companyConfigPath, create, first, second: () => archiveFor(dir, '1.9.0', executableName, platform),
    server: shared.server, releases: shared.releases, versions: join(root, 'versions'), executableName,
    active: () => readFile(join(root, 'active.json'), 'utf8').then(JSON.parse) };
}

async function settle(releases, requestId) {
  for (let i = 0; i < 600; i += 1) {
    const job = releases.installStatus(requestId);
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Installation did not finish');
}

test('without a company config nothing is installable and no request is made', async t => {
  const { root } = await fixture(t);
  const releases = createKsxcReleases({ root, fetchImpl: async () => assert.fail('no request') });
  assert.deepEqual(await releases.status({ refresh: true }), { active: null, previous: null, enabled: false, ready: false,
    target: `${process.platform}-${process.arch}`, versions: [], installable: false });
});

test('status refreshes on demand, caches the latest release and marks the target installable', async t => {
  const { releases, root, server, first } = await fixture(t);
  assert.deepEqual((await releases.status()).versions, [], 'status() alone must not reach the network');
  assert.equal(server.requests.length, 0);
  const status = await releases.status({ refresh: true });
  assert.deepEqual(status.versions, ['1.8.0']);
  assert.equal(status.installable, true);
  assert.equal(status.ready, false);
  const cached = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8'));
  assert.equal(cached.schema, 'agentkit.ksxc.latest/v1');
  assert.equal(cached.target, 'darwin-arm64');
  assert.deepEqual(cached.release, { version: '1.8.0', archive: archiveUrl('1.8.0'), archiveSha256: first.digest });
});

test('an installed payload starts a session without any network request', async t => {
  const f = await fixture(t);
  await f.releases.activate('1.8.0');
  const downloads = f.server.downloads.count;
  const quiet = createKsxcReleases({ root: f.root, companyConfigPath: f.companyConfigPath, target: 'darwin-arm64',
    fetchImpl: async () => assert.fail('no request') });
  assert.equal((await quiet.command()).version, '1.8.0');
  const status = await quiet.status();
  assert.equal(status.ready, true);
  assert.deepEqual(status.versions, ['1.8.0']);
  assert.equal(f.server.downloads.count, downloads);
});

test('a missing, damaged or foreign-platform cache counts as no cache', async t => {
  const { releases, root } = await fixture(t);
  const damaged = ['not json', JSON.stringify({ schema: 'agentkit.ksxc.latest/v1', target: 'win32-x64',
    release: { version: '1.9.0', archive: archiveUrl('1.9.0'), archiveSha256: 'a'.repeat(64) } })];
  for (const content of damaged) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'latest.json'), content);
    assert.deepEqual((await releases.status()).versions, []);
  }
});

test('gateway failures are unreachable and leave an existing cache untouched', async t => {
  const { root, create } = await fixture(t);
  const { releases } = create();
  await releases.refresh();
  const cached = await readFile(join(root, 'latest.json'), 'utf8');
  for (const gateway of [offline(), notFound]) {
    const { releases: failing } = create(undefined, { gateway });
    await assert.rejects(failing.refresh(), { code: 'KSXC_RELEASES_UNREACHABLE' });
    assert.equal(await readFile(join(root, 'latest.json'), 'utf8'), cached);
  }
});

test('a missing archive sidecar is unreachable', async t => {
  const { releases } = await fixture(t, { server: { sidecar: 'missing' } });
  await assert.rejects(releases.refresh(), { code: 'KSXC_RELEASES_UNREACHABLE' });
});

test('an invalid version, body or sidecar digest is invalid', async t => {
  const brokenBody = { ok: true, status: 200, headers: { get: () => null }, text: async () => 'not json',
    json: async () => { throw new SyntaxError('Unexpected token'); } };
  for (const server of [{ gateway: gatewayNaming('../etc') }, { gateway: brokenBody }, { sidecar: 'malformed' }]) {
    const { releases } = await fixture(t, { server });
    await assert.rejects(releases.refresh(), { code: 'KSXC_RELEASE_INVALID' });
  }
});

test('one click installs and enables the latest release on a fresh machine', async t => {
  const { releases, versions, active, first } = await fixture(t);
  await assert.rejects(readdir(versions), { code: 'ENOENT' }, 'versions/ must not have to exist beforehand');
  const { requestId } = releases.startInstall('1.8.0');
  const job = await settle(releases, requestId);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.phase, 'done');
  assert.deepEqual(await active(), { active: '1.8.0', previous: null, enabled: true });
  assert.equal(await readFile(join(versions, '1.8.0', '.executable.sha256'), 'utf8'), first.executable);
  assert.equal((await releases.status()).ready, true);
  assert.deepEqual(await readdir(versions), ['1.8.0']);
});

test('activate installs a release that has no recorded executable digest', async t => {
  const { releases, versions } = await fixture(t);
  await releases.refresh();
  await releases.activate('1.8.0');
  assert.equal((await releases.status()).ready, true);
  assert.ok((await readdir(versions)).includes('1.8.0'));
});

test('progress covers download, extract and probe', async t => {
  const { releases } = await fixture(t);
  const events = [];
  await releases.activate('1.8.0', progress => events.push(progress));
  const phases = events.map(event => event.phase);
  assert.equal(phases[0], 'download');
  assert.ok(phases.indexOf('extract') < phases.indexOf('probe'), 'extract must be reported before probe');
  const sizes = events.filter(event => event.phase === 'download').map(event => event.receivedBytes);
  assert.ok(sizes.at(-1) > sizes[0], 'download progress must advance');
});

test('an archive digest mismatch fails without a retry and leaves no residue', async t => {
  const { releases, versions, server } = await fixture(t, { server: { sidecar: 'tampered' } });
  const { requestId } = releases.startInstall('1.8.0');
  const job = await settle(releases, requestId);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'KSXC_PAYLOAD_INTEGRITY_FAILED');
  assert.equal(server.downloads.count, 1);
  assert.deepEqual(await readdir(versions), []);
});

test('a dropped download is retried once and the retry is reported', async t => {
  const { releases, server } = await fixture(t, { server: { drop: 'first' } });
  const events = [];
  await releases.activate('1.8.0', progress => events.push(progress));
  assert.equal(server.downloads.count, 2);
  assert.ok(events.some(event => event.retrying === true));
  assert.equal(events.filter(event => event.phase === 'download').at(-1).retrying, false);
});

test('a download that drops twice is unreachable', async t => {
  const { releases, server } = await fixture(t, { server: { drop: 'always' } });
  const { requestId } = releases.startInstall('1.8.0');
  const job = await settle(releases, requestId);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'KSXC_RELEASES_UNREACHABLE');
  assert.equal(server.downloads.count, 2);
});

test('a full disk fails before the download starts', async t => {
  const { releases, server } = await fixture(t, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  const { requestId } = releases.startInstall('1.8.0');
  const job = await settle(releases, requestId);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'KSXC_DISK_SPACE');
  assert.equal(server.downloads.count, 0);
});

test('clicking install twice downloads the archive once', async t => {
  const { releases, server } = await fixture(t);
  const first = releases.startInstall('1.8.0');
  const second = releases.startInstall('1.8.0');
  assert.equal((await settle(releases, first.requestId)).status, 'succeeded');
  assert.equal((await settle(releases, second.requestId)).status, 'succeeded');
  assert.equal(server.downloads.count, 1);
});

test('an interrupted installation leaves no staging directory behind', async t => {
  const { releases, versions } = await fixture(t);
  await mkdir(join(versions, '.install-stale'), { recursive: true });
  await writeFile(join(versions, '.install-stale', 'partial'), 'x');
  await assert.rejects(releases.rollback(), { code: 'KSXC_NOT_INSTALLED' });
  assert.deepEqual(await readdir(versions), []);
});

test('an installed release stays ready when the gateway has moved on or is unreachable', async t => {
  const f = await fixture(t);
  await f.releases.activate('1.8.0');
  const moved = f.create({ '1.8.0': f.first, '1.9.0': await f.second() }, { gateway: gatewayNaming('1.9.0') });
  const status = await moved.releases.status({ refresh: true });
  assert.deepEqual(status.versions, ['1.9.0', '1.8.0']);
  assert.equal(status.ready, true);
  // The cached 1.9.0 keeps it listed; the installed 1.8.0 keeps it ready.
  const down = f.create({}, { gateway: offline() });
  const degraded = await down.releases.status({ refresh: true });
  assert.deepEqual(degraded.versions, ['1.9.0', '1.8.0']);
  assert.equal(degraded.ready, true);
});

test('a missing gateway on a fresh machine reports the failure instead of throwing', async t => {
  const { releases } = await fixture(t, { server: { gateway: offline() } });
  const status = await releases.status({ refresh: true });
  assert.deepEqual(status.versions, []);
  assert.equal(status.ready, false);
  assert.equal(status.catalogError, 'KSXC_RELEASES_UNREACHABLE');
  const { requestId } = releases.startInstall('1.8.0');
  const job = await settle(releases, requestId);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'KSXC_RELEASES_UNREACHABLE');
});

test('an installed release switches without needing its archive', async t => {
  const f = await fixture(t);
  await f.releases.activate('1.8.0');
  await rm(join(f.root, 'latest.json'));
  const moved = f.create({ '1.9.0': await f.second() }, { gateway: gatewayNaming('1.9.0') });
  await moved.releases.refresh();
  // 1.8.0 is installed and runnable, so the version picker must be able to select it
  // even though only the cached latest release carries an archive.
  const switched = await moved.releases.activate('1.8.0');
  assert.equal(switched.active, '1.8.0');
  assert.equal(switched.ready, true);
  assert.deepEqual(moved.server.downloads, { count: 0 });
});

test('a damaged local release without an archive reports that it cannot be reinstalled', async t => {
  const f = await fixture(t);
  await f.releases.activate('1.8.0');
  await rm(join(f.root, 'latest.json'));
  const moved = f.create({ '1.9.0': await f.second() }, { gateway: gatewayNaming('1.9.0') });
  await moved.releases.refresh();
  // The version directory still exists but its payload is gone, so nothing can run
  // and the cached latest release is the only archive in play.
  await rm(join(f.versions, '1.8.0', 'bin', 'codex'));
  await assert.rejects(moved.releases.activate('1.8.0'), { code: 'KSXC_RELEASE_UNAVAILABLE' });
});

test('active.json pointing at a deleted version is not ready and can be reinstalled', async t => {
  const { releases, versions } = await fixture(t);
  await releases.activate('1.8.0');
  await rm(join(versions, '1.8.0'), { recursive: true });
  const status = await releases.status();
  assert.equal(status.active, '1.8.0');
  assert.equal(status.ready, false);
  await releases.activate('1.8.0');
  assert.equal((await releases.status()).ready, true);
});

test('an unsupported platform is not installable', async t => {
  // KS3 publishes no Windows arm64 archive, so only x64 joins the matrix.
  const { releases } = await fixture(t, { target: 'win32-arm64' });
  assert.equal((await releases.status()).installable, false);
});

test('a Windows x64 target installs the .exe payload', async t => {
  // The fixture uses the runner's tar; a real Windows
  // Host resolves `%SystemRoot%\System32\tar.exe` on its own.
  const f = await fixture(t, { target: 'win32-x64', executableName: 'codex.exe' });
  const status = await f.releases.status({ refresh: true });
  assert.equal(status.installable, true);
  assert.deepEqual(status.versions, ['1.8.0']);
  const job = await settle(f.releases, f.releases.startInstall('1.8.0').requestId);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  // The recorded digest is the .exe the archive carried, not the POSIX name.
  assert.equal(await readFile(join(f.versions, '1.8.0', '.executable.sha256'), 'utf8'), sha256(fakePayload('1.8.0')));
  assert.equal((await f.releases.status()).ready, true);
});

test('a static lock stays authoritative and never reaches the network', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ksxc-releases-')));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const item = await archiveFor(dir, '1.8.0');
  const lock = join(dir, 'releases.json');
  await writeFile(lock, JSON.stringify({ schema: 'agentkit.ksxc.releases/v1', releases: [{ version: '1.8.0', target: 'darwin-arm64',
    protocolProfile: 'codex-app-server/v1', archive: item.archive, archiveSha256: item.digest, sha256: item.executable }] }));
  const companyConfigPath = join(dir, 'company.json');
  await writeFile(companyConfigPath, JSON.stringify({ baseUrl: 'http://mgw.example.test', code: 'kc',
    installerUrl: 'https://ks3-cn-beijing.ksyuncs.com/fe-frame/install.sh' }));
  const releases = createKsxcReleases({ root: join(dir, 'store'), lock, companyConfigPath, target: 'darwin-arm64', tarPath: 'tar',
    fetchImpl: async () => assert.fail('no request') });
  await releases.refresh();
  assert.deepEqual((await releases.status()).versions, ['1.8.0']);
  await releases.activate('1.8.0');
  assert.equal((await releases.status()).ready, true);
});

test('an unknown install request is reported', async t => {
  const { releases } = await fixture(t);
  assert.throws(() => releases.installStatus('nope'), { code: 'KSXC_INSTALL_UNKNOWN' });
});
