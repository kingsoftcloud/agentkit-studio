import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeReviewedPatchFixture } from './helpers/reviewed-patch-series.mjs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareDesktopCheckout, withDesktopCheckout } from '../scripts/desktop-checkout.mjs';

// The fake compiler still emits the release metadata checked at the delivery boundary.
const sealedUpdateFixture = `if (process.argv.includes('package')) {
  const target = process.argv.includes('win-x64') ? 'win-x64' : 'mac-arm64';
  const resources = process.cwd() + '/apps/desktop/.desktop-build/targets/' + target + '/artifacts/' + (target === 'win-x64' ? 'win-unpacked/resources' : 'mac-arm64/AgentKit Studio.app/Contents/Resources');
  fs.mkdirSync(resources, {recursive:true});
  fs.writeFileSync(resources + '/app-update.yml', JSON.stringify({provider:'generic',url:'https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/feeds/' + target + '/',channel:'preview',updaterCacheDirName:'studio-updater'}));
}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-build-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'live source'); const output = join(root, 'output'); const patches = join(root, 'patches');
  await mkdir(source); await mkdir(patches);
  const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  await writeFile(join(source, '.gitignore'), 'dist/\nnode_modules/\n.desktop-build/\n.env*\napps/desktop/.env*\n');
  await writeFile(join(source, 'package.json'), '{"version":"0.2.0-rc.2"}');
  await writeFile(join(source, 'client.js'), 'original source\n');
  git(['add', '.']); git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','baseline']);
  const commit = git(['rev-parse','HEAD']);
  await writeFile(join(source, 'client.js'), 'patched source\n');
  await writeFile(join(patches, '001-client.patch'), git(['diff']) + '\n');
  await writeReviewedPatchFixture(patches, commit, source);
  await mkdir(join(source, 'dist')); await writeFile(join(source, 'dist/client.js'), 'live browser bundle');
  await mkdir(join(source, 'node_modules')); await writeFile(join(source, 'node_modules/owner'), 'live dependencies');
  await writeFile(join(source, '.env.local'), 'PRIVATE=must-not-copy');
  return { source, output, patches, commit, root };
}

test('official build writes cannot replace live web bundles or workspace dependencies', async t => {
  const input = await fixture(t);
  const checkout = await prepareDesktopCheckout(input);
  assert.notEqual(checkout, input.source);
  assert.equal(execFileSync('git', ['config', '--local', 'core.longpaths'], { cwd: checkout, encoding: 'utf8' }).trim(), 'true');
  assert.equal(await readFile(join(checkout,'client.js'),'utf8'),'patched source\n');
  await assert.rejects(access(join(checkout,'.env.local')));
  await assert.rejects(access(join(checkout,'node_modules/owner')));
  await withDesktopCheckout(input, async directory => {
    assert.equal(directory, checkout);
    // Same destructive clean-and-rebuild as the official build; only its expensive compiler is omitted.
    await rm(join(directory,'dist'),{recursive:true,force:true});
    await mkdir(join(directory,'dist'));
    await writeFile(join(directory,'dist/client.js'),'release browser bundle');
    await mkdir(join(directory,'node_modules'));
    await writeFile(join(directory,'node_modules/owner'),'release dependencies');
  });
  assert.equal(await readFile(join(input.source,'dist/client.js'),'utf8'),'live browser bundle');
  assert.equal(await readFile(join(input.source,'node_modules/owner'),'utf8'),'live dependencies');
  assert.equal(await prepareDesktopCheckout(input),checkout,'reuse isolated outputs without rewriting live source');
});

test('dirty cached source and overlapping builds fail without resetting files', async t => {
  const input = await fixture(t);
  await withDesktopCheckout(input, async directory => {
    await assert.rejects(withDesktopCheckout(input,async()=>{}),/already in use/);
    await writeFile(join(directory,'client.js'),'local edit must survive\n');
  });
  await assert.rejects(prepareDesktopCheckout(input),/modified/);
});

test('verified build caches survive changes to Git diff presentation', async t => {
  const input = await fixture(t), checkout = await prepareDesktopCheckout(input);
  execFileSync('git', ['config', 'core.abbrev', '12'], { cwd: checkout });
  execFileSync('git', ['config', 'diff.mnemonicPrefix', 'true'], { cwd: checkout });
  assert.equal(await prepareDesktopCheckout(input), checkout);
});

test('legacy cache metadata migrates only after the original fingerprint verifies', async t => {
  const input = await fixture(t), checkout = await prepareDesktopCheckout(input);
  const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: checkout, encoding: 'utf8' }).trim();
  const digest = createHash('sha256').update(diff).digest('hex'), record = join(dirname(checkout), 'snapshot.json');
  await writeFile(record, JSON.stringify({ commit: input.commit, digest }));
  assert.equal(await prepareDesktopCheckout(input), checkout);
  assert.equal(JSON.parse(await readFile(record, 'utf8')).schemaVersion, 2);
  await writeFile(record, JSON.stringify({ commit: input.commit, digest: '0'.repeat(64) }));
  await assert.rejects(prepareDesktopCheckout(input), /legacy cache cannot be verified/);
});

test('wrong baseline and invalid patch cannot reach a build', async t => {
  const input = await fixture(t);
  await assert.rejects(prepareDesktopCheckout({...input,commit:'0'.repeat(40)}),/baseline/);
  await writeFile(join(input.patches,'002-broken.patch'),'not a patch');
  await assert.rejects(withDesktopCheckout(input,async()=>assert.fail('must not build')));
  assert.equal(await readFile(join(input.source,'client.js'),'utf8'),'patched source\n');
});

test('isolated packaging ignores a Windows-style global CRLF checkout setting', async t => {
  const input=await fixture(t);
  const configuration=join(input.root,'windows-gitconfig');await writeFile(configuration,'[core]\n  autocrlf = true\n');
  const {promisify}=await import('node:util'); const {execFile}=await import('node:child_process');
  const code=`import {prepareDesktopCheckout} from './scripts/desktop-checkout.mjs';import fs from 'node:fs/promises';const root=await prepareDesktopCheckout(${JSON.stringify(input)});if(await fs.readFile(root+'/client.js','utf8')!=='patched source\\n')throw Error('Unexpected CRLF translation');`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{env:{...process.env,GIT_CONFIG_GLOBAL:configuration}});
});

test('release settings preserve secrets and resolve only credential file references', async () => {
  const {relocateReleaseSettings}=await import('../scripts/package-desktop.mjs');
  const {parseEnv}=await import('node:util');
  const sourceDirectory=join(tmpdir(),'release-config');
  const contents="CSC_LINK='./keys/distribution.p12'\nCSC_KEY_PASSWORD='quoted \"value\" # $HOME'\nAPPLE_API_KEY=./keys/key.p8\nDSH_DESKTOP_MACOS_SIGNING_IDENTITY=Example\n";
  const projected=parseEnv(relocateReleaseSettings(contents,sourceDirectory));
  assert.equal(projected.CSC_LINK,join(sourceDirectory,'keys/distribution.p12'));
  assert.equal(projected.APPLE_API_KEY,join(sourceDirectory,'keys/key.p8'));
  assert.equal(projected.CSC_KEY_PASSWORD,parseEnv(contents).CSC_KEY_PASSWORD);
});

test('CI build version reaches the official package CLI instead of being lost in its environment', async t => {
  const studioVersion=(await import('../package.json',{with:{type:'json'}})).default.version;
  const input=await fixture(t);
  const bin=join(input.root,'bin'); await mkdir(bin);
  const calls=join(input.root,'calls.jsonl');
  const fake=join(bin,'pnpm');
  const launchToken=['fixture','launch','key'].join('-');
  await writeFile(fake,`#!${process.execPath}\nimport('node:fs').then(fs=>{fs.appendFileSync(process.env.PACKAGE_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');${sealedUpdateFixture}});
