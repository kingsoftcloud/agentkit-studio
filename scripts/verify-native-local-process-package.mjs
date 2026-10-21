// Component cold execution from the actual Studio tarball. No source-tree
// imports/node_modules, installer, compiler, Docker or Python at runtime.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const archive = process.argv[2];
if (!archive) throw Error('usage: node scripts/verify-native-local-process-package.mjs <Studio.tgz>');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'native-local-process-package-')));
const native = 'packages/agentkit-harness/src/native';
const files = ['local-process.mjs', 'local-process-launcher.c', 'local-process-manifest.json',
  'local-background.mjs', 'local-background-supervisor.mjs', 'local-command-state.mjs',
  ...['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(target => `local-process-bin/${target}/launcher`),
  ...['NOTICE', 'musl-COPYRIGHT', 'GCC-COPYING3', 'GCC-COPYING.RUNTIME'].map(name => `local-process-licenses/${name}`)];
try {
  execFileSync('tar', ['-xzf', resolve(archive), '-C', directory, ...files.map(file => `package/${native}/${file}`),
    'package/scripts/check-local-process-launcher.mjs']);
  const root = join(directory, 'package'), workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const env = { PATH: join(directory, 'no-programs'), NODE_NO_WARNINGS: '1' };
  const checked = execFileSync(process.execPath, [join(root, 'scripts/check-local-process-launcher.mjs'), root], {
    cwd: workspace, env, encoding: 'utf8', timeout: 10_000,
  });
  const moduleUrl = pathToFileURL(join(root, native, 'local-process.mjs')).href;
  const code = `import {runBoundedProcess,buildScriptEnvironment} from ${JSON.stringify(moduleUrl)};
    const result = await runBoundedProcess({argv:['/bin/sh','-c','printf packaged-process; printf stderr >&2; ulimit -Hn > fd-limit'],
      cwd:process.cwd(),env:buildScriptEnvironment(process.env),settings:{maxOpenFiles:64,maxFileBytes:1001}});
    console.log(JSON.stringify(result));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: workspace, env, encoding: 'utf8', timeout: 10_000,
  }));
  assert.equal(result.stdout, 'packaged-process'); assert.equal(result.stderr, 'stderr'); assert.equal(result.exitCode, 0);
  assert.equal(result.controls.status, process.platform === 'darwin' ? 'partial' : 'applied'); assert.equal(result.cleanupError, null);
  assert.equal(result.controls.applied.maxOpenFiles, 64); assert.equal(result.controls.applied.maxFileBytes, 1001);
  const backgroundUrl = pathToFileURL(join(root, native, 'local-background.mjs')).href;
  const backgroundCode = `import {LocalCommandStore,createLocalBackgroundReader} from ${JSON.stringify(backgroundUrl)};
    import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
    const config={stateRoot:${JSON.stringify(join(directory, 'private-state'))},workspaceRoot:process.cwd(),sessionId:'packaged-session'};
    const request={operationKey:'packed-effect',command:'printf x >> count; printf packaged-background',cwd:process.cwd(),env:{PATH:process.env.PATH}};
    const store=new LocalCommandStore(config),handle=await store.start(request),result=await handle.wait({timeoutMs:10000});
    assert.equal(result.status,'completed');assert.equal(result.stdout,'packaged-background');assert.equal(result.exitCode,0);
    const reopened=new LocalCommandStore(config),again=await reopened.start(request);assert.equal(again.commandId,handle.commandId);
    const observed=await createLocalBackgroundReader(reopened)({sessionId:config.sessionId,ref:{taskId:handle.commandId,operationKey:request.operationKey},
      stdoutCursor:0,stderrCursor:0,maxBytes:8192,waitSeconds:0,signal:new AbortController().signal});
    assert.equal(observed.stdout,'packaged-background');assert.equal(readFileSync('count','utf8'),'x');
    console.log('packed background supervisor/reopen/owned observation: passed');`;
  const background = execFileSync(process.execPath, ['--input-type=module', '-e', backgroundCode], {
    cwd: workspace, env, encoding: 'utf8', timeout: 20_000,
  });
  console.log(checked.trim()); console.log(background.trim());
  console.log('native local process package: packed foreground/background execution, empty PATH, no dependency installation passed');
} finally { rmSync(directory, { recursive: true, force: true }); }
