/** Run the official DSH package entry from a pinned, isolated source snapshot. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { withDesktopCheckout } from './desktop-checkout.mjs';
import { snapshotDesktopPluginInputs } from './desktop-plugin-inputs.mjs';
import { exportLocalDmg } from './export-local-dmg.mjs';
import { checkPatchManifest } from './check-patch-manifest.mjs';
import { assertPatchedSource } from './patched-source-fingerprint.mjs';
import { resolveProductInputs } from './product-config.mjs';

const credentialPaths = new Set(['DSH_DESKTOP_WINDOWS_CER_FILE','DSH_DESKTOP_WINDOWS_SIGNTOOL','APPLE_API_KEY','APPLE_KEYCHAIN','CSC_LINK']);

function parseReleaseSettings(contents) {
  try { return parseEnv(contents.replace(/^\uFEFF/u,'')); }
  catch { throw new Error('desktop settings: invalid dotenv syntax'); }
}

/** Preserve dotenv values exactly while resolving file references against the original configuration. */
export function relocateReleaseSettings(contents, sourceDirectory, publicSettings = {}) {
  const settings = parseReleaseSettings(contents);
  Object.assign(settings, publicSettings);
  for (const name of credentialPaths) if (settings[name]?.trim()) settings[name] = resolve(sourceDirectory,settings[name].trim());
  const result = Object.entries(settings).map(([name,value])=>{
    const quote = ["'",'`','"'].find(candidate=>!value.includes(candidate));
    if (!quote || value.includes('\0') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('desktop settings: unsupported dotenv value; configuration was not copied');
    return `${name}=${quote}${value}${quote}`;
  }).join('\n')+'\n';
  if (!isDeepStrictEqual(parseEnv(result),settings)) throw new Error('desktop settings: values cannot be preserved exactly; configuration was not copied');
  return result;
}

function run(command,args,cwd,env) {
  return new Promise((accept,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',(code,signal)=>code===0?accept():reject(new Error(`desktop packaging command failed (${code ?? signal})`)));
  });
}

/** Windows cannot spawn a .cmd shim directly. Use the package manager's actual CLI. */
export function packageManagerInvocation(platform, environment, script = environment.npm_execpath) {
  if (platform !== 'win32') return { command: 'pnpm', args: [] };
  if (!script && environment.PNPM_HOME) {
    const packageRoot=resolve(environment.PNPM_HOME,'..','pnpm');
    try {
      const manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
      const bin=typeof manifest.bin==='string'?manifest.bin:manifest.bin?.pnpm;
      if (manifest.name==='pnpm' && /^bin\/[A-Za-z0-9._-]+\.(?:c?js|mjs)$/.test(bin || '')) script=resolve(packageRoot,bin);
    } catch { /* Fall through to the explicit, actionable CLI error. */ }
  }
  if (!script || !isAbsolute(script) || !/\.(?:c?js|mjs|exe)$/i.test(script)) {
    throw new Error('Windows packaging: run with pnpm exec node, or supply --pnpm-script with the absolute pnpm CLI path');
  }
  return /\.exe$/i.test(script) ? { command: script, args: [] } : { command: process.execPath, args: [script] };
}

/** pnpm disables version switching in its children after switching for Studio.
 * A separate DSH workspace must select its own pinned package manager again.
 */
export function packageManagerEnvironment(environment) {
  return { ...environment, npm_config_manage_package_manager_versions: 'true', pnpm_config_pm_on_fail: 'download' };
}

export async function packageDesktop(options) {
  const {target,unsigned=false,directory=false,source,output,dshVersion}=options;
  const requestedBuildVersion=options.buildVersion ?? process.env.DSH_DESKTOP_BUILD_VERSION;
  if (!['mac-arm64','mac-x64','win-x64'].includes(target)) throw new Error('desktop packaging: unsupported target');
  if (unsigned && target !== 'win-x64' && (target!=='mac-arm64'||directory)) throw new Error('desktop packaging: local unsigned export requires a mac-arm64 image');
  const { manifest: patchManifest } = await checkPatchManifest(options.patches, { baseCommit: options.commit });
  const product = resolveProductInputs({ target, dshVersion, buildVersion: requestedBuildVersion, pluginVersion: options.studioVersion });
  const { pluginVersion: studioVersion, desktopVersion: buildVersion } = product;
  const environment=packageManagerEnvironment({ ...product.environment, ...process.env });
  const manager = packageManagerInvocation(process.platform, environment, options.pnpmScript);
  const invoke = (args, cwd) => run(manager.command, [...manager.args, ...args], cwd, environment);
  return withDesktopCheckout(options,async checkout=>{
    await assertPatchedSource(checkout, patchManifest);
    const manifest=JSON.parse(await readFile(join(checkout,'package.json'),'utf8'));
    if(manifest.version!==dshVersion) throw new Error('desktop packaging: DSH version does not match source snapshot');
    const settingsName=target==='win-x64'?'.env.windows':'.env.macos';
    const settingsPath=join(checkout,'apps/desktop',settingsName);
    let copiedSettings=false;
    const inputs=await snapshotDesktopPluginInputs(environment.DSH_DESKTOP_PLUGIN_INPUTS,dirname(checkout));
    environment.DSH_DESKTOP_PLUGIN_INPUTS=inputs.value;
    const image=join(checkout,`apps/desktop/.desktop-build/targets/${target}/unsigned-artifacts/deepseek-harness-${buildVersion ?? dshVersion}-${target}-unsigned.dmg`);
    try {
      // Signed builds retain the official file-owned configuration and relative credential semantics.
      // No profile, authentication directory or arbitrary ignored file enters the source snapshot.
      if(!unsigned || target==='win-x64') {
        const sourceDirectory=join(resolve(source),'apps/desktop');
        const original = await readFile(join(sourceDirectory,settingsName),'utf8');
        const releaseSettings = parseReleaseSettings(original);
        const releaseProduct = resolveProductInputs({ target, dshVersion, buildVersion,
          updateOrigin: releaseSettings.DSH_DESKTOP_UPDATE_ORIGIN,
          updateChannel: releaseSettings.DSH_DESKTOP_UPDATE_CHANNEL,
          updateEnvironment: releaseSettings.DSH_DESKTOP_AUTO_UPDATE_ENV,
        });
        const settings=relocateReleaseSettings(original,sourceDirectory,releaseProduct.settings);
        await mkdir(join(checkout,'apps/desktop'),{recursive:true});
        await writeFile(settingsPath,settings,{mode:0o600,flag:'wx'});
        copiedSettings=true;
      }
      await invoke(['install','--frozen-lockfile'],checkout);
      // The official entrypoint owns the child environment and overwrites its
      // build-version variable. Its CLI argument is the authoritative input.
      const args=['--dir','apps/desktop','run','package',target,...unsigned?['--unsigned']:[],...directory?['--dir']:[],
        ...buildVersion===undefined?[]:['--build-version',buildVersion]];
      if(unsigned && target!=='win-x64') await rm(image,{force:true});
      await invoke(args,checkout);
      if(unsigned && target!=='win-x64') {
        const result=await exportLocalDmg({source:image,output,studioVersion,dshVersion});
        console.log(`Studio unsigned DMG: ${result.path}\nSHA256: ${result.sha256}\nBytes: ${result.bytes}`);
        return result;
      }
      const artifacts=join(checkout,`apps/desktop/.desktop-build/targets/${target}/${unsigned?'unsigned-artifacts':'artifacts'}`);
      console.log(`Official desktop artifacts: ${artifacts}`);
      return {artifacts};
    } finally {
      try { if(copiedSettings) await rm(settingsPath,{force:true}); }
      finally { await inputs.dispose(); }
    }
  });
}

/**
 * Prepare the same isolated, patched source snapshot used by packaging and
 * verify the desktop hooks there. The live DSH checkout intentionally stays
 * at the pinned clean commit; plugin and unsigned-package hooks arrive only
 * through the versioned patch series in the isolated checkout.
 */
export async function verifyDesktopPackageInputs(options) {
  const { manifest } = await checkPatchManifest(options.patches, { baseCommit: options.commit });
  return withDesktopCheckout(options, async checkout => {
    await assertPatchedSource(checkout, manifest);
    const required = [
      ['apps/desktop/scripts/prepare-package-set.ts', 'DSH_DESKTOP_PLUGIN_INPUTS'],
      ['apps/desktop/src/project-manager.ts', 'DSH_DESKTOP_PLUGIN_BUNDLES'],
      ['apps/desktop/scripts/package-target.ts', 'invocation.unsigned && target.platform'],
    ];
    for (const [relative, marker] of required) {
      const path = join(checkout, relative);
      let contents;
      try { contents = await readFile(path, 'utf8'); }
      catch { throw new Error(`desktop preflight: patched checkout is missing ${relative}`); }
      if (!contents.includes(marker)) throw new Error(`desktop preflight: patched checkout is missing ${marker}`);
    }
    return { checkout, required: required.map(([relative]) => relative) };
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const {values}=parseArgs({options:Object.fromEntries(['source','output','patches','commit','target','studio-version','dsh-version','build-version','pnpm-script'].map(key=>[key,{type:'string'}]).concat([['unsigned',{type:'boolean'}],['directory',{type:'boolean'}],['preflight',{type:'boolean'}]]))});
  const options = {...values,studioVersion:values['studio-version'],dshVersion:values['dsh-version'],buildVersion:values['build-version'],pnpmScript:values['pnpm-script']};
  if (values.preflight) {
    const result = await verifyDesktopPackageInputs(options);
    console.log(`Desktop package preflight passed in isolated checkout: ${result.checkout}`);
  } else await packageDesktop(options);
}
