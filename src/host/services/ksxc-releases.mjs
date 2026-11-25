import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { KSXC_PROTOCOL_PROFILE, KsxcRuntimeError, readKsxcCompanyConfig, resolveKsxcCommand } from '../../providers/ksxc-command.mjs';
import { probeKsxcPayload } from '../../providers/ksxc-probe.mjs';

const runFile = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const unavailable = () => new KsxcRuntimeError('KSXC_RELEASES_UNAVAILABLE', '当前平台没有可安装的审定 KSXC 版本。');
const unreachable = () => new KsxcRuntimeError('KSXC_RELEASES_UNREACHABLE', '无法连接 KSXC 发布源，请检查网络后重试。');
const notInstalled = () => new KsxcRuntimeError('KSXC_NOT_INSTALLED', '请在 Studio 设置中安装并启用 KSXC。');
const invalid = () => new KsxcRuntimeError('KSXC_RELEASE_INVALID', '审定的 KSXC 版本配置无效。');
const noArchive = version => new KsxcRuntimeError('KSXC_RELEASE_UNAVAILABLE', `${version} 没有可下载的归档，请安装最新版本。`);
const noDisk = () => new KsxcRuntimeError('KSXC_DISK_SPACE', '磁盘可用空间不足，安装 KSXC 至少需要 1 GB。');

function sourceOf(value) {
  if (typeof value !== 'string') throw invalid();
  if (isAbsolute(value)) return { file: value };
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalid();
  return { url };
}

/** Version order: newest first, a pre-release sorts after its final release. */
function compareVersions(a, b) {
  const [aMain, aPre] = String(a).split('-');
  const [bMain, bPre] = String(b).split('-');
  const left = aMain.split('.').map(Number);
  const right = bMain.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff) return diff;
  }
  if (aPre && !bPre) return 1;
  if (!aPre && bPre) return -1;
  return String(bPre ?? '').localeCompare(String(aPre ?? ''));
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// The desktop Host ships the two macOS downloads and Windows x64. KS3 publishes
// no Windows arm64 archive, so that target stays out of the matrix.
const PLATFORMS = {
  'darwin-arm64': 'mac-arm64',
  'darwin-x64': 'mac-x64',
  'win32-x64': 'win-x64',
};
const KS3_ORIGIN = 'https://ks3-cn-beijing.ksyuncs.com';
const KS3_KEY_PREFIX = 'kscc/ksxc';
const DIGEST_FILE = '.executable.sha256';
const LATEST_SCHEMA = 'agentkit.ksxc.latest/v1';
const VERSION_TIMEOUT_MS = 15_000;
const MIN_FREE_BYTES = 1024 ** 3;

/** The payload entry point: the Windows archive carries `codex.exe`. */
const executableNameFor = target => (target.startsWith('win32-') ? 'codex.exe' : 'codex');

/** Windows 10 1803+ ships bsdtar as `tar.exe`; a POSIX host keeps the system tar. */
const tarPathFor = target => (target.startsWith('win32-')
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : '/usr/bin/tar');

