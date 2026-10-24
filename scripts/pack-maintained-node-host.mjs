/**
 * Pack a maintained Node Host package set from a built DSH source checkout.
 *
 * Exports `packMaintainedNodeHost({source, output, studio})` plus a CLI entry
 * point (`--source`, `--output`, `--studio`). The parent owns the installer,
 * verifier, docs, and actual full acceptance.
 *
 * Contract: agentkit.node-host-packages/v1
 *
 * The source checkout is read-only; this module never changes tracked files,
 * branches, or refs. It uses `git ls-files -z` to find tracked package.json
 * files (no filesystem traversal), computes the production workspace closure
 * from four root names through dependencies/optionalDependencies/peerDependencies,
 * intersects with packages owning changed files (git diff baseCommit..headCommit),
 * always includes roots, verifies built targets, runs `pnpm pack` per package,
 * collects the actual .tgz, hashes it, and writes the manifest to
 * output/host-packages.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { join, relative, resolve, sep, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const HOST_PACKAGES_FORMAT = 'agentkit.node-host-packages/v1';
const ROOT_NAMES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-sdk-client'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { throw fail('pack_read_failed', `Cannot read JSON: ${filePath}`); }
}

function git(source, ...args) {
  try { return execFileSync('git', ['--no-replace-objects', '-C', source, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) {
    throw fail('pack_git_failed', `git ${args.join(' ')} failed: ${error.stderr || error.message}`);
  }
}

/** Build workspace map from Git-tracked package.json files (git ls-files -z). */
function buildWorkspaceMap(source) {
  const trackedFiles = git(source, 'ls-files', '-z');
  const map = new Map();
  if (!trackedFiles) return map;
  const files = trackedFiles.split('\0').filter(Boolean);
  for (const file of files) {
    if (file.split('/').pop() !== 'package.json') continue;
    // Skip node_modules — git ls-files should not return them, but be safe.
    if (file.includes('node_modules/')) continue;
    const absPath = resolve(source, file);
    if (!lstatSync(absPath).isFile()) throw fail('pack_invalid_manifest', 'Tracked package manifest must be a regular file');
    const pkg = readJson(absPath);
    if (typeof pkg.name !== 'string' || !pkg.name.trim()) continue;
    const pkgDir = dirname(absPath);
    if (map.has(pkg.name)) throw fail('pack_duplicate_workspace', `Duplicate workspace package name: ${pkg.name}`);
    map.set(pkg.name, { path: pkgDir, version: pkg.version || '', pkg });
  }
  return map;
}

/** Compute transitive closure through dependencies, optionalDependencies, peerDependencies. */
function computeClosure(workspaceMap, rootNames) {
  const closure = new Set();
  const queue = [...rootNames];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    const entry = workspaceMap.get(name);
    if (!entry) {
      // Root or workspace dependency not in the workspace map — report if it's a root.
      if (rootNames.includes(name)) throw fail('pack_root_missing', `Root package not found in workspace: ${name}`);
      throw fail('pack_unresolved_workspace', `Missing workspace package: ${name}`);
    }
    closure.add(name);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dep, range] of Object.entries(entry.pkg[field] ?? {})) {
        if (!String(range).startsWith('workspace:')) continue;
        if (!workspaceMap.has(dep)) throw fail('pack_unresolved_workspace', `Missing workspace dependency: ${dep}`);
        if (!closure.has(dep)) queue.push(dep);
      }
    }
  }
  // Verify all roots are in closure
  for (const root of rootNames) {
    if (!closure.has(root)) throw fail('pack_root_not_in_closure', `Root ${root} not reachable in closure`);
  }
  return closure;
}

/** Get changed files between two commits. */
function getChangedFiles(source, baseCommit, headCommit) {
  const output = git(source, 'diff', '--name-only', '-z', baseCommit, headCommit);
  if (!output) return new Set();
  return new Set(output.split('\0').filter(Boolean));
}

/** Determine owning workspace package for a changed file. */
function owningPackage(source, workspaceMap, filePath) {
  const absPath = resolve(source, filePath);
  let bestMatch = null;
  let bestLen = 0;
  for (const [name, entry] of workspaceMap) {
    if (absPath === entry.path || absPath.startsWith(entry.path + sep)) {
      if (entry.path.length > bestLen) { bestLen = entry.path.length; bestMatch = name; }
    }
  }
  return bestMatch;
}

