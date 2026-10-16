/** Preflight disposable Desktop resources before starting a native window. */
import { realpath, stat } from 'node:fs/promises';
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
  // Check the same mandatory resources used by Desktop Office, without starting Electron.
  const required = [join(assets, 'scripts/check_office.py'),
    ...['office-docx', 'office-pptx', 'office-xlsx'].map(name => join(assets, name, 'SKILL.md')),
    join(primaryRuntime, 'runtime.json'),
    join(primaryRuntime, 'dependencies/node/bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    join(primaryRuntime, 'dependencies/python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin/python3'])),
    join(primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs')];
  for (const path of required) {
    if (!(await stat(path)).isFile()) throw new Error(`Desktop development resource is not a file: ${path}`);
  }
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
