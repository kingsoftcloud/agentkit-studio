/** Invoke with the isolated DSH checkout's tsx; generate its disposable Electron runtime. */
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertDesktopDevHome, assertDesktopDevResources } from './desktop-dev-resources.mjs';
const root = resolve(process.env.AGENTKIT_DSH_ROOT || '');
if (!process.env.AGENTKIT_DSH_ROOT || !process.env.DSH_HOME || !process.env.STUDIO_VERIFY_ELECTRON) throw new Error('Specify isolated DSH root/home and real Electron executable');
if (process.env.STUDIO_VERIFY_PLUGIN_ROOT) await assertDesktopDevHome({ source: root, studio: process.env.STUDIO_VERIFY_PLUGIN_ROOT, home: process.env.DSH_HOME });
const load = path => import(pathToFileURL(join(root, path)).href);
const { prepareDevelopmentProject } = await load('apps/desktop/scripts/development-project.ts');
const { preparePrimaryRuntime } = await load('apps/desktop/scripts/prepare-primary-runtime.ts');
const { developmentRuntimeDirectory, resolveDesktopBuildTarget } = await load('apps/desktop/scripts/desktop-build-paths.mjs');
const { DESKTOP_HOST_PROTOCOL_VERSION } = await load('apps/desktop/src/host-protocol.ts');
const pkg = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
const manager = JSON.parse(await readFile(join(root, 'apps/desktop/node_modules/pnpm/package.json'), 'utf8'));
const nodeVersion = execFileSync(process.env.STUDIO_VERIFY_ELECTRON, ['-p', 'process.versions.node'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).trim();
const project = join(root, 'apps/desktop/.desktop-build/development/project');
prepareDevelopmentProject({ projectDir: project, cliDir: join(root, 'apps/cli'), hostDir: join(root, 'apps/desktop-host'), dependencyDir: join(root, 'node_modules/.pnpm/node_modules'),
  release: { schemaVersion: 1, version: pkg.version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion, pnpmVersion: manager.version }, target: resolveDesktopBuildTarget() });
// Match the official dev launcher: the plugin project is not the Office/interpreter payload.
await preparePrimaryRuntime();
const primaryRuntime = developmentRuntimeDirectory();
await assertDesktopDevResources({ source: root, primaryRuntime });
const profile = process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor';
const installed = process.env.STUDIO_VERIFY_PLUGIN_ROOT
  ? resolve(process.env.STUDIO_VERIFY_PLUGIN_ROOT)
  : join(resolve(process.env.DSH_HOME), 'profiles', profile, 'node_modules/@kingsoftcloud/agentkit-studio');
const studio = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
manifest.dependencies[studio.name] = studio.version;
manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', studio.name] } };
await writeFile(join(project, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
const descriptor = JSON.parse(await readFile(join(project, 'desktop-runtime.json'), 'utf8'));
descriptor.sharedPackages.push({ name: studio.name, version: studio.version, path: `node_modules/${studio.name}` });
await writeFile(join(project, 'desktop-runtime.json'), JSON.stringify(descriptor, null, 2) + '\n');
const link = join(project, 'node_modules', studio.name);
await mkdir(dirname(link), { recursive: true });
await symlink(installed, link);
console.log(JSON.stringify({ project, primaryRuntime, studioVersion: studio.version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion, developmentOnly: true }));