/** Collect built target files from main, exports (nested conditions/arrays), bin. */
function collectTargets(pkg) {
  const targets = [];
  if (typeof pkg.main === 'string') targets.push(pkg.main);
  if (typeof pkg.bin === 'string') targets.push(pkg.bin);
  if (pkg.bin && typeof pkg.bin === 'object') {
    for (const key of Object.keys(pkg.bin)) {
      if (typeof pkg.bin[key] === 'string') targets.push(pkg.bin[key]);
    }
  }
  if (pkg.exports) {
    function walkExports(value, keyPath) {
      if (typeof value === 'string') { targets.push(value); return; }
      if (Array.isArray(value)) { for (const item of value) walkExports(item, keyPath); return; }
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) walkExports(value[key], keyPath + '/' + key);
      }
    }
    walkExports(pkg.exports, 'exports');
  }
  // Filter out wildcard patterns and non-file references
  return targets.filter(t => typeof t === 'string' && !t.startsWith('node:') &&
    // DSH exposes src/* for workspace development but intentionally publishes
    // only lib/dist in these packages. This is not a production built target.
    !(t.replace(/^\.\//, '').startsWith('src/') && t.includes('*') && Array.isArray(pkg.files) &&
      !pkg.files.some(file => /^\.?\/?src(?:\/|$)/.test(file))));
}

/** Verify a package has built targets or is a valid asset package. */
function verifyPackage(entry) {
  const pkg = entry.pkg;
  const targets = collectTargets(pkg);
  // dsh-web-frontend has no ordinary main/exports but is a valid built package.
  // If there are no main/exports/bin targets, check for a dist or build directory.
  if (targets.length === 0) {
    const distDir = resolve(entry.path, 'dist');
    if (existsSync(distDir)) return; // valid asset package
    throw fail('pack_empty_package', `Package ${pkg.name} has no main/exports/bin/dist target`);
  }
  for (const target of targets) {
    if (target.includes('*')) continue; // Verified against the actual packed entries below.
    const targetPath = resolve(entry.path, target);
    if (!targetPath.startsWith(entry.path + sep)) throw fail('pack_invalid_target', `Target escapes package: ${target}`);
    if (!existsSync(targetPath)) throw fail('pack_missing_built_target', `Package ${pkg.name} built target missing: ${target}`);
  }
}

