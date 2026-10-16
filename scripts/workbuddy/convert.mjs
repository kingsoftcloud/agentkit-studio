/** Offline importer. Outputs existing Studio Agent specs and a separate review report. */
import { readFile, writeFile, readdir, lstat, realpath, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { validateCatalog } from '../../packages/expert-catalog/src/catalog.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const localized = value => typeof value === 'string' ? value : value?.zh || value?.en || '';
const localizedList = value => {
  const list = Array.isArray(value) ? value : value?.zh || value?.en || [];
  return (Array.isArray(list) ? list : [list]).map(localized).filter(Boolean);
};
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function containedPath(root, path) {
  if (typeof path !== 'string' || path.includes('\\') || isAbsolute(path)) throw new Error('Package path must be relative');
  const base = await realpath(root), target = await realpath(resolve(base, path)), rel = relative(base, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Package path escapes its root');
  return target;
}
export function markdownDefinition(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  let metadata = {}, parseWarning;
  if (match) {
    try { metadata = parseYaml(match[1], { maxAliasCount: 0 }); }
    catch {
      // Some upstream packages contain unquoted colons or mixed JSON/YAML. Preserve the
      // body verbatim and retain the header in the review report instead of dropping the Agent.
      parseWarning = 'invalid-frontmatter-preserved';
      metadata = { name: match[1].match(/^name:\s*([^\n]+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '').trim(), raw: match[1] };
    }
  }
  if (metadata && (typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error('Invalid Agent frontmatter');
  return { metadata: metadata || {}, parseWarning, system: (match ? match[2] : text).trim() };
}
async function files(root, prefix = '') {
  const result = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Package links are not supported');
    const path = join(prefix, item.name);
    if (item.isDirectory()) result.push(...await files(root, path));
    else if (item.isFile()) result.push(path);
    if (result.length > 12000) throw new Error('Package file limit exceeded');
  }
  return result;
}
const emptySpec = system => ({ runtime: { type: 'dsh-native' }, instructions: { system, task: '' },
  bindings: { tools: [], mcpServers: [], skills: [], plugins: [], policyTemplate: 'strict' },
  memory: { enabled: false, recall: { enabled: false }, write: { mode: 'explicit_only' } } });

export async function convertExpert(root, entry, receipt) {
  root = await realpath(root);
  const manifest = await json(await containedPath(root, '.codebuddy-plugin/plugin.json'));
  const allFiles = await files(root), agents = [], warnings = [], skills = [];
  const declaredAgents = Array.isArray(manifest.agents) ? manifest.agents : manifest.agents ? [manifest.agents] : [];
  const paths = new Set();
  for (const path of declaredAgents) {
    const actual = await containedPath(root, path);
    if ((await lstat(actual)).isDirectory()) {
      for (const file of allFiles.filter(file => file.startsWith(relative(root, actual) + '/') && file.endsWith('.md'))) paths.add(file);
    } else paths.add(relative(root, actual));
  }
  if (!paths.size) {
    for (const file of allFiles.filter(file => file.startsWith('agents/') && file.endsWith('.md'))) paths.add(file);
  }
  if (!paths.size) warnings.push('missing-agent-definition');
  for (const path of paths) {
    const text = await readFile(await containedPath(root, path), 'utf8'), definition = markdownDefinition(text);
    if (definition.parseWarning) warnings.push(definition.parseWarning);
    agents.push({ name: definition.metadata.name || path.split('/').pop().replace(/\.md$/, ''), path,
      sourceSha256: hash(text), sourceFrontmatter: definition.metadata, spec: emptySpec(definition.system) });
    if (definition.metadata.maxTurns != null) warnings.push('max-turns-requires-runtime-mapping');
  }
  for (const path of allFiles.filter(path => /(^|\/)SKILL\.md$/.test(path))) {
    const text = await readFile(join(root, path), 'utf8');
    skills.push({ path, sha256: hash(text), files: allFiles.filter(file => file.startsWith(path.slice(0, -8))), installed: false });
  }
  const dependencies = { skills: manifest.skills || [], connectors: manifest.dependencies?.connectors || [],
    mcpServers: manifest.dependencies?.mcpServers || manifest.mcpServers || [], mcpFiles: allFiles.filter(path => /(^|\/)\.?mcp\.json$/.test(path)) };
  if (skills.length || dependencies.skills.length) warnings.push('skills-require-import-and-binding');
  if (dependencies.connectors.length || Object.keys(dependencies.mcpServers).length || dependencies.mcpFiles.length) warnings.push('connectors-require-mapping-and-authorization');
  // Heuristic only; the report always requires semantic review, including unsupported tool names.
  const platformReferences = [];
  for (const path of allFiles.filter(path => /\.(md|json|ya?ml)$/.test(path))) {
    const text = await readFile(join(root, path), 'utf8');
    const matches = [...new Set(text.match(/\b(?:WorkBuddy|CodeBuddy|mcp__\w+|run_in_subagent|spawn_agent|create_agent|browser_use|execute_command)\b/gi) || [])];
    if (matches.length) platformReferences.push({ path, references: matches });
  }
  if (platformReferences.length) warnings.push('platform-instructions-require-review');
  const licenses = allFiles.filter(path => /(^|\/)(LICENSE|COPYING|NOTICE)(\.[^/]*)?$/i.test(path));
  // A manifest-level MIT label is not treated as a license for every bundled skill or image.
  const rootLicense = licenses.find(path => !path.includes('/'));
  if (!rootLicense) warnings.push('package-license-unconfirmed');
  const requirements = [];
  if (skills.length) requirements.push({ kind: 'skill', required: true, count: skills.length, label: '导入并绑定配套技能', purpose: '保持配套文件及依赖；需逐项核对资源映射。' });
  if (dependencies.connectors.length || Object.keys(dependencies.mcpServers).length || dependencies.mcpFiles.length) requirements.push({ kind: 'mcp', required: true, label: '配置专家所需连接器', purpose: '按转换报告重新配置 MCP 与授权。' });
  const lead = agents.find(agent => agent.name === (manifest.agentName || manifest.teamInfo?.leadAgent)) || agents[0];
  const prompts = manifest.quickPrompts || entry.quickPrompts || [];
  const examples = [...new Set(localizedList(prompts))];
  const initial = localized(manifest.defaultInitPrompt || entry.defaultInitPrompt);
  if (initial && !examples.includes(initial)) examples.push(initial);
  if (examples.length < 2) warnings.push('insufficient-task-examples');
  const kind = manifest.expertType || entry.expertType || 'agent';
  const candidate = lead && kind === 'agent' ? {
    id: `imported-${receipt.plugin}`, version: /^\d+\.\d+\.\d+$/.test(manifest.version) ? manifest.version : '0.0.0', kind: 'agent',
    name: localized(manifest.profession || entry.profession) || localized(manifest.displayName) || manifest.name,
    description: localized(manifest.displayDescription || entry.description) || manifest.description || '',
    categoryId: manifest.categoryId || entry.categoryId, tags: localizedList(manifest.tags || entry.tags || []),
    examples, deliverable: '按角色指令和用户确认的任务交付；导入后需完成能力验证。',
    author: localized(manifest.author?.name || manifest.author) || '上游作者（待核对）',
    origin: { type: 'imported', source: receipt.url, sourceId: entry.id, sourceSha256: receipt.sha256,
      license: manifest.license || (rootLicense ? 'see-source-license' : 'unconfirmed') },
    runtimes: ['dsh-native', 'harness', 'codex'], validation: { state: 'conversion-draft', verifiedRuntimes: [] },
    requirements, spec: lead.spec,
  } : null;
  if (kind === 'team') warnings.push('agent-teams-adapter-required');
  if (kind !== 'team' && kind !== 'agent') warnings.push('unsupported-expert-type');
  return { id: entry.id, plugin: receipt.plugin, version: manifest.version, kind, candidate, agents, skills, dependencies,
    team: kind === 'team' ? { ...manifest.teamInfo, members: manifest.members || entry.members || [] } : null,
    licenses, platformReferences, warnings: [...new Set(warnings)], status: 'review-required',
    checks: { definitionConverted: Boolean(lead?.spec.instructions.system), runtimeVerified: false, publicationApproved: false } };
}

export function connectorDraft(source) {
  const requiredConfiguration = new Set();
  const variable = key => `\u0024{${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}}`;
  const placeholder = value => typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
  const config = { mcpServers: {} };
  for (const [name, server] of Object.entries(source.mcpServers || {})) {
    const result = { disabled: true };
    for (const key of ['command', 'type', 'transport', 'timeout']) if (server[key] != null) result[key] = server[key];
    if (server.url) {
      let url;
      try { url = new URL(server.url); } catch {
        requiredConfiguration.add(`${name}.url`);
        url = null; result.url = '${MCP_URL}';
      }
      if (url) {
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported MCP URL scheme');
      url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) { requiredConfiguration.add(`${name}.url.${key}`); url.searchParams.set(key, variable(key)); }
      result.url = url.toString();
      }
    }
    for (const field of ['headers', 'staticHeaders', 'env']) {
      if (!server[field]) continue;
      const dest = field === 'staticHeaders' ? 'headers' : field;
      result[dest] ||= {};
      for (const [key, value] of Object.entries(server[field])) {
        // Keep placeholders, not any user's or vendor-supplied static secret values.
        result[dest][key] = placeholder(value) ? value : variable(key);
        requiredConfiguration.add(`${name}.${dest}.${key}`);
      }
    }
    if (server.args?.length) {
      // Command lines can hide credentials anywhere. Preserve them only in the source, never the draft.
      result.args = ['${MCP_ARGS}']; requiredConfiguration.add(`${name}.args`);
    }
    config.mcpServers[name] = result;
  }
  return { config, requiredConfiguration: [...requiredConfiguration], status: 'review-required', authorized: false };
}

export async function convertSnapshot(input, connectors) {
  const output = join(input, 'converted'); await mkdir(output, { recursive: true });
  const source = await json(join(input, 'manifest.json')), downloads = await json(join(input, 'downloads.json'));
  const entries = new Map(source.experts.map(entry => [entry.plugin, entry])), rows = [], candidates = [];
  for (const receipt of downloads.bundles.filter(row => row.status === 'downloaded')) {
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(receipt.plugin)) throw new Error('Invalid bundle identity');
      const result = await convertExpert(join(input, 'packages', receipt.plugin), entries.get(receipt.plugin), receipt);
      await writeFile(join(output, `${receipt.plugin}.json`), JSON.stringify(result, null, 2));
      if (result.candidate) candidates.push(result.candidate);
      rows.push({ plugin: receipt.plugin, kind: result.kind, agents: result.agents.length, skills: result.skills.length,
        warnings: result.warnings, converted: result.checks.definitionConverted });
    } catch (error) { rows.push({ plugin: receipt.plugin, converted: false, error: error.message }); }
  }
  const categories = source.categories.map(category => ({ id: category.id, name: localized(category.name), description: localized(category.description), color: '#e9edf3', ink: '#4c5a73', icon: 'research', featured: [] }));
  const catalog = { schemaVersion: 1, revision: `workbuddy-${downloads.manifestSha256.slice(0, 12)}`, categories, items: candidates };
  const validationFailures = [];
  for (const item of candidates) {
    try { validateCatalog({ ...catalog, items: [item] }); }
    catch (error) { validationFailures.push({ id: item.id, reason: error.message }); }
  }
  await writeFile(join(output, 'catalog.draft.json'), JSON.stringify(catalog, null, 2));
  let connectorCount = 0, skillOnlyConnectors = 0;
  if (connectors) {
    const destination = join(output, 'connectors'); await mkdir(destination, { recursive: true });
    for (const entry of await readdir(connectors, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const directory = await containedPath(connectors, entry.name);
        const content = await files(directory);
        if (!content.includes('mcp.json')) {
          const skills = content.filter(file => /(^|\/)SKILL\.md$/.test(file));
          await writeFile(join(destination, `${entry.name}.json`), JSON.stringify({ status: 'review-required', kind: 'skill-only', skills, files: content, authorized: false }, null, 2));
          skillOnlyConnectors++; continue;
        }
        const path = await containedPath(connectors, `${entry.name}/mcp.json`);
        const draft = connectorDraft(await json(path));
        await writeFile(join(destination, `${entry.name}.json`), JSON.stringify(draft, null, 2)); connectorCount++;
      } catch (error) { rows.push({ connector: entry.name, converted: false, error: error.message }); }
    }
  }
  const summary = { catalogEntries: source.experts.length, downloadedBundles: downloads.bundles.filter(row => row.status === 'downloaded').length,
    convertedExperts: candidates.length, convertedTeams: rows.filter(row => row.kind === 'team' && row.converted).length,
    agentDefinitions: rows.reduce((n, row) => n + (row.agents || 0), 0), bundledSkills: rows.reduce((n, row) => n + (row.skills || 0), 0),
    connectorDrafts: connectorCount, skillOnlyConnectors, schemaFailures: validationFailures.length, published: 0, runtimeVerified: 0 };
  await writeFile(join(input, 'conversion-report.json'), JSON.stringify({ summary, validationFailures, rows }, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  if (!args.includes('--input')) throw new Error('Usage: node scripts/workbuddy/convert.mjs --input snapshot-directory [--connectors directory]');
  console.log(JSON.stringify(await convertSnapshot(resolve(value('--input')), args.includes('--connectors') ? resolve(value('--connectors')) : undefined), null, 2));
}