/** bsdtar rejects the GNU-only `--no-same-owner`, and its PATH is the Windows one. */
const tarInvocationFor = (target, archive, payload) => (target.startsWith('win32-')
  ? { args: ['-xzf', archive, '-C', payload], env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', LANG: 'C' } }
  : { args: ['--no-same-owner', '-xzf', archive, '-C', payload], env: { PATH: '/usr/bin:/bin', LANG: 'C' } });

export function createKsxcReleases({ root, lock, companyConfigPath, fetchImpl = fetch,
  target = `${process.platform}-${process.arch}`,
  minFreeBytes = MIN_FREE_BYTES,
  // Injected so a POSIX host can exercise the Windows layout with its own tar.
  executableName = executableNameFor(target),
  tarPath = tarPathFor(target) }) {
  const stateFile = join(root, 'active.json');
  const latestFile = join(root, 'latest.json');
  const installed = join(root, 'versions');
  let queue = Promise.resolve();
  async function state() {
    let record;
    try { record = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { active: null, previous: null, enabled: false };
      throw invalid();
    }
    if (!versionPattern.test(record?.active) || (record.previous !== null && !versionPattern.test(record.previous))
      || typeof record.enabled !== 'boolean') throw invalid();
    return record;
  }
  // Never reaches the network: command() runs it before every session, so a
  // slow gateway must not delay a payload that is already installed.
  async function catalog() {
    if (lock) return staticCatalog();
    const local = (await localVersions()).map(version => ({ version, target, protocolProfile: KSXC_PROTOCOL_PROFILE, local: true }));
    // The same version can be both installed and the cached latest; keep the entry that carries an archive.
    const byVersion = new Map([...local, ...(await cachedLatest())].map(item => [item.version, item]));
    for (const item of byVersion.values()) {
      // Only a downloadable release needs a well-formed archive; a local release only runs.
      if (!item.local) sourceOf(item.archive);
    }
    const releases = [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version));
    // The cached archive pins archiveSha256; the executable digest exists only after installation.
    return Promise.all(releases.map(async release => ({ ...release, sha256: release.sha256 ?? await recordedDigest(release.version) })));
  }
  async function staticCatalog() {
    if (!isAbsolute(lock)) throw invalid();
    let document;
    try { document = JSON.parse(await readFile(lock, 'utf8')); } catch { throw invalid(); }
    if (document?.schema !== 'agentkit.ksxc.releases/v1' || !Array.isArray(document.releases)) throw invalid();
    const releases = document.releases.filter(item => item?.target === target);
    for (const item of releases) {
      if (!versionPattern.test(item.version) || !digestPattern.test(item.archiveSha256) || !digestPattern.test(item.sha256)
        || item.protocolProfile !== KSXC_PROTOCOL_PROFILE) throw invalid();
      sourceOf(item.archive);
    }
    if (new Set(releases.map(item => item.version)).size !== releases.length) throw invalid();
    return releases;
  }
  /** Fetch the latest release and cache it. A failure never touches an existing cache. */
  async function refresh() {
    if (lock) return;
    const latest = await fetchLatest();
    if (!latest) return;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const tmp = join(root, `.latest-${randomUUID()}.json`);
    try {
      await writeFile(tmp, JSON.stringify({ schema: LATEST_SCHEMA, target, release: latest, fetchedAt: Date.now() }),
        { mode: 0o600, flag: 'wx' });
      await rename(tmp, latestFile);
    } finally { await rm(tmp, { force: true }); }
  }
  /** The company gateway names the version; the KS3 sidecar pins the archive digest. */
  async function fetchLatest() {
    const platform = PLATFORMS[target];
    if (!companyConfigPath || !platform) return null;
    const company = await readKsxcCompanyConfig({ companyConfigPath });
    const base = company.baseUrl.replace(/\/+$/, '');
    const get = async (url, headers) => {
      let response;
      try {
        response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
      } catch { throw unreachable(); }
      if (!response.ok) throw unreachable();
      return response;
    };
    let data;
    const response = await get(`${base}/cli/release/current-version?client=ksxc`, { 'X-KSC-COMPANY-CODE': company.code });
    try { data = await response.json(); } catch { throw invalid(); }
    const version = data?.data;
    if (!versionPattern.test(String(version ?? ''))) throw invalid();
    const archive = `${KS3_ORIGIN}/fe-frame/${KS3_KEY_PREFIX}/${version}/ksxc-${platform}-${version}.tar.gz`;
    // The KS3 sidecar is `<sha256>  <filename>`; only the first field is the digest.
    const archiveSha256 = (await (await get(`${archive}.sha256`)).text()).trim().split(/\s+/)[0];
    if (!digestPattern.test(archiveSha256)) throw invalid();
    return { version, archive, archiveSha256 };
  }
  /** The previous refresh; a missing, damaged or foreign-platform cache counts as none. */
  async function cachedLatest() {
    let record;
    try { record = JSON.parse(await readFile(latestFile, 'utf8')); } catch { return []; }
    const latest = record?.release;
    if (record?.schema !== LATEST_SCHEMA || record.target !== target || !latest
      || !versionPattern.test(latest.version) || !digestPattern.test(latest.archiveSha256)) return [];
    try { sourceOf(latest.archive); } catch { return []; }
    // The cache is keyed by target, so it is the place that stamps these on.
    return [{ ...latest, target, protocolProfile: KSXC_PROTOCOL_PROFILE }];
  }
  async function localVersions() {
    try { return (await readdir(installed)).filter(name => versionPattern.test(name)); }
    catch { return []; }
  }
  async function recordedDigest(version) {
    try { return (await readFile(join(installed, version, DIGEST_FILE), 'utf8')).trim() || undefined; }
    catch { return undefined; }
  }
  function command(release, directory = join(installed, release.version)) {
    // The payload was built for the release target, not for this machine, so the
    // platform/arch pair comes from it: a POSIX runner then validates a macOS or
    // Windows payload instead of rejecting it as RUNTIME_UNSUPPORTED.
    const [releasePlatform, releaseArch] = release.target.split('-');
    return { ...resolveKsxcCommand({ executable: join(directory, 'bin', executableName), expectedSha256: release.sha256,
      protocolProfile: release.protocolProfile, companyConfigPath, allowedTargets: [release.target],
      platform: releasePlatform, arch: releaseArch, env: {} }), version: release.version };
  }
  async function valid(release, directory) {
    const options = command(release, directory);
    await options.validate();
    return options;
  }
  async function download(source, archive, archiveSha256, onProgress) {
    // 170 MB takes three minutes at 1 MB/s; allow ten.
    const signal = AbortSignal.timeout(600_000);
    let input;
    let totalBytes = null;
    if (source.file) input = createReadStream(source.file);
    else {
      let response;
      try { response = await fetchImpl(source.url, { redirect: 'error', signal }); }
      catch { throw unreachable(); }
      if (!response.ok || !response.body) throw unavailable();
      totalBytes = Number(response.headers.get('content-length')) || null;
      input = response.body;
    }
    onProgress({ phase: 'download', receivedBytes: 0, totalBytes });
    const hash = createHash('sha256');
    let bytes = 0;
    // The staging directory is private to this installation, so a retry overwrites its own partial file.
    try {
      await pipeline(input, new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          if (bytes > MAX_ARCHIVE_BYTES) return done(invalid());
          hash.update(chunk);
          onProgress({ phase: 'download', receivedBytes: bytes, totalBytes });
          done(null, chunk);
        },
      }), createWriteStream(archive, { mode: 0o600 }), { signal });
    } catch (error) {
      // A dropped body or a timeout surfaces as a plain stream error.
      throw error.code?.startsWith('KSXC_') ? error : unreachable();
    }
    if (hash.digest('hex') !== archiveSha256) {
      throw new KsxcRuntimeError('KSXC_PAYLOAD_INTEGRITY_FAILED', 'KSXC 制品的 SHA-256 校验失败。');
    }
  }
  async function install(release, onProgress = () => {}) {
    // Later phases must clear a retry marker left by an earlier download attempt.
    const report = progress => onProgress({ retrying: false, ...progress });
    const stage = await mkdtemp(join(installed, '.install-'));
    try {
      const archive = join(stage, 'release.tar.gz');
      const payload = join(stage, 'payload');
      await mkdir(payload, { mode: 0o700 });
      const { bsize, bavail } = await statfs(installed);
      if (bsize * bavail < minFreeBytes) throw noDisk();
      // A weak link often drops mid-download, so retry once. A digest mismatch
      // is not retried: it must not mask a replaced archive.
      for (let attempt = 0; ; attempt += 1) {
        try { await download(sourceOf(release.archive), archive, release.archiveSha256, report); break; }
        catch (error) {
          if (attempt || error.code === 'KSXC_PAYLOAD_INTEGRITY_FAILED') throw error;
          report({ phase: 'download', receivedBytes: 0, totalBytes: null, retrying: true });
        }
      }
      report({ phase: 'extract' });
      // The archive digest was verified before extraction; the executable
      // digest is derived from it because the cache cannot know it in advance.
      const { args, env } = tarInvocationFor(target, archive, payload);
      await runFile(tarPath, args, { cwd: stage, env, timeout: 60_000, maxBuffer: 64 * 1024 });
      const executable = join(payload, 'bin', executableName);
      const sha256 = await fileSha256(executable);
      await valid({ ...release, sha256 }, payload);
      report({ phase: 'probe' });
      const probe = await probeKsxcPayload({ executable, expectedSha256: sha256 });
      if (probe.version.detected !== release.version) throw invalid();
      await rename(payload, join(installed, release.version));
      await writeFile(join(installed, release.version, DIGEST_FILE), sha256, { mode: 0o600 });
    // Windows antivirus keeps a handle on the freshly written payload, so the removal retries.
    } finally { await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  }
  async function status({ refresh: shouldRefresh = false } = {}) {
    const current = await state();
    let catalogError = null;
    if (shouldRefresh) await refresh().catch(error => { catalogError = error.code; });
    const releases = await catalog();
    const active = releases.find(item => item.version === current.active);
    const ready = Boolean(active && current.enabled && await valid(active).then(() => true, () => false));
    return { ...current, ready, target, versions: releases.map(item => item.version),
      installable: Boolean(companyConfigPath) && Object.hasOwn(PLATFORMS, target),
      ...(catalogError ? { catalogError } : {}) };
  }
  function change(task, onProgress = () => {}) {
    const result = queue.then(async () => {
      if (!Object.hasOwn(PLATFORMS, target)) throw unavailable();
      await mkdir(installed, { recursive: true, mode: 0o700 });
      // A Host killed mid-install never reaches its finally block, and every leftover holds 200 MB or more.
      await Promise.all((await readdir(installed)).filter(name => name.startsWith('.install-'))
        .map(name => rm(join(installed, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
      const current = await state();
      const next = await task(current, await catalog(), onProgress);
      const tmp = join(root, `.active-${randomUUID()}.json`);
      try {
        await writeFile(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        await rename(tmp, stateFile);
      } finally { await rm(tmp, { force: true }); }
      return status();
    });
    queue = result.catch(() => {});
    return result;
  }
  const activate = (version, onProgress) => change(async (current, cached, report) => {
    // Activation is always a settings action, never a session's hot path: on a
    // fresh machine the cache is still empty, so look the release up first.
    let releases = cached;
    let failure = null;
    if (!releases.some(item => item.version === version && !item.local)) {
      await refresh().catch(error => { failure = error; });
      releases = await catalog();
    }
    const release = releases.find(item => item.version === version);
    // Report the network failure itself rather than "no reviewed release" when nothing local can serve it either.
    if (!release) throw failure ?? unavailable();
    const installedRelease = await valid(release).then(() => true, error => {
      // A not-yet-installed release has no recorded digest, so validate() rejects
      // the empty sha256 before it looks for the file. Both mean "install it".
      if (error.code === 'RUNTIME_PROFILE_UNAVAILABLE' || (!release.sha256 && error.code === 'KSXC_PAYLOAD_INVALID')) return false;
      throw error;
    });
    // An installed release switches without downloading: it is already runnable, so
    // the missing archive only matters when the payload has to be fetched again.
    if (!installedRelease) {
      if (release.local) throw noArchive(version);
      await install(release, report);
    }
    return { active: version, previous: current.active === version ? current.previous : current.active, enabled: true };
  }, onProgress);
  const installs = new Map();
  function startInstall(version) {
    const requestId = randomUUID();
    const job = { status: 'running', phase: 'prepare', receivedBytes: 0, totalBytes: null };
    installs.set(requestId, job);
    // activate() queues behind every other change, creates versions/, and
    // records the release as active once the payload is verified.
    void activate(version, progress => Object.assign(job, progress))
      .then(() => Object.assign(job, { status: 'succeeded', phase: 'done' }))
      .catch(error => Object.assign(job, { status: 'failed', error: { code: error.code, message: error.message } }))
      // The collector must not keep a short-lived Host process alive.
      .finally(() => { setTimeout(() => installs.delete(requestId), 60_000).unref?.(); });
    return { requestId };
  }
  function installStatus(requestId) {
    const job = installs.get(requestId);
    if (!job) throw new KsxcRuntimeError('KSXC_INSTALL_UNKNOWN', '安装任务不存在或已结束。');
    return { ...job };
  }
  return {
    status,
    refresh,
    startInstall,
    installStatus,
    async command() {
      const current = await state();
      const release = current.enabled && (await catalog()).find(item => item.version === current.active);
      if (!release) throw notInstalled();
      return command(release);
    },
    activate,
    enable: enabled => change(async (current, releases) => {
      const release = releases.find(item => item.version === current.active);
      if (typeof enabled !== 'boolean' || !release) throw notInstalled();
      if (enabled) await valid(release);
      return { ...current, enabled };
    }),
    rollback: () => change(async (current, releases) => {
      const release = releases.find(item => item.version === current.previous);
      if (!release) throw notInstalled();
      await valid(release);
      return { active: current.previous, previous: current.active, enabled: true };
    }),
  };
}