/** Run pnpm pack and collect the actual .tgz that was created. */
function pnpmPack(entry, output) {
  const pkgDir = entry.path;
  const before = new Map(readdirSync(output).filter(f => f.endsWith('.tgz')).map(f => [f,
    createHash('sha256').update(readFileSync(join(output, f))).digest('hex')]));
  const log = openSync(join(output, `pack-${before.size}.log`), 'wx', 0o600);
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', output], {
      cwd: pkgDir, timeout: 120000, stdio: ['ignore', log, log],
    });
  } catch (error) {
    throw fail('pack_pnpm_failed', `pnpm pack failed for ${entry.pkg.name}; see pack-${before.size}.log (${error.code ?? error.status}): ${readFileSync(join(output, `pack-${before.size}.log`), 'utf8').slice(-1800)}`);
  } finally { closeSync(log); }
  for (const [name, digest] of before) {
    if (createHash('sha256').update(readFileSync(join(output, name))).digest('hex') !== digest)
      throw fail('pack_tarball_collision', 'Existing Host archive overwritten');
  }
  const created = readdirSync(output).filter(f => f.endsWith('.tgz') && !before.has(f));
  if (created.length !== 1) throw fail('pack_tarball_ambiguous', `Expected one new archive for ${entry.pkg.name}`);
  const tarballName = created[0];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(tarballName)) throw fail('pack_tarball_name', 'Invalid Host archive name');
  const tarballPath = join(output, tarballName);
  if (!existsSync(tarballPath)) throw fail('pack_tarball_missing', `Tarball not found: ${tarballName}`);
  // Never accept empty tgz
  const stat = lstatSync(tarballPath);
  if (!stat.isFile() || stat.size === 0) throw fail('pack_empty_tgz', `Invalid tarball for ${entry.pkg.name}`);
  const files = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n').filter(Boolean).map(name => {
      if (!name.startsWith('package/') || name.split('/').some(p => p === '..' || p === 'node_modules'))
        throw fail('pack_tarball_entry', 'Invalid Host archive entry');
      return name.slice('package/'.length);
    }).filter(name => name && !name.endsWith('/'));
  const packed = JSON.parse(execFileSync('tar', ['-xOzf', tarballPath, 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  if (packed.name !== entry.pkg.name || packed.version !== entry.version) throw fail('pack_tarball_identity', 'Archive identity differs from source');
  if (!files.some(name => /^(lib|dist)\//.test(name))) throw fail('pack_empty_payload', `No built payload for ${entry.pkg.name}`);
  for (const target of collectTargets(entry.pkg)) {
    const value = target.replace(/^\.\//, '');
    const pattern = new RegExp('^' + value.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    if (!files.some(name => pattern.test(name))) throw fail('pack_missing_packed_target', `Missing packed target ${entry.pkg.name}: ${target}`);
  }
  const hash = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  return { tarball: tarballName, sha256: hash };
}

/** Verify tracked source clean (ignoring untracked files). */
function verifyTrackedClean(source) {
  const status = git(source, 'status', '--porcelain', '--untracked-files=no').trim();
  if (status) throw fail('pack_source_dirty', `Source has uncommitted tracked changes:\n${status}`);
}

/** Verify HEAD and tree match pins. */
function verifyHeadTree(source, pins) {
  const head = git(source, 'rev-parse', 'HEAD').trim();
  if (head !== pins.headCommit) throw fail('pack_source_head_mismatch', `Source HEAD ${head} != pinned ${pins.headCommit}`);
  const tree = git(source, 'rev-parse', 'HEAD^{tree}').trim();
  if (tree !== pins.tree) throw fail('pack_source_tree_mismatch', `Source tree ${tree} != pinned ${pins.tree}`);
}

/** Verify base ancestry. */
function verifyBaseAncestry(source, pins) {
  try { git(source, 'merge-base', '--is-ancestor', pins.baseCommit, pins.headCommit); }
  catch { throw fail('pack_base_not_ancestor', `baseCommit ${pins.baseCommit} is not an ancestor of headCommit ${pins.headCommit}`); }
}

/** Check if a path is inside another path. */
function isInside(path, parent) {
  return path === parent || path.startsWith(parent + sep);
}

export async function packMaintainedNodeHost({ source, output, studio }) {
  if (!source || typeof source !== 'string') throw fail('pack_source_required', 'source is required');
  if (!output || typeof output !== 'string') throw fail('pack_output_required', 'output is required');
  if (!studio || typeof studio !== 'string') throw fail('pack_studio_required', 'studio is required');

  // Canonicalize paths
  const sourceReal = realpathSync(source);
  const studioReal = realpathSync(studio);

  // Read requiredDsh from studio.plugin.json (NOT package.json)
  const pluginJsonPath = join(studioReal, 'studio.plugin.json');
  if (!existsSync(pluginJsonPath)) throw fail('pack_no_plugin_json', `studio.plugin.json not found: ${pluginJsonPath}`);
  const pluginJson = readJson(pluginJsonPath);
  const dshVersion = pluginJson.requiredDsh;
  if (typeof dshVersion !== 'string' || !/^[0-9][a-zA-Z0-9.-]+$/.test(dshVersion))
    throw fail('pack_no_required_dsh', 'studio.plugin.json has no valid requiredDsh');

  // Read source.json pins
  const sourceJsonPath = join(studioReal, 'patches', `dsh-v${dshVersion}`, 'source.json');
  const sourceJson = readJson(sourceJsonPath);
  const pins = {
    baseCommit: sourceJson.baseCommit,
    headCommit: sourceJson.headCommit,
    tree: sourceJson.tree,
    dshVersion,
  };
  if (['baseCommit', 'headCommit', 'tree'].some(key => !/^[a-f0-9]{40}$/.test(pins[key] ?? '')))
    throw fail('pack_invalid_pins', 'source.json requires baseCommit/headCommit/tree object IDs');

  // Verify source identity before packing
  verifyHeadTree(sourceReal, pins);
  verifyTrackedClean(sourceReal);
  verifyBaseAncestry(sourceReal, pins);

  // Output: canonical absolute path, must be NEW, mode 0700, not inside source/studio
  const outputAbs = join(realpathSync(dirname(resolve(output))), resolve(output).split(sep).pop());
  if (!isAbsolute(outputAbs)) throw fail('pack_output_not_absolute', 'output must be an absolute path');
  if (existsSync(outputAbs)) throw fail('pack_output_exists', `Output directory already exists: ${outputAbs}`);
  if (isInside(outputAbs, sourceReal) || isInside(outputAbs, studioReal)) {
    throw fail('pack_output_inside_source', 'output must not be inside source or studio');
  }

  // Build workspace map from Git-tracked package.json files
  const workspaceMap = buildWorkspaceMap(sourceReal);

  // Compute production workspace closure
  const closure = computeClosure(workspaceMap, ROOT_NAMES);

  // Get changed files and determine affected packages
  const changedFiles = getChangedFiles(sourceReal, pins.baseCommit, pins.headCommit);
  const affectedPackages = new Set();
  for (const file of changedFiles) {
    const owner = owningPackage(sourceReal, workspaceMap, file);
    if (owner) affectedPackages.add(owner);
  }

  // Packable: roots (always) ∪ affected packages, intersected with closure
  const packable = new Set();
  for (const name of closure) {
    if (ROOT_NAMES.includes(name) || affectedPackages.has(name)) {
      packable.add(name);
    }
  }
  for (const name of packable) {
    if (!/^@deepseek-ai\/[a-z0-9][a-z0-9-]*$/.test(name)) throw fail('pack_package_name', `Invalid Host package: ${name}`);
    // Office and workspace-dependency services are part of the maintained Node
    // Host closure. Pack their changed implementation just like other services;
    // dropping them would install the registry's older Python-based workflows.
    // Electron application packaging still has a separate build pipeline.
    if (/^@deepseek-ai\/dsh-desktop(?:-|$)/.test(name))
      throw fail('pack_desktop_closure', `Node Host requires Desktop application package ${name}; cannot silently omit it`);
    if (workspaceMap.get(name).version !== dshVersion) throw fail('pack_version_mismatch', `Host version differs: ${name}`);
  }
  mkdirSync(outputAbs, { mode: 0o700 }); // Atomic exclusive ownership; never overwrite or clean another output.

  // Verify and pack each package
  const packages = [];
  for (const name of [...packable].sort()) {
    const entry = workspaceMap.get(name);
    if (!entry.version) throw fail('pack_no_version', `Package ${name} has no version`);
    verifyPackage(entry);

    // Re-validate HEAD/tree/tracked-clean before each pack
    verifyHeadTree(sourceReal, pins);
    verifyTrackedClean(sourceReal);

    let artifact;
    try { artifact = pnpmPack(entry, outputAbs); }
    finally { verifyHeadTree(sourceReal, pins); verifyTrackedClean(sourceReal); }
    const { tarball, sha256 } = artifact;
    packages.push({
      name,
      version: entry.version,
      path: relative(sourceReal, entry.path).split(sep).join('/'),
      tarball,
      sha256,
    });
  }

  // Final re-validation
  verifyHeadTree(sourceReal, pins);
  verifyTrackedClean(sourceReal);

  // Emit and WRITE manifest to output/host-packages.json
  const manifest = {
    format: HOST_PACKAGES_FORMAT,
    source: {
      baseCommit: pins.baseCommit,
      headCommit: pins.headCommit,
      tree: pins.tree,
      dshVersion: pins.dshVersion,
    },
    roots: ROOT_NAMES,
    packages,
  };

  const manifestPath = join(outputAbs, 'host-packages.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

  return manifest;
}

// CLI entry point: only when run directly via `node script.mjs`
const scriptUrl = pathToFileURL(process.argv[1] || '').href;
if (import.meta.url === scriptUrl && process.argv[1]) {
  const { values: opts } = parseArgs({ options: Object.fromEntries(['source', 'output', 'studio'].map(name => [name, { type: 'string' }])) });
  packMaintainedNodeHost(opts).then(manifest => {
    console.log(JSON.stringify(manifest, null, 2));
  }).catch(error => {
    console.error(`Error [${error.code}]: ${error.message}`);
    process.exit(1);
  });
}