process.stdout.write('dsh web: http://127.0.0.1:12345/?tok');
setImmediate(()=>{process.stdout.write('en=${launchToken}');process.stderr.write('diagnostic http://127.0.0.1:12345/?mode=web&token=${launchToken}');});\n`);
  await chmod(fake,0o755);
  await mkdir(join(input.source,'apps/desktop'),{recursive:true});
  await writeFile(join(input.source,'apps/desktop/.env.macos'),'DSH_DESKTOP_APP_ID=com.example.studio\n');
  const {promisify}=await import('node:util'); const {execFile}=await import('node:child_process');
  const build=await promisify(execFile)(process.execPath,['scripts/package-desktop.mjs',
    '--source',input.source,'--output',input.output,'--patches',input.patches,'--commit',input.commit,
    '--target','mac-arm64','--dsh-version','0.2.0-rc.2','--studio-version',studioVersion],{
    env:{...process.env,PATH:`${bin}:${process.env.PATH}`,PACKAGE_CALLS:calls,DSH_DESKTOP_PLUGIN_INPUTS:'',DSH_DESKTOP_BUILD_VERSION:'0.2.0-rc.2.20261012.0'},
  });
  for(const output of [build.stdout,build.stderr]) {
    assert.equal(output.includes(launchToken),false,'child launch tokens must be masked before reaching build output');
    assert.match(output,/token=\[redacted\]/);
  }
  const recorded=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(recorded[1],['--dir','apps/desktop','run','package','mac-arm64','--build-version','0.2.0-rc.2.20261012.0']);
});

test('Windows target reads its own settings and delegates NSIS packaging to DSH', async t => {
  const studioVersion=(await import('../package.json',{with:{type:'json'}})).default.version;
  const input=await fixture(t);
  const bin=join(input.root,'bin'); await mkdir(bin);
  const calls=join(input.root,'windows-calls.jsonl');
  await writeFile(join(bin,'pnpm'),`#!${process.execPath}\nimport('node:fs').then(fs=>{fs.appendFileSync(process.env.PACKAGE_CALLS,JSON.stringify({args:process.argv.slice(2),settings:fs.readFileSync('apps/desktop/.env.windows','utf8')})+'\\n');${sealedUpdateFixture}});\n`,{mode:0o755});
  await mkdir(join(input.source,'apps/desktop'),{recursive:true});
  await writeFile(join(input.source,'apps/desktop/.env.windows'),'DSH_DESKTOP_WINDOWS_SIGNING_MODE=certificate-store\n');
  const {promisify}=await import('node:util'); const {execFile}=await import('node:child_process');
  await promisify(execFile)(process.execPath,['scripts/package-desktop.mjs',
    '--source',input.source,'--output',input.output,'--patches',input.patches,'--commit',input.commit,
    '--target','win-x64','--dsh-version','0.2.0-rc.2','--studio-version',studioVersion,'--build-version','0.2.0-rc.2.20261013.20'],{
    env:{...process.env,PATH:`${bin}:${process.env.PATH}`,PACKAGE_CALLS:calls,DSH_DESKTOP_PLUGIN_INPUTS:''},
  });
  const recorded=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(recorded[1].args,['--dir','apps/desktop','run','package','win-x64','--build-version','0.2.0-rc.2.20261013.20']);
  assert.match(recorded[1].settings,/SIGNING_MODE='certificate-store'/);
  assert.match(recorded[1].settings,/DSH_DESKTOP_APP_ID='com.kingsoftcloud.agentkit-studio'/);
  assert.match(recorded[1].settings,/DSH_DESKTOP_UPDATE_CHANNEL='preview'/);
  const checkout=await prepareDesktopCheckout(input);
  await assert.rejects(access(join(checkout,'apps/desktop/.env.windows')),'release identity must be removed after packaging');
});

