/** Preflight disposable Desktop resources before starting a native window. */
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

/** DSH package-resolution scopes must not contain their own profile directory. */
export async function assertDesktopDevHome({ source, studio, home }) {
  const actualHome = await canonicalPath(resolve(home));
  for (const root of [source, studio]) {
    const path = relative(await canonicalPath(resolve(root)), actualHome);
    if (!path || (!path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && path !== '..' && !isAbsolute(path))) {
      throw new Error('Set DSH_HOME outside the Studio and DSH source checkouts; nested profiles prevent development plugins from loading');
    }
  }
}

export async function assertDesktopDevResources({ source, primaryRuntime }) {
  if (!source || !primaryRuntime || !isAbsolute(source) || !isAbsolute(primaryRuntime)) {
    throw new Error('Specify absolute DSH source and prepared primary runtime paths; run prepare-studio-desktop-dev.mjs first');
  }
  const assets = join(dirname(primaryRuntime), 'office-skills');
  const manifest = JSON.parse(await readFile(join(primaryRuntime, 'runtime.json'), 'utf8'));
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 2)
    throw new Error('Unsupported Desktop primary runtime resource format');
  const nodeOnly = manifest.schemaVersion === 2;
  if (!nodeOnly || !/^[a-f0-9]{64}$/.test(manifest.officeLibrarySha256 ?? ''))
    throw new Error('Desktop requires Node-only Office authoring resources; run prepare-studio-desktop-dev.mjs again');
  if (nodeOnly && (manifest.python !== undefined || manifest.components !== undefined ||
    Object.keys(manifest.pythonPackages ?? {}).length !== 0 || typeof manifest.node !== 'string'))
    throw new Error('Node-only Desktop resources must declare Node and contain no Python metadata');
  // The Host validates full metadata; this preflight checks its Node Office resources.
  const required = [
    ...['office', 'office-docx', 'office-pptx', 'office-xlsx', 'office-render', 'office-recalculate', 'office-export-pdf']
      .map(name => join(assets, name, 'SKILL.md')),
    join(primaryRuntime, 'runtime.json'),
    ...['office-docx', 'office-pptx', 'office-xlsx', 'office-recalculate'].map(name => join(assets, name, 'SKILL.node.md')),
    join(primaryRuntime, 'dependencies/node/node_modules/office.mjs'),
    join(primaryRuntime, 'dependencies/node/bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    join(primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs')];
  for (const path of required) {
    if (!(await stat(path)).isFile()) throw new Error(`Desktop development resource is not a file: ${path}`);
  }
  const library = await readFile(join(primaryRuntime, 'dependencies/node/node_modules/office.mjs'));
  if (createHash('sha256').update(library).digest('hex') !== manifest.officeLibrarySha256)
    throw new Error('Desktop Office library checksum mismatch; prepare resources again');
  const require = createRequire(join(source, 'apps/desktop-host/package.json'));
  const cli = join(dirname(require.resolve('@deepseek-ai/libreoffice-kit/package.json')), 'lib/cli.js');
  if (!(await stat(cli)).isFile()) throw new Error(`Desktop Office CLI is missing: ${cli}`);
}

/** A fatal native modal can block graceful close; only terminate this verifier's child. */
export async function closeVerificationClient(client, timeoutMs = 5000) {
  if (!client) return;
  const child = client.process?.();
  let timer;
  try {
    await Promise.race([client.close(), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
