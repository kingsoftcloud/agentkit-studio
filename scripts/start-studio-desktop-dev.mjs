/** Launch the same prepared, source-linked Electron runtime used by native acceptance. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.AGENTKIT_DSH_ROOT || !process.env.DSH_HOME) throw new Error('Use make desktop-dev or make desktop-start');
const source = resolve(process.env.AGENTKIT_DSH_ROOT);
const require = createRequire(join(source, 'apps/desktop/package.json'));
const electron = require('electron');
process.env.STUDIO_VERIFY_ELECTRON = electron;
// DSH isolates packages inside another profile. Link this source checkout as
// the development runtime's own dependency, never an adjacent profile's package.
process.env.STUDIO_VERIFY_PLUGIN_ROOT = resolve(import.meta.dirname, '..');
await import('./prepare-studio-desktop-dev.mjs');
const { developmentRuntimeDirectory } = await import(pathToFileURL(join(source, 'apps/desktop/scripts/desktop-build-paths.mjs')).href);
const userData = resolve(process.env.DSH_DESKTOP_USER_DATA_DIR || join(source, 'apps/desktop/.desktop-build/development/electron-user-data'));
const child = spawn(electron, [`--user-data-dir=${userData}`, join(source, 'apps/desktop')], {
  cwd: source, stdio: 'inherit', env: { ...process.env,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: developmentRuntimeDirectory(),
    DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS || '0',
    DSH_DESKTOP_PRODUCT_NAME: 'AgentKit Studio',
  },
});
const interrupt = () => child.kill('SIGINT');
const terminate = () => child.kill('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  process.exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
});
