/** Run the official DSH package entry from a pinned, isolated source snapshot. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { withDesktopCheckout } from './desktop-checkout.mjs';
import { snapshotDesktopPluginInputs } from './desktop-plugin-inputs.mjs';
import { exportLocalDmg } from './export-local-dmg.mjs';

const credentialPaths = new Set(['DSH_DESKTOP_WINDOWS_CER_FILE','DSH_DESKTOP_WINDOWS_SIGNTOOL','APPLE_API_KEY','APPLE_KEYCHAIN','CSC_LINK']);

/** Preserve dotenv values exactly while resolving file references against the original configuration. */
export function relocateReleaseSettings(contents, sourceDirectory) {
  let settings;
  try { settings = parseEnv(contents.replace(/^\uFEFF/u,'')); }
  catch { throw new Error('desktop settings: invalid dotenv syntax'); }
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

export async function packageDesktop(options) {
  const {target,unsigned=false,directory=false,source,output,studioVersion,dshVersion}=options;
  const buildVersion=options.buildVersion ?? process.env.DSH_DESKTOP_BUILD_VERSION;
  if (!['mac-arm64','mac-x64'].includes(target)) throw new Error('desktop packaging: unsupported target');
  if (unsigned && (target!=='mac-arm64'||directory)) throw new Error('desktop packaging: local unsigned export requires a mac-arm64 image');
  const environment={...process.env};
  return withDesktopCheckout(options,async checkout=>{
    const manifest=JSON.parse(await readFile(join(checkout,'package.json'),'utf8'));
    if(manifest.version!==dshVersion) throw new Error('desktop packaging: DSH version does not match source snapshot');
    const settingsPath=join(checkout,'apps/desktop/.env.macos');
    let copiedSettings=false;
    const inputs=await snapshotDesktopPluginInputs(environment.DSH_DESKTOP_PLUGIN_INPUTS,dirname(checkout));
    environment.DSH_DESKTOP_PLUGIN_INPUTS=inputs.value;
    const image=join(checkout,`apps/desktop/.desktop-build/targets/${target}/unsigned-artifacts/deepseek-harness-${buildVersion ?? dshVersion}-${target}-unsigned.dmg`);
    try {
      // Signed builds retain the official file-owned configuration and relative credential semantics.
      // No profile, authentication directory or arbitrary ignored file enters the source snapshot.
      if(!unsigned) {
        const sourceDirectory=join(resolve(source),'apps/desktop');
        const settings=relocateReleaseSettings(await readFile(join(sourceDirectory,'.env.macos'),'utf8'),sourceDirectory);
        await mkdir(join(checkout,'apps/desktop'),{recursive:true});
        await writeFile(settingsPath,settings,{mode:0o600,flag:'wx'});
        copiedSettings=true;
      }
      await run('pnpm',['install','--frozen-lockfile'],checkout,environment);
      // The official entrypoint owns the child environment and overwrites its
      // build-version variable. Its CLI argument is the authoritative input.
      const args=['--dir','apps/desktop','run','package',target,...unsigned?['--unsigned']:[],...directory?['--dir']:[],
        ...buildVersion===undefined?[]:['--build-version',buildVersion]];
      if(unsigned) await rm(image,{force:true});
      await run('pnpm',args,checkout,environment);
      if(unsigned) {
        const result=await exportLocalDmg({source:image,output,studioVersion,dshVersion});
        console.log(`Studio unsigned DMG: ${result.path}\nSHA256: ${result.sha256}\nBytes: ${result.bytes}`);
        return result;
      }
      const artifacts=join(checkout,`apps/desktop/.desktop-build/targets/${target}/artifacts`);
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
  return withDesktopCheckout(options, async checkout => {
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
  const {values}=parseArgs({options:Object.fromEntries(['source','output','patches','commit','target','studio-version','dsh-version','build-version'].map(key=>[key,{type:'string'}]).concat([['unsigned',{type:'boolean'}],['directory',{type:'boolean'}],['preflight',{type:'boolean'}]]))});
  const options = {...values,studioVersion:values['studio-version'],dshVersion:values['dsh-version'],buildVersion:values['build-version']};
  if (values.preflight) {
    const result = await verifyDesktopPackageInputs(options);
    console.log(`Desktop package preflight passed in isolated checkout: ${result.checkout}`);
  } else await packageDesktop(options);
}
