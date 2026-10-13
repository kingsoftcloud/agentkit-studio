/** Development diagnostics; no configuration, credentials or source reset. */
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareDevelopment } from './prepare-development.mjs';
import { checkInstalledProfile } from './check-profile.mjs';

const { values } = parseArgs({ options: {
  'tools-only': { type: 'boolean' }, ...Object.fromEntries(['source', 'patches', 'commit', 'profile', 'archive'].map(key => [key, { type: 'string' }])),
} });
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 19) || major >= 24)) throw Error('请安装 Node.js 22.19.0（见 .node-version）后重试');
if (process.platform === 'win32') throw Error('这些 Makefile 目标需要 macOS 或 Linux；Windows 请使用 WSL2');
try { await access(resolve(dirname(process.execPath), '../include/node/node_api.h')); }
catch { throw Error('DSH 原生模块需要 Node 开发头文件；请使用包含 include/node 的 Node.js 22.19.0 安装'); }
console.log(`Node.js ${process.versions.node}（验证基线 22.19.0）`);
for (const command of ['git', 'make', 'cc', 'pnpm']) {
  let version;
  try { version = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]; }
  catch { throw Error(`缺少 ${command}；请按 CONTRIBUTING.md 安装开发前置工具`); }
  if (command === 'pnpm' && version !== manifest.packageManager.split('@')[1]) throw Error(`Studio 需要 ${manifest.packageManager}，当前 ${version}；请启用 Corepack`);
  console.log(`${command}: ${version}`);
}
if (!values['tools-only']) {
  if (!values.source || !values.profile || !values.patches || !values.commit) throw Error('请通过 make doctor 调用完整环境检查');
  await prepareDevelopment({ source: values.source, patches: values.patches, commit: values.commit, checkOnly: true });
  for (const file of ['apps/cli/lib/bin.js', 'apps/web/dist/index.html']) {
    try { await access(join(values.source, file)); } catch { throw Error(`DSH 尚未完成构建（${file}）；先执行 make setup`); }
  }
  checkInstalledProfile(resolve(values.profile), manifest.version, values.archive);
  console.log('DSH 固定基线、补丁、编译产物和 Studio Profile 均已就绪。模型及云端凭证请在设置中配置。');
}