test('Windows package manager runs the real CLI without shell expansion', async () => {
  const {packageManagerInvocation}=await import('../scripts/package-desktop.mjs');
  const script=join(tmpdir(),'pnpm tool/bin/pnpm.cjs');
  assert.deepEqual(packageManagerInvocation('win32',{npm_execpath:script}),{command:process.execPath,args:[script]});
  assert.throws(()=>packageManagerInvocation('win32',{}),/pnpm exec node/);
  assert.throws(()=>packageManagerInvocation('win32',{npm_execpath:'pnpm.cmd'}),/absolute/);
});

test('Windows action-setup installation resolves pnpm even when exec omits npm_execpath', async t => {
  const root=await mkdtemp(join(tmpdir(),'studio-win-pnpm-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const packageRoot=join(root,'node_modules/pnpm');await mkdir(packageRoot,{recursive:true});
  await writeFile(join(packageRoot,'package.json'),JSON.stringify({name:'pnpm',bin:{pnpm:'bin/pnpm.mjs'}}));
  const {packageManagerInvocation}=await import('../scripts/package-desktop.mjs');
  assert.deepEqual(packageManagerInvocation('win32',{PNPM_HOME:join(root,'node_modules/.bin')}),{command:process.execPath,args:[join(packageRoot,'bin/pnpm.mjs')]});
});

test('DSH commands restore version selection after Studio selected a different pnpm', async t => {
  const { packageManagerEnvironment } = await import('../scripts/package-desktop.mjs');
  const inherited = { npm_config_manage_package_manager_versions: 'false', pnpm_config_pm_on_fail: 'ignore', STUDIO_TEST_INPUT: 'preserved' };
  const { promisify } = await import('node:util'); const { execFile } = await import('node:child_process');
  const script = `if (process.env.npm_config_manage_package_manager_versions !== 'true' || process.env.pnpm_config_pm_on_fail !== 'download' || process.env.STUDIO_TEST_INPUT !== 'preserved') process.exit(1)`;
  await promisify(execFile)(process.execPath, ['-e', script], { env: packageManagerEnvironment(inherited) });
  assert.equal(inherited.npm_config_manage_package_manager_versions, 'false');
  assert.equal(inherited.pnpm_config_pm_on_fail, 'ignore');
});

test('plugin inputs are frozen before a second pack replaces the shared version file', async t => {
  const input=await fixture(t);
  const {snapshotDesktopPluginInputs}=await import('../scripts/desktop-plugin-inputs.mjs');
  const {delimiter}=await import('node:path');
  const first=join(input.root,'plugins-a');const second=join(input.root,'plugins-b');
  await mkdir(first);await mkdir(second);
  await writeFile(join(first,'same.tgz'),'version A');await writeFile(join(second,'same.tgz'),'plugin B');
  const snapshot=await snapshotDesktopPluginInputs([first,second].join(delimiter),input.root);
  try {
    await writeFile(join(first,'same.tgz'),'a later concurrent pack');
    const [frozenA,frozenB]=snapshot.value.split(delimiter);
    assert.equal(await readFile(join(frozenA,'same.tgz'),'utf8'),'version A');
    assert.equal(await readFile(join(frozenB,'same.tgz'),'utf8'),'plugin B');
  } finally {await snapshot.dispose();}
  await assert.rejects(access(snapshot.value.split(delimiter)[0]));
});
