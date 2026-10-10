#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFiles } from './public-surface-audit.mjs';

const VERSION = '8.30.1';
const config = fileURLToPath(new URL('../ci/gitleaks.toml', import.meta.url));

export async function scanSecrets(root = process.cwd()) {
  const requested = process.env.GITLEAKS_BIN || 'gitleaks';
  const binary = requested.includes('/') ? resolve(requested) : requested;
  const probe = spawnSync(binary, ['version'], { encoding: 'utf8' });
  if (probe.status !== 0 || probe.stdout.trim() !== VERSION) {
    throw new Error(`Gitleaks ${VERSION} is required; install it with ci/install-gitleaks.sh`);
  }
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8', cwd: root }).trim() !== 'false') {
    throw new Error('Secret history scan requires a complete checkout (fetch-depth: 0)');
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'studio-secret-gate-'));
  try {
    const snapshot = resolve(temporary, 'snapshot');
    await mkdir(snapshot);
    // Include changed and new non-ignored files, without reading user profiles,
    // ignored build output or an unrelated branch. Refuse symlinks and gitlinks.
    for (const file of trackedFiles(root)) {
      const source = resolve(root, file), target = resolve(snapshot, file);
      const rel = relative(snapshot, target);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe snapshot path');
      let info;
      try { info = await lstat(source); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isFile()) throw new Error(`Secret scan rejects non-regular file: ${file}`);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    const ignore = resolve(temporary, 'empty.ignore');
    await writeFile(ignore, '');
    const options = [
      '--config', config, '--gitleaks-ignore-path', ignore, '--ignore-gitleaks-allow',
      '--redact=100', '--no-banner', '--no-color', '--log-level=error',
      '--max-decode-depth=5', '--exit-code=1', '--report-format=json',
    ];
    const jobs = [['history', ['git', '--log-opts=HEAD', resolve(root)]], ['snapshot', ['dir', snapshot]]];
    let found = false;
    for (const [label, args] of jobs) {
      const report = resolve(temporary, `${label}.json`);
      const result = spawnSync(binary, [...args, ...options, '--report-path', report], {
        encoding: 'utf8', cwd: temporary, timeout: 120000,
      });
      if (result.error || ![0, 1].includes(result.status)) throw new Error(`Gitleaks ${label} scan could not complete`);
      if (result.status === 1) {
        const findings = JSON.parse(await readFile(report, 'utf8'));
        if (!Array.isArray(findings) || !findings.length) throw new Error(`Gitleaks ${label} scan failed without findings`);
        for (const hit of findings) {
          // Only location and rule reach logs. No raw scanner stderr, line,
          // author, remote URL, or secret-bearing report is published.
          const file = isAbsolute(hit.File) ? relative(snapshot, hit.File) : hit.File;
          console.error(`${label}: ${file}:${hit.StartLine} ${hit.RuleID}`);
        }
        found = true;
      } else console.log(`secret ${label} scan passed (Gitleaks ${VERSION})`);
    }
    return found ? 1 : 0;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = await scanSecrets(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
