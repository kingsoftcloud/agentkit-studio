/** Maintain DSH changes as commits; patches are deterministic build exports. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { checkPatchManifest, validatePatchManifest } from './check-patch-manifest.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const oid = value => /^[a-f0-9]{40}$/.test(value || '');
const fail = message => { throw Object.assign(new Error(`DSH maintenance source: ${message}`), { code: 'DSH_MAINTENANCE_SOURCE_INVALID' }); };
const descriptorName = 'source.json';
const defaultPatches = fileURLToPath(new URL('../patches/dsh-v0.2.1-rc.2', import.meta.url));
function bundlePath(patches) {
  const version = basename(patches);
  if (!/^dsh-v[0-9][a-zA-Z0-9.-]+$/.test(version)) fail('patch directory must name its DSH version');
  return `../../host-source/${version}/maintenance.bundle`;
}

async function git(cwd, args) {
  try {
    return (await execute('git', ['--no-replace-objects', '-c', 'core.autocrlf=false', ...args], {
      cwd, encoding: 'buffer', maxBuffer: 48 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    })).stdout;
  } catch { fail(`Git ${args[0]} failed`); }
}
const gitText = async (cwd, args) => (await git(cwd, args)).toString().trim();

async function exportCommits(source, manifest, headCommit) {
  if (!oid(headCommit) || !oid(manifest.baseCommit)) fail('invalid commit identity');
  const commits = (await gitText(source, ['rev-list', '--reverse', `${manifest.baseCommit}..${headCommit}`])).split('\n').filter(Boolean);
  if (commits.length !== manifest.patches.length) fail('commit count differs from patch inventory');
  const files = new Map(), entries = [];
  let parent = manifest.baseCommit;
  for (const [index, commit] of commits.entries()) {
    if (await gitText(source, ['show', '-s', '--format=%P', commit]) !== parent) fail('maintenance history must be a linear chain from the pinned baseline');
    const trailers = await gitText(source, ['show', '-s', '--format=%(trailers:key=Studio-Patch,valueonly)', commit]);
    const entry = manifest.patches[index];
    if (trailers !== entry.id) fail('commit order or Studio-Patch trailer differs from inventory');
    const bytes = await git(source, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--binary',
      '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', parent, commit, '--']);
    if (!bytes.length) fail('empty maintenance commit');
    files.set(entry.file, bytes);
    entries.push({ id: entry.id, file: entry.file, commit, sha256: hash(bytes) });
    parent = commit;
  }
  const tree = await gitText(source, ['rev-parse', `${headCommit}^{tree}`]);
  await git(source, ['diff', '--no-ext-diff', '--no-textconv', '--check', manifest.baseCommit, headCommit, '--']);
  const treeEntries = await git(source, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  return { files, entries, tree, sourceSha256: hash(treeEntries) };
}

async function inputs(patches, files) {
  const { manifest } = await checkPatchManifest(patches);
  const bytes = await readFile(join(patches, descriptorName));
  if (manifest.maintenanceSource?.descriptor !== descriptorName || manifest.maintenanceSource.sha256 !== hash(bytes)) fail('descriptor is not bound to the patch manifest');
  const descriptor = JSON.parse(bytes);
  if (descriptor.schemaVersion !== 1 || descriptor.exportFormat !== 1 || descriptor.baseCommit !== manifest.baseCommit
    || !oid(descriptor.headCommit) || descriptor.tree !== manifest.patchedTree
    || descriptor.sourceSha256 !== manifest.patchedSourceSha256 || descriptor.bundle?.file !== bundlePath(patches)
    || !/^refs\/heads\/codex\/[a-z0-9.-]+$/.test(descriptor.branchRef || '')) fail('descriptor baseline, tree or format mismatch');
  const expected = manifest.patches.map(({ id, file, sha256 }) => ({ id, file, sha256 }));
  if (!Array.isArray(descriptor.commits) || JSON.stringify(descriptor.commits.map(({ id, file, sha256 }) => ({ id, file, sha256 }))) !== JSON.stringify(expected)
    || descriptor.commits.some(entry => !oid(entry.commit)) || descriptor.commits.at(-1)?.commit !== descriptor.headCommit) fail('descriptor commit inventory mismatch');
  const bundle = resolve(patches, descriptor.bundle.file);
  const bundleBytes = await readFile(bundle);
  if (hash(bundleBytes) !== descriptor.bundle.sha256) fail('bundle digest mismatch');
  const headerEnd = bundleBytes.indexOf('\n\n');
  if (headerEnd < 0) fail('missing bundle header');
  const header = bundleBytes.subarray(0, headerEnd).toString().split('\n');
  if (header.length !== 3 || header[0] !== '# v2 git bundle'
    || !header[1].startsWith(`-${descriptor.baseCommit} `)
    || header[2] !== `${descriptor.headCommit} ${descriptor.branchRef}`) fail('bundle must contain exactly the pinned baseline prerequisite and maintenance branch');
  if (files) validatePatchManifest(manifest, files);
  return { manifest, descriptor, bundle };
}

async function withBundleRepository(source, input, action) {
  const temporary = await mkdtemp(join(tmpdir(), 'studio-dsh-maintenance-'));
  try {
    await git(temporary, ['init', '--bare', '--quiet']);
    // Borrow only the baseline's object database, never its worktree, refs or index.
    const objects = resolve(source, await gitText(source, ['rev-parse', '--git-path', 'objects']));
    if (/[\r\n]/.test(objects)) fail('unsupported baseline object path');
    await writeFile(join(temporary, 'objects/info/alternates'), objects + '\n');
    // Actions normally fetches one commit. The object pool alone does not
    // describe its missing parents; preserve the read-only shallow boundary.
    if (await gitText(source, ['rev-parse', '--is-shallow-repository']) === 'true') {
      const shallow = resolve(source, await gitText(source, ['rev-parse', '--git-path', 'shallow']));
      await copyFile(shallow, join(temporary, 'shallow'));
    }
    await git(temporary, ['cat-file', '-e', `${input.manifest.baseCommit}^{commit}`]);
    await git(temporary, ['bundle', 'verify', input.bundle]);
    await git(temporary, ['fetch', '--quiet', '--no-tags', input.bundle, `${input.descriptor.branchRef}:${input.descriptor.branchRef}`]);
    return await action(temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Without source: immutable input audit. With source: regenerate every patch and verify Git ancestry. */
