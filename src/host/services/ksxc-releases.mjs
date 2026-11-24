import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { KSXC_PROTOCOL_PROFILE, KsxcRuntimeError, resolveKsxcCommand } from '../../providers/ksxc-command.mjs';
import { probeKsxcPayload } from '../../providers/ksxc-probe.mjs';

const runFile = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const unavailable = () => new KsxcRuntimeError('KSXC_RELEASES_UNAVAILABLE', '当前平台没有可安装的审定 KSXC 版本。');
const notInstalled = () => new KsxcRuntimeError('KSXC_NOT_INSTALLED', '请在 Studio 设置中安装并启用 KSXC。');
const invalid = () => new KsxcRuntimeError('KSXC_RELEASE_INVALID', '审定的 KSXC 版本配置无效。');

function sourceOf(value) {
  if (typeof value !== 'string') throw invalid();
  if (isAbsolute(value)) return { file: value };
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalid();
  return { url };
}

export function createKsxcReleases({ root, lock, companyConfigPath, fetchImpl = fetch, target = `${process.platform}-${process.arch}` }) {
  const stateFile = join(root, 'active.json');
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
  async function catalog() {
    if (!lock) return [];
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
  function command(release, directory = join(installed, release.version)) {
    return { ...resolveKsxcCommand({ executable: join(directory, 'bin', 'codex'), expectedSha256: release.sha256,
      protocolProfile: release.protocolProfile, companyConfigPath, allowedTargets: [release.target], env: {} }), version: release.version };
  }
  async function valid(release, directory) {
    const options = command(release, directory);
    await options.validate();
    return options;
  }
  async function install(release) {
    const stage = await mkdtemp(join(installed, '.install-'));
    try {
      const archive = join(stage, 'release.tar.gz');
      const payload = join(stage, 'payload');
      await mkdir(payload, { mode: 0o700 });
      const source = sourceOf(release.archive);
      const signal = AbortSignal.timeout(180_000);
      let input;
      if (source.file) input = createReadStream(source.file);
      else {
        const response = await fetchImpl(source.url, { redirect: 'error', signal });
        if (!response.ok || !response.body) throw unavailable();
        input = response.body;
      }
      const hash = createHash('sha256');
      let bytes = 0;
      await pipeline(input, new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          if (bytes > MAX_ARCHIVE_BYTES) return done(invalid());
          hash.update(chunk);
          done(null, chunk);
        },
      }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
      if (hash.digest('hex') !== release.archiveSha256) {
        throw new KsxcRuntimeError('KSXC_PAYLOAD_INTEGRITY_FAILED', 'KSXC 制品的 SHA-256 校验失败。');
      }
      // Only extract a release whose archive digest is pinned in the operator's lock.
      await runFile('/usr/bin/tar', ['--no-same-owner', '-xzf', archive, '-C', payload],
        { cwd: stage, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 60_000, maxBuffer: 64 * 1024 });
      const executable = (await valid(release, payload)).executable;
      const probe = await probeKsxcPayload({ executable, expectedSha256: release.sha256 });
      if (probe.version.detected !== release.version) throw invalid();
      await rename(payload, join(installed, release.version));
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  async function status() {
    const current = await state();
    const releases = await catalog();
    const active = releases.find(item => item.version === current.active);
    const ready = Boolean(active && current.enabled && await valid(active).then(() => true, () => false));
    return { ...current, ready, target, versions: releases.map(item => item.version) };
  }
  function change(task) {
    const result = queue.then(async () => {
      if (!['darwin-arm64', 'darwin-x64'].includes(target)) throw unavailable();
      await mkdir(installed, { recursive: true, mode: 0o700 });
      const current = await state();
      const next = await task(current, await catalog());
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
  return {
    status,
    async command() {
      const current = await state();
      const release = current.enabled && (await catalog()).find(item => item.version === current.active);
      if (!release) throw notInstalled();
      return command(release);
    },
    activate: version => change(async (current, releases) => {
      const release = releases.find(item => item.version === version);
      if (!release) throw unavailable();
      const installedRelease = await valid(release).then(() => true, error => {
        if (error.code === 'RUNTIME_PROFILE_UNAVAILABLE') return false;
        throw error;
      });
      if (!installedRelease) await install(release);
      return { active: version, previous: current.active === version ? current.previous : current.active, enabled: true };
    }),
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
