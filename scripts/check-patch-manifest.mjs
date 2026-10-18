/** Validate reviewed compatibility inputs without executing manifest commands. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) && value.length > 0 && value.every(text);
const safePath = value => text(value) && !/[\\\0\r\n]/.test(value) && !/^[-/]|^[a-z]:/i.test(value) && !value.split('/').some(part => ['..', '.', ''].includes(part));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const reject = message => { throw Object.assign(new Error(`patch manifest: ${message}`), { code: 'PATCH_MANIFEST_INVALID' }); };

export function patchPaths(source) {
  const paths = [...String(source).matchAll(/^(?:--- a\/|\+\+\+ b\/)([^\r\n]+)$/gm)].map(match => match[1]);
  if (!paths.length || paths.some(path => !safePath(path))) reject('unsafe or missing modified paths');
  return [...new Set(paths)].sort();
}

export function validatePatchManifest(manifest, files, { baseCommit = manifest.baseCommit } = {}) {
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.baseCommit || '') || manifest.baseCommit !== baseCommit) reject('baseline mismatch');
  if (!text(manifest.upstream?.repository) || !text(manifest.upstream?.ref)) reject('missing upstream provenance');
  if (!/^[a-f0-9]{40}$/.test(manifest.patchedTree || '') || !/^[a-f0-9]{64}$/.test(manifest.patchedSourceSha256 || '')) reject('missing patched source fingerprint');
  if (!Array.isArray(manifest.patches) || !manifest.patches.length) reject('empty series');
  const entries = manifest.patches, ids = new Map(), names = new Set();
  for (const entry of entries) {
    if (!/^\d{3}$/.test(entry.id || '') || ids.has(entry.id)) reject('duplicate or invalid patch id');
    if (!safePath(entry.file) || entry.file.includes('/') || !entry.file.startsWith(`${entry.id}-`) || !entry.file.endsWith('.patch') || names.has(entry.file)) reject('duplicate or invalid patch filename');
    if (entry.baseCommit !== baseCommit) reject(`${entry.id}: mixed baseline`);
    if (!['product', 'packaging', 'lifecycle', 'session-contract', 'general-fix', 'generated-docs', 'updater', 'signing'].includes(entry.category)) reject(`${entry.id}: invalid category`);
    if (!['low', 'medium', 'high'].includes(entry.risk) || !text(entry.maintainerRole) || !text(entry.removeWhen) || !list(entry.contracts) || !list(entry.affectedPackages)) reject(`${entry.id}: missing ownership, contract, risk or exit condition`);
    if (!['unverified', 'not-submitted', 'pending', 'merged-unreleased', 'in-baseline'].includes(entry.upstreamStatus?.state) || !text(entry.upstreamStatus?.evidence)) reject(`${entry.id}: missing upstream status evidence`);
    if (!Array.isArray(entry.dependsOn) || entry.dependsOn.some(value => !text(value)) || new Set(entry.dependsOn).size !== entry.dependsOn.length) reject(`${entry.id}: invalid dependencies`);
    const checks = entry.verification;
    if (!checks || !Array.isArray(checks.hostTests) || checks.hostTests.some(path => !safePath(path) || !/\.spec\.[cm]?[jt]sx?$/.test(path)) || !list(checks.integrations)) reject(`${entry.id}: missing verification`);
    for (const profile of checks.integrations) if (!Object.hasOwn(manifest.verificationProfiles || {}, profile) || !text(manifest.verificationProfiles[profile]?.kind)) reject(`${entry.id}: unknown verification profile`);
    const bytes = files.get(entry.file);
    if (!bytes || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || digest(bytes) !== entry.sha256) reject(`${entry.id}: content digest mismatch`);
    if (!Array.isArray(entry.affectedFiles) || !same(entry.affectedFiles, patchPaths(bytes))) reject(`${entry.id}: unregistered modified files`);
    ids.set(entry.id, entry); names.add(entry.file);
  }
  if (!same(names, files.keys())) reject('unregistered or missing patch files');
  const retired = new Set();
  for (const entry of manifest.retired || []) {
    if (!/^\d{3}$/.test(entry.id || '') || ids.has(entry.id) || retired.has(entry.id) || !text(entry.reason)) reject('invalid retired patch record');
    retired.add(entry.id);
  }
  const active = new Set(), done = new Set(), ancestors = new Map();
  function visit(id) {
    if (active.has(id)) reject('cyclic dependencies');
    if (done.has(id)) return ancestors.get(id);
    const entry = ids.get(id); if (!entry) reject('unknown dependency');
    active.add(id); const all = new Set();
    for (const dependency of entry.dependsOn) { all.add(dependency); for (const ancestor of visit(dependency)) all.add(ancestor); }
    active.delete(id); done.add(id); ancestors.set(id, all); return all;
  }
  for (const id of ids.keys()) visit(id);
  const earlier = new Set(), owner = new Map();
  for (const entry of entries) {
    if (entry.dependsOn.some(id => !earlier.has(id))) reject(`${entry.id}: dependency appears later in series`);
    for (const path of entry.affectedFiles) {
      const previous = owner.get(path);
      if (previous && !ancestors.get(entry.id).has(previous)) reject(`${entry.id}: undeclared file-order dependency on ${previous}`);
      owner.set(path, entry.id);
    }
    earlier.add(entry.id);
  }
  if (!same(entries.map(entry => entry.file), [...files.keys()].sort()) || entries.some((entry, index) => entry.file !== [...files.keys()].sort()[index])) reject('manifest order differs from application order');
  const hash = createHash('sha256').update(baseCommit);
  for (const entry of entries) hash.update(entry.file).update('\0').update(files.get(entry.file));
  return { baseCommit, patches: entries.length, paths: owner.size, seriesSha256: hash.digest('hex'), hostTests: [...new Set(entries.flatMap(entry => entry.verification.hostTests))].sort(), verified: true };
}

export async function checkPatchManifest(directory, options) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const names = (await readdir(directory)).filter(name => name.endsWith('.patch')).sort();
  const files = new Map(await Promise.all(names.map(async name => [name, await readFile(join(directory, name))])));
  return { manifest, report: validatePatchManifest(manifest, files, options) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] || join(root, 'patches/dsh-v0.2.1-rc.2'));
  const { report } = await checkPatchManifest(directory, process.argv[3] ? { baseCommit: process.argv[3] } : undefined);
  console.log(JSON.stringify(report));
}