export async function checkMaintenanceSource({ patches = defaultPatches, source, files } = {}) {
  const input = await inputs(resolve(patches), files);
  const { manifest, descriptor } = input;
  if (source) await withBundleRepository(resolve(source), input, async repository => {
    const actual = await exportCommits(repository, manifest, descriptor.headCommit);
    if (actual.tree !== descriptor.tree || actual.sourceSha256 !== descriptor.sourceSha256
      || JSON.stringify(actual.entries) !== JSON.stringify(descriptor.commits)) fail('bundle commits differ from reviewed exports');
    for (const [file, bytes] of actual.files) {
      const expected = files?.get(file) ?? await readFile(join(patches, file));
      if (!bytes.equals(expected)) fail(`generated patch differs: ${file}`);
    }
  });
  return { baseCommit: descriptor.baseCommit, headCommit: descriptor.headCommit, tree: descriptor.tree,
    patches: descriptor.commits.length, bundleSha256: descriptor.bundle.sha256,
    verified: true, scope: source ? 'git-ancestry-and-regenerated-patches' : 'descriptor-and-export-digests' };
}

/** Legacy/synthetic patch inventories remain readable; current public CI requires source.json. */
export async function checkBoundMaintenanceSource({ patches, source, files }) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(patches, 'manifest.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (manifest.maintenanceSource) return checkMaintenanceSource({ patches, source, files });
}

