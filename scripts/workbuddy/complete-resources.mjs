/** Cross-package dependency resolution and a separate installable resource directory. */
import { readFile, readdir, cp, mkdir, writeFile, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inventory } from './curate.mjs';
import { markdownDefinition } from './convert.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const optionalJson = async path => { try { return await json(path); } catch { return {}; } };
const runtimeName = name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.toLowerCase()) ? name.toLowerCase() : `bound-skill-${hash(name.toLowerCase()).slice(0, 12)}`;

export function implicitSkillNames(text = '', knownNames = new Set()) {
  const names = new Set();
  // @npm scopes, email addresses, CSS decorators and source-code annotations are not Skills.
  const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  for (const line of prose.split('\n')) {
    if (/(?:可联动|优先|兜底|optional|fallback|不可用时)/i.test(line) && !/(?:必须|强制|always|must)/i.test(line)) continue;
    for (const match of line.matchAll(/(?:^|\s)@([a-z][a-z0-9-]{2,})(?![a-z0-9_/-])/gi)) {
      const name = match[1].toLowerCase();
      if (knownNames.has(name) || /\bskills?\b|技能/i.test(line)) names.add(name);
    }
    for (const pattern of [/`([a-z][a-z0-9-]{2,})`\s*(?:skills?\b|技能)/gi,
      /(?:load|invoke|调用|加载)\s+(?:the\s+)?(?:skill|技能)\s+`([a-z][a-z0-9-]{2,})`/gi]) {
      for (const match of line.matchAll(pattern)) names.add(match[1].toLowerCase());
    }
  }
  return [...names];
}
export function mcpPreset(key, value = {}) {
  const requiredCredentials = [], reasons = [], server = { name: key, version: '1.0.0', transport: value.command ? 'stdio' : /sse/i.test(value.type || value.transport || '') ? 'sse' : 'http', envRefs: {} };
  const credential = (header, input) => {
    const placeholder = String(input).match(/\$\{(?:user_config\.)?([A-Za-z_][A-Za-z0-9_]*)\}/);
    const name = placeholder?.[1] || `STUDIO_MCP_${key.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_${header.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
    server.envRefs[header] = `env://${name}`; requiredCredentials.push({ header, name });
  };
  if (server.transport === 'stdio') {
    server.command = String(value.command); server.args = Array.isArray(value.args) ? value.args.map(String) : [];
    server.env = {};
    for (const [name, input] of Object.entries(value.env || {})) {
      if (/\$\{|TOKEN|SECRET|PASSWORD|API_KEY/i.test(`${name} ${input}`)) credential(name, input);
      else server.env[name] = String(input);
    }
    if (server.args.some(arg => /\$\{/.test(arg))) reasons.push('启动参数需要当前环境配置');
  } else {
    const rawUrl = String(value.url || value.endpointUrl || '').replace(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/, '$1');
    try {
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      if (url.search) { url.search = ''; reasons.push('服务地址含参数，需要重新配置'); }
      server.endpointUrl = url.href.replace(/\/$/, '');
      if (/auth-proxy\.local|\.it\.woa\.com|\.oa\.com/.test(url.hostname)) reasons.push('源平台内网或专属代理地址，需要替换为可访问服务');
    } catch { reasons.push('缺少可直接访问的 MCP 地址'); }
    server.headers = {};
    for (const [name, input] of Object.entries({ ...value.staticHeaders, ...value.headers })) {
      if (!/\$\{/.test(String(input)) && /^(?:x-request-source|x-skill-version|x-.*-client|x-.*-surface|accept)$/i.test(name)) server.headers[name] = String(input);
      else credential(name, input);
    }
  }
  const extension = value['x-workbuddy'] || {}, authType = extension.auth?.type || (requiredCredentials.length ? 'token' : 'unspecified');
  return { key, name: extension.displayName?.zh || extension.displayName?.en || key, description: extension.description?.zh || extension.description?.en || value.description || '',
    server, requiredCredentials, authType, setupReasons: reasons,
    autoInstall: false, ...(authType === 'oauth' ? { authorizationRequired: true } : {}) };
}
async function packageRoots(input, connectorDirectory) {
  const roots = [];
  for (const item of await readdir(join(input, 'packages'), { withFileTypes: true })) if (item.isDirectory()) roots.push(join(input, 'packages', item.name));
  for (const market of await readdir(join(input, 'skill-marketplaces'), { withFileTypes: true })) {
    if (!market.isDirectory()) continue;
    const plugins = join(input, 'skill-marketplaces', market.name, 'plugins');
    for (const item of await readdir(plugins, { withFileTypes: true }).catch(() => [])) if (item.isDirectory()) roots.push(join(plugins, item.name));
    try { await access(join(input, 'skill-marketplaces', market.name, 'SKILL.md')); roots.push(join(input, 'skill-marketplaces', market.name)); } catch {}
  }
  for (const item of await readdir(connectorDirectory, { withFileTypes: true }).catch(() => [])) if (item.isDirectory()) roots.push(join(connectorDirectory, item.name));
  return roots;
}
export async function completeResources({ input, directory, connectorDirectory }) {
  const source = await json(join(directory, 'catalog.json')), resources = [], bundles = {}, skills = new Map(), mcp = new Map(), skipped = [];
  const sourceLabel = root => root.startsWith(`${input}/`) ? relative(input, root) : `connector-presets/${basename(root)}`;
  const addMcp = (key, config) => { const preset = mcpPreset(key, config), id = `catalog-mcp-${hash(JSON.stringify(preset)).slice(0, 24)}`;
    if (!resources.some(row => row.id === id)) resources.push({ id, kind: 'mcp', name: preset.name, description: preset.description || `连接 ${key} MCP 服务`, version: '1.0.0', preset });
    if (!mcp.has(key.toLowerCase())) mcp.set(key.toLowerCase(), preset);
  };
  for (const root of await packageRoots(input, connectorDirectory)) {
    let files; try { files = await inventory(root); } catch (error) { skipped.push({ source: sourceLabel(root), reason: error.message }); continue; }
    const manifests = files.filter(file => /(?:^|\/)SKILL\.md$/.test(file.path));
    const manifest = await optionalJson(join(root, '.codebuddy-plugin/plugin.json'));
    const configs = typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers) ? manifest.mcpServers : manifest.dependencies?.mcpServers || {};
    if (configs && typeof configs === 'object') for (const [key, config] of Object.entries(configs)) addMcp(key, config);
    for (const file of files.filter(file => /(?:^|\/)\.?mcp\.json$/.test(file.path))) {
      const value = await optionalJson(join(root, file.path)); for (const [key, config] of Object.entries(value.mcpServers || {})) addMcp(key, config);
    }
    if (!manifests.length) continue;
    const digest = hash(JSON.stringify(files)), bundle = { path: `packages/${digest}`, digest, files };
    bundles[digest] = bundle;
    const destination = join(directory, bundle.path);
    try { await access(destination); } catch { await cp(root, destination, { recursive: true, mode: constants.COPYFILE_FICLONE }); }
    for (const file of manifests) {
      const text = await readFile(join(root, file.path), 'utf8'), parsed = markdownDefinition(text), path = dirname(file.path), name = String(parsed.metadata.name || (path === '.' ? basename(root) : path.split('/').pop()));
      const matching = path === '.' ? files : files.filter(row => row.path.startsWith(`${path}/`)), skill = { path, name, runtimeName: runtimeName(name), description: String(parsed.metadata.description || ''), version: String(parsed.metadata.version || '1.0.0'), digest: hash(JSON.stringify(matching)), fileCount: matching.length };
      const id = `catalog-skill-${hash(`${digest}:${path}`).slice(0, 24)}`, row = { id, kind: 'skill', name, description: skill.description, version: skill.version, fileCount: skill.fileCount,
        dependencies: { package: { path: bundle.path, digest }, skills: [skill], mcp: [] }, sourcePackage: sourceLabel(root) };
      if (!resources.some(existing => existing.id === id)) resources.push(row);
      for (const alias of [name.toLowerCase(), skill.runtimeName, path.split('/').pop().toLowerCase()]) if (!skills.has(alias)) skills.set(alias, { skill, bundle });
    }
  }
  for (const entry of await readdir(connectorDirectory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const value = await optionalJson(join(connectorDirectory, entry.name, 'mcp.json'));
    for (const [key, config] of Object.entries(value.mcpServers || {})) addMcp(key, config);
    const cli = await optionalJson(join(connectorDirectory, entry.name, 'cli.json'));
    if (!Object.keys(value.mcpServers || {}).length && Object.keys(cli).length) resources.push({ id: `catalog-mcp-${hash(`cli:${entry.name}`).slice(0, 24)}`, kind: 'mcp', name: entry.name, description: '此连接器由源平台 CLI / Skill 提供，需要适配其运行环境。', version: '1.0.0', preset: { key: entry.name, setupReasons: ['源平台 CLI 连接器，不能当作 HTTP MCP 直接连接'], server: {}, requiredCredentials: [] } });
  }
  // Ardot documents its local endpoint in README; its core Skill lives in another downloaded package.
  addMcp('ardot', { url: 'http://127.0.0.1:50501/api/v1/mcp', description: '需要本地 Ardot 客户端启动并监听 50501；不迁移源应用账号。' });
  for (const item of source.items) {
    const missing = [], text = item.spec.instructions.system.split('## Studio 运行适配')[0], originalSkills = item.dependencies?.skills || [], names = implicitSkillNames(text, new Set(skills.keys()));
    const additional = new Map();
    for (const name of names) {
      if (originalSkills.some(skill => [skill.name.toLowerCase(), skill.path.split('/').pop().toLowerCase(), skill.runtimeName].includes(name))) continue;
      const found = skills.get(name);
      if (!found) { missing.push(`未找到提示词要求的 Skill：${name}`); continue; }
      if (!additional.has(found.bundle.digest)) additional.set(found.bundle.digest, { package: { path: found.bundle.path, digest: found.bundle.digest }, skills: [] });
      if (!additional.get(found.bundle.digest).skills.some(skill => skill.path === found.skill.path)) additional.get(found.bundle.digest).skills.push(found.skill);
    }
    if (item.id === 'imported-adort-design-expert') {
      const found = skills.get('ardot-design-assistant');
      if (found) {
        const group = resources.filter(row => row.kind === 'skill' && row.dependencies?.package.digest === found.bundle.digest).map(row => row.dependencies.skills[0]);
        additional.set(found.bundle.digest, { package: { path: found.bundle.path, digest: found.bundle.digest }, skills: group });
        item.dependencies.mcp = [mcp.get('ardot')];
      } else missing.push('缺少 Ardot 配套 Skill 包');
    }
    const mcpNames = [...new Set([...text.matchAll(/mcp__([a-z0-9_-]+)__/gi)].map(match => match[1].toLowerCase()))];
    for (const [key, preset] of mcp) {
      if (key.length < 3) continue;
      const aliases = [key, preset.name].filter(Boolean).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (text.split('\n').some(line => /MCP|连接器/i.test(line) && new RegExp(`(?:${aliases.join('|')})`, 'i').test(line))) mcpNames.push(key);
    }
    for (const name of mcpNames) if (!item.dependencies.mcp.some(row => row.key === name)) {
      if (mcp.has(name)) item.dependencies.mcp.push(mcp.get(name)); else missing.push(`未找到提示词要求的 MCP：${name}`);
    }
    // Explicit external-MCP instructions without any declared or resolvable connection are not ready experts.
    if (!item.dependencies.mcp.length && /(?:via|through|使用|通过|调用)[^\n。]{0,45}(?:MCP (?:server|service)|MCP服务|MCP 工具)|MCP (?:server|service)[^\n。]{0,30}(?:required|must|必须)/i.test(text)) missing.push('提示词要求外部 MCP，但源包未提供可核对的连接声明');
    item.dependencies.additional = [...additional.values()];
    const count = originalSkills.length + [...additional.values()].reduce((sum, group) => sum + group.skills.length, 0);
    item.requirements = item.requirements.filter(row => !['skill', 'mcp'].includes(row.kind));
    if (count) item.requirements.push({ kind: 'skill', required: true, count, label: `${count} 项配套技能（完整文件）` });
    if (item.dependencies.mcp.length) item.requirements.push({ kind: 'mcp', required: true, count: item.dependencies.mcp.length, label: '连接并探测配套 MCP' });
    item.availability = { state: missing.length ? 'blocked' : item.dependencies.mcp.some(row => !row.autoInstall) ? 'needs-setup' : 'compatible', reasons: missing };
    if (item.categoryId === 'community-13-tencentzone') item.categoryId = 'community-02-engineering';
  }
  source.categories = source.categories.filter(row => row.id !== 'community-13-tencentzone');
  const resourceKeys = new Set();
  source.packages = bundles; source.resources = resources.filter(row => {
    const key = row.kind === 'skill' ? `skill:${row.name}:${row.dependencies.skills[0].digest}` : row.id;
    if (resourceKeys.has(key)) return false; resourceKeys.add(key); return true;
  }); source.revision = 'community-local-2026-10-15.2';
  const temporary = join(directory, 'catalog.next.json'); await writeFile(temporary, JSON.stringify(source), { mode: 0o600 }); await rename(temporary, join(directory, 'catalog.json'));
  const report = { experts: source.items.length, blocked: source.items.filter(row => row.availability.state === 'blocked').map(row => ({ id: row.id, name: row.name, reasons: row.availability.reasons })), skills: source.resources.filter(row => row.kind === 'skill').length, mcp: source.resources.filter(row => row.kind === 'mcp').length, skipped };
  await writeFile(join(directory, 'dependency-audit.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  return { experts: report.experts, blocked: report.blocked.length, skills: report.skills, mcp: report.mcp };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  if (!['--input', '--catalog', '--connectors'].every(flag => args.includes(flag))) throw new Error('Usage: complete-resources.mjs --input downloaded-directory --catalog personal-release-directory --connectors public-connector-directory');
  console.log(JSON.stringify(await completeResources({ input: resolve(value('--input')), directory: resolve(value('--catalog')), connectorDirectory: resolve(value('--connectors')) })));
}
