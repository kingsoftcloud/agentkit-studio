/** Validate a dependent patch series in a private Git index without editing the checkout. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkBoundMaintenanceSource } from './dsh-maintenance-source.mjs';

const [checkout, patchDirectory] = process.argv.slice(2);
if (!checkout || !patchDirectory) throw new Error('usage: node scripts/check-dsh-patches.mjs <checkout> <patch-directory>');
const root = resolve(checkout);
const patches = resolve(patchDirectory);
const names = readdirSync(patches).filter(name => name.endsWith('.patch')).sort();
if (names.length === 0) throw new Error('DSH patch directory contains no patches');
await checkBoundMaintenanceSource({ patches, source: root });
const temporary = mkdtempSync(join(tmpdir(), 'studio-patch-check-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
  const git = args => execFileSync('git', args, { cwd: root, env, stdio: 'inherit' });
  git(['read-tree', 'HEAD']);
  for (const name of names) {
    const path = join(patches, name);
    git(['apply', '--cached', '--check', path]);
    git(['apply', '--cached', path]);
  }
  console.log(`DSH patches: ${names.length} applied in order to a private index; checkout unchanged`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