export async function exportMaintenanceSource({ patches = defaultPatches, source, branchRef }) {
  if (!source) fail('export requires a maintenance checkout');
  patches = resolve(patches); source = resolve(source);
  branchRef ??= `refs/heads/codex/studio-${basename(patches)}`;
  const manifest = JSON.parse(await readFile(join(patches, 'manifest.json'), 'utf8'));
  if (!/^refs\/heads\/codex\/[a-z0-9.-]+$/.test(branchRef) || await gitText(source, ['symbolic-ref', 'HEAD']) !== branchRef) fail('export requires the declared maintenance branch');
  if (await gitText(source, ['status', '--porcelain'])) fail('commit maintenance edits before exporting');
  const headCommit = await gitText(source, ['rev-parse', 'HEAD']);
  const exported = await exportCommits(source, manifest, headCommit);
  const next = { ...manifest, patchedTree: exported.tree, patchedSourceSha256: exported.sourceSha256,
    patches: manifest.patches.map((entry, index) => ({ ...entry, sha256: exported.entries[index].sha256 })) };
  // Ownership, paths and dependencies are reviewed metadata, never inferred away by export.
  validatePatchManifest(next, exported.files);
  const temporary = await mkdtemp(join(tmpdir(), 'studio-dsh-export-'));
  try {
    const candidate = join(temporary, 'maintenance.bundle');
    await git(source, ['bundle', 'create', '--version=2', candidate, branchRef, `^${manifest.baseCommit}`]);
    let bytes = await readFile(candidate);
    // Repeated exports preserve the exact archived pack bytes, independent of Git pack heuristics.
    try {
      const previous = await inputs(patches);
      if (previous.descriptor.headCommit === headCommit && previous.descriptor.branchRef === branchRef) bytes = await readFile(previous.bundle);
    } catch { /* A changed source or a first export creates a fresh bundle. */ }
    const descriptor = { schemaVersion: 1, exportFormat: 1, baseCommit: manifest.baseCommit, headCommit, branchRef,
      tree: exported.tree, sourceSha256: exported.sourceSha256,
      bundle: { file: bundlePath(patches), sha256: hash(bytes) }, commits: exported.entries };
    next.maintenanceSource = { descriptor: descriptorName, sha256: hash(json(descriptor)) };
    await mkdir(dirname(resolve(patches, descriptor.bundle.file)), { recursive: true });
    await writeFile(resolve(patches, descriptor.bundle.file), bytes);
    for (const [file, content] of exported.files) await writeFile(join(patches, file), content);
    await writeFile(join(patches, descriptorName), json(descriptor));
    await writeFile(join(patches, 'manifest.json'), json(next));
    return await checkMaintenanceSource({ patches, source });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function importMaintenanceSource({ patches = defaultPatches, source, output }) {
  if (!source || !output) fail('import requires baseline source and a new output directory');
  patches = resolve(patches); source = resolve(source); output = resolve(output);
  if (await stat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) fail('import output already exists; preserve it and choose a new directory');
  const report = await checkMaintenanceSource({ patches, source });
  const input = await inputs(patches);
  await mkdir(dirname(output), { recursive: true });
  await git(dirname(output), ['init', '--quiet', output]);
  await git(output, ['fetch', '--quiet', '--no-tags', '--update-shallow', source, input.manifest.baseCommit]);
  await git(output, ['fetch', '--quiet', '--no-tags', input.bundle, input.descriptor.branchRef]);
  // -B is intentionally avoided: an existing branch in the clone must not be overwritten.
  await git(output, ['checkout', '--quiet', '-b', input.descriptor.branchRef.slice('refs/heads/'.length), input.descriptor.headCommit]);
  return { ...report, imported: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['patches', 'source', 'output'].map(name => [name, { type: 'string' }])) });
  const operation = { check: checkMaintenanceSource, export: exportMaintenanceSource, import: importMaintenanceSource }[positionals[0]];
  if (!operation || positionals.length !== 1) fail('usage: dsh-maintenance-source.mjs check|export|import [--patches path] [--source checkout] [--output new-checkout]');
  console.log(JSON.stringify(await operation(values)));
}
