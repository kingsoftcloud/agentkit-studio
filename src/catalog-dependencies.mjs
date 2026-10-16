/** Host-owned, content-addressed template packages. Never executes imported files. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, realpath, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 409 }); };
function safePath(root, path) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(value => !value || value === '.' || value === '..')) fail('TEMPLATE_ASSET_PATH_INVALID', '模板文件路径无效');
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('TEMPLATE_ASSET_PATH_INVALID', '模板文件路径越界');
  return target;
}
export const catalogSkillId = (bundle, skill) => `skill-catalog-${hash(`${bundle.digest}\0${skill.path}\0${skill.digest}`).slice(0, 24)}`;
export async function verifyPackage(root, manifest) {
  if (!root || !/^[a-f0-9]{64}$/.test(manifest?.digest || '') || !manifest.files?.length || manifest.files.length > 12000
    || hash(JSON.stringify(manifest.files)) !== manifest.digest) fail('TEMPLATE_PACKAGE_INVALID', '模板依赖文件清单无效');
  const base = await realpath(root);
  for (const file of manifest.files) {
    const target = safePath(base, file.path), info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || relative(base, await realpath(target)).startsWith('..')
      || hash(await readFile(target)) !== file.sha256) fail('TEMPLATE_PACKAGE_CHANGED', '模板依赖内容已变化，请重新导入完整资源包');
  }
}
export async function readCatalogAvatar(catalog, ref) {
  if (catalog.avatar) return catalog.avatar(ref);
  const item = catalog.get(ref), { root, dependencies } = catalog.assets(ref);
  const artwork = item.artwork;
  if (!artwork || !dependencies.package) return null;
  const bytes = await readFile(safePath(safePath(root, dependencies.package.path), artwork.path));
  if (bytes.length > 4 * 1024 * 1024 || hash(bytes) !== artwork.sha256) fail('TEMPLATE_ARTWORK_CHANGED', '专家头像内容已变化');
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : '';
  return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
}
export function createCatalogDependencies({ catalog, packageStore, skillDiscovery, mcpStore, probeMcp }) {
  const pending = new Map();
  async function materialize(item, options = {}) {
    const assets = catalog.assets(item), result = [];
    const groups = [assets.dependencies, ...(assets.dependencies.additional || [])], total = groups.reduce((sum,group)=>sum+(group.package?.archive?.bytes||0),0); let completed=0;
    for (const dependencies of groups) {
      options.signal?.throwIfAborted();
      result.push(...await materializeGroup(assets.root, dependencies, {...options,onProgress:event=>options.onProgress?.({...event,received:completed+(event.received||0),total:total||event.total})}));
      completed += dependencies.package?.archive?.bytes||0;
    }
    return result;
  }
  async function materializeGroup(root, dependencies, options = {}) {
    const assets = { root, dependencies }, bundle = dependencies.package;
    if (!bundle) {
      if (assets.dependencies.skills?.length) fail('TEMPLATE_PACKAGE_MISSING', '模板缺少完整 Skill 资源包');
      return [];
    }
    const destination = join(packageStore, bundle.digest);
    const task = async () => {
      if (await lstat(destination).catch(() => null)) { await verifyPackage(destination, bundle); options.onProgress?.({phase:'cache-hit',received:bundle.archive?.bytes||0,total:bundle.archive?.bytes||0,cacheHit:true}); }
      else if (bundle.archive && catalog.packageCache) await (await catalog.packageCache()).ensure(bundle,{destination,verify:verifyPackage,...options});
      else {
        const source = safePath(assets.root, bundle.path);
        await verifyPackage(source, bundle);
        const temporary = join(packageStore, `.prepare-${randomUUID()}`);
        await mkdir(temporary, { recursive: true, mode: 0o700 });
        try {
          for (const file of bundle.files) {
            const target = safePath(temporary, file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, await readFile(safePath(source, file.path)), { mode: file.executable ? 0o700 : 0o600, flag: 'wx' });
          }
          await verifyPackage(temporary, bundle);
          await rename(temporary, destination);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
    };
    if (bundle.archive) await task();
    else { if (!pending.has(bundle.digest)) pending.set(bundle.digest, task().finally(() => pending.delete(bundle.digest))); await pending.get(bundle.digest); }
    options.signal?.throwIfAborted();
    return skillDiscovery.registerBundleSkills((assets.dependencies.skills || []).map(skill => ({
      resourceId: catalogSkillId(bundle, skill), name: skill.name, displayName: skill.name, description: skill.description || '',
      version: skill.version || '1.0.0', kind: 'skill', source: 'catalog-import', status: 'ready',
      digest: skill.digest, fileCount: skill.fileCount, directory: skill.path === '.' ? destination : safePath(destination, skill.path),
    })));
  }
  function matches(row, dependency) {
    return row.server?.transport === dependency.server.transport && (dependency.server.transport === 'stdio'
      ? row.server.command === dependency.server.command && JSON.stringify(row.server.args || []) === JSON.stringify(dependency.server.args || [])
      : row.server?.endpointUrl === dependency.server.endpointUrl)
      && row.status === 'ready';
  }
  async function resolveMcp(item, { install = false } = {}) {
    const result = [], missing = [];
    for (const dependency of item.dependencies?.mcp || []) {
      let row = (await mcpStore.list({ limit: Infinity })).find(value => matches(value, dependency));
      if (row && install) { await probeMcp(row.resourceId); row = await mcpStore.get(row.resourceId); }
      if (!row && install && dependency.autoInstall === true) {
        const same = (await mcpStore.list({ limit: Infinity })).find(value => value.name === dependency.key && value.server?.endpointUrl === dependency.server.endpointUrl);
        row = same || await mcpStore.create({ name: dependency.key, displayName: dependency.name, description: dependency.description, server: dependency.server });
        row = await probeMcp(row.resourceId);
        row = await mcpStore.get(row.resourceId);
      }
      if (!row || !matches(row, dependency)) missing.push({ kind: 'mcp', key: dependency.key, label: dependency.name, endpointUrl: dependency.server.endpointUrl });
      else result.push(row.resourceId);
    }
    return { ids: result, missing };
  }
  return {
    materialize, resolveMcp,
    async validate(item, bindings) {
      const expected = await materialize(item), ids = (bindings.skills || []).map(value => typeof value === 'string' ? value : value.resourceId);
      if (expected.some(skill => !ids.includes(skill.resourceId))) fail('TEMPLATE_SKILL_DEPENDENCY_MISSING', '请绑定此专家完整且匹配版本的配套 Skill');
      const selected = (bindings.mcpServers || []).map(value => typeof value === 'string' ? value : value.resourceId);
      const mcp = await resolveMcp(item);
      if (mcp.missing.length || mcp.ids.some(id => !selected.includes(id))) fail('TEMPLATE_MCP_DEPENDENCY_MISSING', '请先连接并探测此专家所需的 MCP 服务');
    },
  };
}
