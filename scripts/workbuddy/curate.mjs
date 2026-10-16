/** Prepare a personal local catalog from already downloaded packages, never executes them. */
import { readFile, readdir, lstat, mkdir, cp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { markdownDefinition } from './convert.mjs';
import { validateReviewedCatalog } from '../../packages/expert-catalog/src/release.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const adapter = `\n\n## Studio 运行适配\n本专家在 AgentKit Studio 中运行。上文角色与交付要求完整保留；能力以当前会话实际公布的工具为准。\n- Read/Write/Edit/Bash、WebSearch/WebFetch、Skill 等源平台名称，映射为当前运行时实际提供的文件、命令、搜索、网页及 Skill 工具；不要调用不存在的工具名。\n- 优先通过已绑定 Skill 的索引读取 SKILL.md；相对脚本、参考资料与资源路径以该 Skill 的资源目录为基准，完整原包保留在其上层目录。\n- MCP 按本 Agent 已绑定的服务和实际工具列表调用；没有连接的账号、浏览器、外部 API 或应用不代表已经授权。缺少能力时说明缺少的依赖，不编造结果。\n- 知识库与长期记忆使用当前 Agent 的平台绑定；不要读取其他应用的配置、账号或记忆目录。永久记忆仅在用户明确要求保存时写入。\n- 源包中的 maxTurns 等运行配置保留为迁移记录；实际轮数与权限服从当前 Studio 运行时及用户授权。`;
export async function inventory(root, prefix = '') {
  const out = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Package symlink rejected');
    if (entry.isDirectory()) out.push(...await inventory(root, path));
    else if (entry.isFile()) {
      if (/^\.env(?:\.|$)/.test(entry.name) && !/\.(?:example|sample|template)$/.test(entry.name)) throw new Error('Package contains environment data');
      const full = join(root, path), bytes = await readFile(full), info = await lstat(full);
      out.push({ path, size: bytes.length, sha256: hash(bytes), executable: Boolean(info.mode & 0o111) });
    } else throw new Error('Nonregular package entry rejected');
  }
  return out;
}
export async function curate({ input, output }) {
  const draft = await json(join(input, 'converted/catalog.draft.json')), imports = [], excluded = [], packages = [], downloads = await json(join(input, 'downloads.json'));
  const receipts = new Map(downloads.bundles.filter(row => row.status === 'downloaded').map(row => [row.plugin, row]));
  const publicMcpAllow = new Set(['sg-finance-tax', 'sg-biz-dev', 'sg-hr-admin-expert']);
  for (const item of draft.items) {
    const plugin = item.id.replace(/^imported-/, ''), converted = await json(join(input, 'converted', `${plugin}.json`)), root = join(input, 'packages', plugin), reasons = [];
    const receipt = receipts.get(plugin);
    if (!receipt || receipt.sha256 !== item.origin.sourceSha256) reasons.push('source-digest-mismatch');
    if (converted.agents.length !== 1) reasons.push('multiple-agent-definitions');
    if (converted.dependencies.connectors.length) reasons.push('connector-auth-adapter-required');
    if (item.requirements.some(req => req.kind === 'mcp') && !publicMcpAllow.has(plugin)) reasons.push('mcp-adapter-or-authorization-required');
    if (/Proprietary|UNLICENSED|Evaluation/i.test(item.origin.license)) reasons.push('source-use-restriction');
    const paths = await inventory(root).catch(error => { reasons.push(error.message); return []; });
    for (const source of [...converted.agents.map(agent => ({ path: agent.path, sha256: agent.sourceSha256 })), ...converted.skills]) {
      if (paths.find(file => file.path === source.path)?.sha256 !== source.sha256) reasons.push('converted-source-file-changed');
    }
    const texts = [], activeTexts = [];
    for (const file of paths.filter(file => /\.(md|json|py|js|ts|sh|ya?ml)$/i.test(file.path) && file.size < 2 * 1024 * 1024)) {
      const content = await readFile(join(root, file.path), 'utf8'); texts.push(content);
      if (!/^README(?:\.[^/]*)?$/i.test(file.path)) activeTexts.push(content);
    }
    const text = texts.join('\n');
    const patterns = {
      'internal-service': /(?:auth-proxy\.local|\.it\.woa\.com|\.oa\.com|\.tencent\.com\/mcp)/i,
      'otherapp-filesystem': /(?:~\/\.workbuddy|~\/\.codebuddy|\.workbuddy\/settings|open -a ["']?(?:WorkBuddy|CodeBuddy))/i,
      'agent-orchestration': /\b(?:run_in_subagent|spawn_agent|create_agent|AgentTeam|TeamCreate)\b/i,
      'external-credential-adapter': /\$\{(?:user_config\.|[A-Z][A-Z_]+(?:TOKEN|KEY|SECRET|PASSWORD))/i,
      'browser-adapter': /\b(?:mcp__browser|browser_use)\b/i,
    };
    for (const [reason, pattern] of Object.entries(patterns)) if (pattern.test(reason === 'otherapp-filesystem' ? activeTexts.join('\n') : text)
      && !(reason === 'otherapp-filesystem' && publicMcpAllow.has(plugin))) reasons.push(reason);
    if (converted.skills.some(skill => skill.path.split('/').length > 4)) reasons.push('nested-skill-adapter-required');
    if (converted.skills.some(skill => !paths.some(file => file.path === skill.path) || (paths.find(file => file.path === skill.path)?.size || 0) > 512 * 1024)) reasons.push('unreadable-skill-manifest');
    if (reasons.length) { excluded.push({ id: item.id, name: item.name, reasons }); continue; }
    if (hash(await readFile(join(input, 'raw', `${plugin}.tar.gz`))) !== receipt.sha256) {
      excluded.push({ id: item.id, name: item.name, reasons: ['downloaded-archive-changed'] }); continue;
    }
    const skills = [];
    for (const skill of converted.skills) {
      const content = await readFile(join(root, skill.path), 'utf8'), parsed = markdownDefinition(content), path = dirname(skill.path);
      const files = paths.filter(file => file.path.startsWith(`${path}/`));
      const name = String(parsed.metadata.name || path.split('/').pop()), normalized = name.toLowerCase();
      const runtimeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : `bound-skill-${hash(normalized).slice(0, 12)}`;
      skills.push({ path, name, runtimeName, description: String(parsed.metadata.description || ''), version: String(parsed.metadata.version || '1.0.0'), digest: hash(JSON.stringify(files)), fileCount: files.length });
    }
    // Every declared local Skill must exist; undeclared bundled Skills are retained and bound too.
    const declared = Array.isArray(converted.dependencies.skills) ? converted.dependencies.skills : [converted.dependencies.skills];
    if (declared.some(path => typeof path !== 'string' || !skills.some(skill => `./${skill.path}` === path || skill.path === path))) {
      excluded.push({ id: item.id, name: item.name, reasons: ['declared-skill-missing'] }); continue;
    }
    const agentSkills = converted.agents[0].sourceFrontmatter.skills || [];
    if ((Array.isArray(agentSkills) ? agentSkills : [agentSkills]).some(name => !skills.some(skill => [skill.name, skill.runtimeName, skill.path.split('/').pop()].some(value => value.toLowerCase() === String(name).toLowerCase())))) {
      excluded.push({ id: item.id, name: item.name, reasons: ['agent-skill-dependency-missing'] }); continue;
    }
    const mcp = [];
    if (publicMcpAllow.has(plugin)) {
      const manifest = await json(join(root, '.codebuddy-plugin/plugin.json')), server = manifest.dependencies?.mcpServers?.singstat || manifest.mcpServers?.singstat;
      if (!server || server.url !== 'https://chatwithsandra.singstat.gov.sg/mcp' || server.headers || server.command) throw new Error('Public MCP allowlist source changed');
      mcp.push({ key: 'singstat', name: '新加坡统计局 SingStat', description: '新加坡官方公开统计数据；首次召唤时连接并探测。', autoInstall: true, server: { name: 'singstat', transport: 'http', endpointUrl: server.url, version: '1.0.0' } });
    }
    const digest = hash(JSON.stringify(paths)), value = structuredClone(item);
    const metadata = await json(join(root, '.codebuddy-plugin/plugin.json'));
    const avatar = typeof metadata.avatar === 'string' ? metadata.avatar.replace(/^\.\//, '') : '';
    const avatarFile = paths.find(file => file.path === avatar && file.size <= 512 * 1024 && /\.(png|jpe?g|webp)$/i.test(avatar));
    if (avatarFile) value.artwork = { path: avatar, sha256: avatarFile.sha256 };
    value.categoryId = item.categoryId.toLowerCase() === '13-tencentzone' ? 'community-02-engineering' : `community-${item.categoryId.toLowerCase()}`;
    value.dependencies = { package: { path: `packages/${digest}`, digest, files: paths }, skills, mcp };
    value.migration = { originalSystemSha256: hash(item.spec.instructions.system), agentFile: converted.agents[0].path, sourceFrontmatter: converted.agents[0].sourceFrontmatter, adapter: 'studio-tools-v1' };
    value.spec.instructions.system += adapter;
    if (skills.length) value.spec.instructions.system += `\n\n### 配套 Skill 名称映射\n${skills.map(skill => `- ${skill.path.split('/').pop()} → 当前 Skill 工具名称 \`${skill.runtimeName}\``).join('\n')}`;
    value.validation = { state: 'compatibility-checked', reviewedSourceSha256: value.origin.sourceSha256, verifiedRuntimes: [], notes: '通过单专家结构、完整文件摘要、已声明 Skill 和 MCP 映射及平台依赖筛选；业务质量与全部运行组合尚未逐项验收。' };
    value.deliverable = '按完整角色指令与用户任务交付；配套技能自动绑定，外部软件和账号按实际可用能力使用。';
    if (skills.length) value.requirements.find(req => req.kind === 'skill').label = `${skills.length} 项配套技能（自动安装）`;
    if (mcp.length) value.requirements.find(req => req.kind === 'mcp').label = 'SingStat 公开 MCP（自动连接）';
    imports.push(value); packages.push({ root, target: join(output, 'packages', digest) });
  }
  const categoryIds = new Set(imports.map(item => item.categoryId));
  const catalog = { schemaVersion: 1, distribution: 'personal-local', revision: 'community-local-2026-10-15.1',
    categories: draft.categories.map(category => ({ ...category, id: `community-${category.id.toLowerCase()}`, featured: [] })).filter(category => categoryIds.has(category.id)), items: imports };
  validateReviewedCatalog(catalog, { personalLocal: true });
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const entry of packages) { await mkdir(dirname(entry.target), { recursive: true, mode: 0o700 }); await cp(entry.root, entry.target, { recursive: true, errorOnExist: true, force: false }); }
  await writeFile(join(output, 'catalog.json'), JSON.stringify(catalog), { flag: 'wx', mode: 0o600 });
  const report = { selected: imports.length, totalWithBuiltin: imports.length + 18, skills: imports.reduce((sum, item) => sum + item.dependencies.skills.length, 0), mcpBindings: imports.reduce((sum, item) => sum + item.dependencies.mcp.length, 0), files: imports.reduce((sum, item) => sum + item.dependencies.package.files.length, 0), sourceBodiesPreserved: true, runtimeVerified: 0, publicDistribution: false, excluded };
  await writeFile(join(output, 'selection-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return { ...report, excluded: report.excluded.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  if (!['--input', '--output', '--personal-local'].every(flag => args.includes(flag))) throw new Error('Usage: node scripts/workbuddy/curate.mjs --input downloaded-directory --output new-catalog-directory --personal-local');
  console.log(JSON.stringify(await curate({ input: resolve(value('--input')), output: resolve(value('--output')) })));
}
