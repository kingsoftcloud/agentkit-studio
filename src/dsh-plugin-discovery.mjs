/** Discovery catalog for the Studio DSH plugin market.
 *
 * The official DSH plugin page lists what is installed. A market needs the
 * opposite first: what exists in the ecosystem and is worth installing. This
 * module aggregates public, read-only metadata from the npm registry (keyword
 * `dsh-plugin`) and GitHub (`topic:dsh-plugin`, used for stars), on top of a
 * small hand-curated seed list that keeps the shelf useful offline.
 *
 * Metadata only: installation, profile writes, compatibility checks and
 * runtime loading stay owned by the official DSH plugin manager. A discovery
 * document cannot declare host verification probes, and every URL is reduced
 * to https.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hostFetch } from './http-fetch.mjs';

export const DSH_PLUGIN_DISCOVERY_SCHEMA_VERSION = 1;
export const DSH_PLUGIN_DISCOVERY_ENV = 'AGENTKIT_STUDIO_DISCOVERY_CACHE';

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const NPM_PACKAGE_URL = 'https://registry.npmjs.org/';
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ITEMS = 240;
const MAX_NPM_ITEMS = 200;
const MAX_GITHUB_ONLY = 40;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Ordered category rules: first match wins, checked against name + keywords + description. */
const CATEGORY_RULES = [
  ['视觉外观', /\b(theme|wallpaper|appearance|color|icon|font|pet|widget|mascot|skin)\b|壁纸|外观|主题|配色|挂件|宠物|图标|字体/u],
  ['界面增强', /\b(sidebar|tui|ui|panel|statusbar|status-bar|toolbar|tab|menu|layout|layout|terminal)\b|侧栏|侧边|界面|状态栏|工具栏|终端|面板|布局/u],
  ['记忆与上下文', /\b(memory|context|mnemon|knowledge|rag|recall|compress)\b|记忆|上下文|知识库|压缩/u],
  ['搜索与联网', /\b(search|browse|browser|fetch|scrape|crawl|web|internet|rss|news)\b|搜索|联网|浏览器|抓取|网页/u],
  ['图像与媒体', /\b(image|vision|video|audio|voice|media|imagegen|tts|asr|ocr|photo)\b|图像|图片|视觉|视频|音频|语音|媒体/u],
  ['文档与办公', /\b(office|docx|xlsx|pptx|pdf|word|excel|slide|document|markdown|univer)\b|文档|表格|幻灯片|办公/u],
  ['成本与用量', /\b(cost|usage|price|pricing|meter|balance|billing|stats|dashboard)\b|费用|用量|成本|计费|余额|统计/u],
  ['模型与路由', /\b(model|provider|proxy|router|routing|llm|gateway|api-key|token|openai|anthropic|qwen|moonshot|zhipu)\b|模型|路由|网关|接入|密钥/u],
  ['效率与通知', /\b(notify|notification|reminder|shortcut|productivity|timer|pomodoro|schedule|todo)\b|通知|提醒|快捷|效率|定时|待办/u],
  ['协作与工作流', /\b(agent.?team|multi.?agent|workflow|orchestrat|collaborat|pipeline|subagent)\b|协作|团队|工作流|编排|多智能体/u],
  ['输入与编辑', /\b(input|editor|vscode|completion|autocomplete|at-file|genui|clipboard|paste|prompt)\b|输入|编辑|补全|文件引用|剪贴板/u],
  ['助理', /\bassistant\b|助理|云电脑/u],
  ['安全与质量', /\b(security|guard|permission|permissions|sanitize|audit|scan|review|safety)\b|安全|权限|审查|审计|风控/u]
];

/** Hand-curated shelf: quality over quantity, kept even when the network is down. */
export const DSH_CURATED_DISCOVERY = Object.freeze([
  { name: 'dsh-whale-widget', category: '视觉外观', tags: ['余额', '挂件'] },
  { name: 'dsh-pet', category: '视觉外观', tags: ['桌宠', '互动'] },
  { name: 'dsh-plugin-wallpaper-engine', category: '视觉外观', tags: ['壁纸', '动态背景'] },
  { name: '@liustack/modlens', category: '图像与媒体', tags: ['视觉', '图片理解'] },
  { name: '@anionex/dsh-vision-toolkit', category: '图像与媒体', tags: ['视觉工具'] },
  { name: 'dsh-better-sidebar', category: '界面增强', tags: ['侧栏', '界面'] },
  { name: '@deepseek-harness-tui/dsh-tui', category: '界面增强', tags: ['终端', 'TUI'] },
  { name: '@deepseek-ai/dsh-client-ui-aqua', category: '界面增强', tags: ['主题', '外观'] },
  { name: 'dsh-reasoning-effort', category: '界面增强', tags: ['推理强度', '设置'] },
  { name: 'dsh-mnemon', category: '记忆与上下文', tags: ['记忆', '视图上下文'] },
  { name: 'dsh-context', category: '记忆与上下文', tags: ['上下文', '压缩'] },
  { name: '@furongjun1999/dsh-memory', category: '记忆与上下文', tags: ['长期记忆'] },
  { name: 'dsh-at-file', category: '输入与编辑', tags: ['文件引用', '输入'] },
  { name: 'dsh-open-in-vscode', category: '输入与编辑', tags: ['VSCode', '编辑器'] },
  { name: '@omdsh-dev/dsh-genui', category: '输入与编辑', tags: ['生成界面'] },
  { name: 'dsh-free-search', category: '搜索与联网', tags: ['联网搜索', '免费'] },
  { name: '@liustack/modsearch', category: '搜索与联网', tags: ['联网搜索'] },
  { name: 'dsh-builtin-browser', category: '搜索与联网', tags: ['浏览器'] },
  { name: 'dsh-cost-meter', category: '成本与用量', tags: ['费用', 'Token 统计'] },
  { name: '@dfy-plugins/dsh-image-generation', category: '图像与媒体', tags: ['图像生成'] },
  { name: 'dsh-univer-office', category: '文档与办公', tags: ['表格', '文档'] },
  { name: 'dsh-plugin-model-proxy', category: '模型与路由', tags: ['模型代理', '路由'] },
  { name: 'dsh-connect-workbuddy', category: '模型与路由', tags: ['模型接入'] },
  { name: 'dsh-fireworks', category: '模型与路由', tags: ['模型接入'] },
  { name: '@nanmicoder/dsh-agent-teams', category: '协作与工作流', tags: ['多智能体', '团队'] },
  { name: 'dsh-notification', category: '效率与通知', tags: ['通知'] },
  { name: 'dsh-skill-viewer', category: '效率与通知', tags: ['技能', '浏览'] },
  { name: '@kingsoftcloud/agentkit-personal-assistant', category: '助理', tags: ['个人助理', '云电脑', '多助理'] },
  { name: 'dshmarket', category: '其他', tags: ['插件市场'] },
  { name: 'dsh-web-plugin-manager', category: '其他', tags: ['插件管理'] }
]);

function text(value, max) {
  return (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
    .replace(/\s+/gu, ' ').trim().slice(0, max);
}

function httpsUrl(value) {
  const candidate = text(value, 400);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return null;
  }
}

/** A repository URL from npm metadata, reduced to `owner/repo` when it is GitHub. */
export function githubRepoOf(value) {
  const candidate = text(value, 400)
    .replace(/^git\+/u, '')
    .replace(/^git:\/\//u, 'https://')
    .replace(/\.git$/u, '');
  if (!candidate) return '';
  let url;
  try { url = new URL(candidate); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (!/(^|\.)github\.com$/iu.test(url.hostname)) return '';
  const parts = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  if (parts.length < 2) return '';
  const repo = `${parts[0]}/${parts[1]}`;
  return GITHUB_REPO.test(repo) ? repo : '';
}

/** Choose the shelf category from name, keywords and description; first rule wins. */
export function discoveryCategory(value) {
  const haystack = [
    value.name, value.packageName, value.description, Array.isArray(value.keywords) ? value.keywords.join(' ') : ''
  ].filter(Boolean).join(' ').toLowerCase();
  for (const [category, pattern] of CATEGORY_RULES) if (pattern.test(haystack)) return category;
  return '其他';
}

function sanitizeTags(values, fallback = []) {
  const list = Array.isArray(values) ? values : [];
  const tags = [...new Set([...list, ...fallback].map(value => text(value, 24)).filter(Boolean))];
  return tags.slice(0, 8);
}

/** A curated shelf entry as a card when the registry cannot be reached. */
export function curatedFallback(seed) {
  return {
    id: seed.name.toLowerCase(),
    packageName: seed.name,
    repo: '',
    displayName: seed.name,
    description: '',
    version: '',
    installSpec: seed.name,
    source: 'npm',
    category: seed.category,
    tags: sanitizeTags([], seed.tags),
    featured: true,
    curated: true,
    homepage: '',
    repository: '',
    npmUrl: `https://www.npmjs.com/package/${seed.name}`,
    author: '',
    stats: {}
  };
}

/** One npm search object or registry manifest into a market card. */
export function normalizeNpmDiscovery(input, { curated, github } = {}) {
  const pkg = input?.package || input || {};
  const name = text(pkg.name, 214);
  if (!name || !PACKAGE_NAME.test(name)) return null;
  const repo = githubRepoOf(pkg.links?.repository || pkg.repository?.url || pkg.repository);
  const downloads = input?.downloads && typeof input.downloads === 'object' ? input.downloads : {};
  const monthly = Number(downloads.monthly);
  const weekly = Number(downloads.weekly);
  const stars = github && repo && github.get(repo.toLowerCase())?.stars;
  const updatedAt = text(pkg.date || input?.updated || input?.time?.modified, 40);
  const version = text(pkg.version, 40);
  const item = {
    id: name,
    packageName: name,
    repo: repo || '',
    displayName: text(pkg.displayName, 80) || name,
    description: text(pkg.description, 400),
    version,
    installSpec: name,
    source: 'npm',
    category: curated?.category || discoveryCategory({ packageName: name, description: pkg.description, keywords: pkg.keywords }),
    tags: sanitizeTags(pkg.keywords, curated?.tags),
    featured: Boolean(curated),
    curated: Boolean(curated),
    homepage: httpsUrl(pkg.links?.homepage || pkg.homepage) || '',
    repository: repo ? `https://github.com/${repo}` : (httpsUrl(pkg.links?.repository) || ''),
    npmUrl: `https://www.npmjs.com/package/${name}`,
    author: text(pkg.publisher?.username || pkg.author?.name || pkg.author, 60),
    stats: {
      ...(Number.isFinite(monthly) && monthly > 0 ? { monthlyDownloads: monthly } : {}),
      ...(Number.isFinite(weekly) && weekly > 0 ? { weeklyDownloads: weekly } : {}),
      ...(typeof stars === 'number' ? { stars } : {}),
      ...(updatedAt ? { updatedAt } : {})
    }
  };
  return item;
}

/** One GitHub search repository into a market card; only repos that name DSH-family terms qualify. */
export function normalizeGithubDiscovery(repo) {
  const fullName = text(repo?.full_name, 140);
  if (!fullName || !GITHUB_REPO.test(fullName)) return null;
  const haystack = [fullName, repo.description, ...(Array.isArray(repo.topics) ? repo.topics : [])].join(' ').toLowerCase();
  if (!/(dsh|deepseek|harness)/u.test(haystack)) return null;
  const stars = Number(repo.stargazers_count);
  return {
    id: `github:${fullName.toLowerCase()}`,
    packageName: '',
    repo: fullName,
    displayName: fullName,
    description: text(repo.description, 400),
    version: '',
    installSpec: `github:${fullName}`,
    source: 'github',
    category: discoveryCategory({ name: fullName, description: repo.description }),
    tags: sanitizeTags(repo.topics),
    featured: false,
    curated: false,
    homepage: httpsUrl(repo.homepage) || '',
    repository: text(repo.html_url, 300),
    npmUrl: '',
    author: text(repo.owner?.login, 60),
    stats: {
      ...(Number.isFinite(stars) && stars > 0 ? { stars } : {}),
      ...(text(repo.pushed_at, 40) ? { updatedAt: text(repo.pushed_at, 40) } : {})
    }
  };
}

/** Merge curated first, then npm cards by downloads, then GitHub-only cards by stars. */
export function mergeDiscovery({ curated = [], npm = [], githubOnly = [] } = {}) {
  const byId = new Map();
  for (const item of curated) byId.set(item.id, item);
  for (const item of npm) {
    const existing = byId.get(item.id);
    if (existing === undefined) byId.set(item.id, item);
    else byId.set(item.id, { ...existing, ...item, featured: existing.featured, curated: existing.curated, category: existing.curated ? existing.category : item.category, tags: sanitizeTags(item.tags, existing.tags) });
  }
  for (const item of githubOnly) {
    const known = [...byId.values()].some(known => known.repo && known.repo.toLowerCase() === item.repo.toLowerCase());
    if (!known) byId.set(item.id, item);
  }
  const items = [...byId.values()];
  items.sort((left, right) => (right.featured === true) - (left.featured === true)
    || (right.stats?.monthlyDownloads || 0) - (left.stats?.monthlyDownloads || 0)
    || (right.stats?.stars || 0) - (left.stats?.stars || 0)
    || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN'));
  return items.slice(0, MAX_ITEMS);
}

function discoveryFailure(error) {
  if (error?.name === 'AbortError') return { code: 'DISCOVERY_TIMEOUT', message: '插件目录请求超时' };
  return { code: 'DISCOVERY_UNAVAILABLE', message: String(error?.message || '插件目录暂不可用').slice(0, 300) };
}

/** Create the cached discovery aggregator used by the Studio plugin host service. */
export function createDshPluginDiscovery({
  fetchImpl = hostFetch,
  env = process.env,
  now = () => Date.now(),
  cacheFile,
  cacheTtlMs = DEFAULT_TTL_MS,
  timeoutMs = 8000
} = {}) {
  const file = cacheFile ?? (env[DSH_PLUGIN_DISCOVERY_ENV]?.trim()
    || join(homedir(), '.cache', 'agentkit-studio', 'dsh-plugin-discovery.json'));
  const githubToken = (env.AGENTKIT_STUDIO_GITHUB_TOKEN || env.GITHUB_TOKEN || '').trim();
  let memory = null;
  let inflight = null;

  async function request(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'agentkit-studio-plugin-market', ...headers }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchNpm() {
    const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent('keywords:dsh-plugin')}&size=250`;
    const document = await request(url);
    const objects = Array.isArray(document?.objects) ? document.objects : [];
    return { total: Number(document?.total) || objects.length, objects };
  }

  async function fetchRegistry(name) {
    const document = await request(NPM_PACKAGE_URL + encodeURIComponent(name));
    const latest = document?.['dist-tags']?.latest || document?.version;
    const manifest = latest && document?.versions?.[latest] ? document.versions[latest] : {};
    return {
      package: {
        name: document?.name || name,
        description: document?.description || manifest.description,
        version: latest || manifest.version,
        keywords: document?.keywords || manifest.keywords,
        homepage: document?.homepage || manifest.homepage,
        repository: document?.repository || manifest.repository,
        author: document?.author || manifest.author,
        date: document?.time?.modified || document?.time?.[latest]
      }
    };
  }

  async function fetchGithub() {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'agentkit-studio-plugin-market' };
    if (githubToken) headers.authorization = `Bearer ${githubToken}`;
    const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent('topic:dsh-plugin')}&sort=stars&order=desc&per_page=100`;
    const document = await request(url, headers);
    const entries = Array.isArray(document?.items) ? document.items : [];
    const stars = new Map();
    for (const entry of entries) {
      const fullName = text(entry?.full_name, 140);
      if (!fullName || !GITHUB_REPO.test(fullName)) continue;
      stars.set(fullName.toLowerCase(), { stars: Number(entry.stargazers_count) || 0, repo: entry });
    }
    return { total: Number(document?.total_count) || entries.length, entries, stars };
  }

  function readDisk() {
    return readFile(file, 'utf8').then(raw => JSON.parse(raw)).catch(() => null);
  }

  function writeDisk(value) {
    return writeFile(file, JSON.stringify(value)).catch(async error => {
      try { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); } catch { /* best effort */ }
      return undefined;
    });
  }

  async function aggregate() {
    const warnings = [];
    let npm = null;
    let github = null;
    try { npm = await fetchNpm(); } catch (error) { warnings.push({ ...discoveryFailure(error), code: 'npm' }); }
    try { github = await fetchGithub(); } catch (error) { warnings.push({ ...discoveryFailure(error), code: 'github' }); }
    if (npm === null && github === null) {
      // The baked shelf still renders without network; only a completely empty result is an error.
      const offline = mergeDiscovery({ curated: DSH_CURATED_DISCOVERY.map(curatedFallback) });
      if (!offline.length) throw new Error(warnings[0]?.message || '插件目录不可用');
      return { items: offline, info: { schemaVersion: DSH_PLUGIN_DISCOVERY_SCHEMA_VERSION, source: 'curated-offline', updatedAt: new Date(now()).toISOString(), npmTotal: 0, githubTotal: 0, curated: offline.length, warnings } };
    }

    const githubMap = github?.stars || new Map();
    const curatedSeeds = DSH_CURATED_DISCOVERY.map(seed => ({ seed, key: seed.name.toLowerCase() }));
    const seen = new Set();
    const curated = [];
    const npmCards = [];

    const byName = new Map();
    for (const object of npm?.objects || []) {
      const name = text(object?.package?.name, 214).toLowerCase();
      if (name) byName.set(name, object);
    }
    // Curated entries missing from the search page are resolved from the registry.
    const missing = curatedSeeds.filter(({ key }) => !byName.has(key));
    const resolved = new Map();
    await Promise.all(missing.map(async ({ seed, key }) => {
      try { resolved.set(key, await fetchRegistry(seed.name)); } catch { /* offline seed still renders */ }
    }));

    for (const { seed } of curatedSeeds) {
      const key = seed.name.toLowerCase();
      if (seen.has(key)) continue;
      const object = byName.get(key) || resolved.get(key);
      const item = object ? normalizeNpmDiscovery(object, { curated: seed, github: githubMap }) : curatedFallback(seed);
      curated.push(item);
      seen.add(key);
    }
    for (const object of npm?.objects || []) {
      const item = normalizeNpmDiscovery(object, { github: githubMap });
      if (!item || seen.has(item.id.toLowerCase())) continue;
      npmCards.push(item);
      seen.add(item.id.toLowerCase());
    }
    const githubOnly = [];
    for (const entry of github?.entries || []) {
      const item = normalizeGithubDiscovery(entry);
      if (!item) continue;
      if ([...seen].some(name => name === item.id.toLowerCase())) continue;
      const repo = item.repo.toLowerCase();
      if (curated.some(candidate => candidate.repo.toLowerCase() === repo) || npmCards.some(candidate => candidate.repo.toLowerCase() === repo)) continue;
      githubOnly.push(item);
    }
    const items = mergeDiscovery({ curated, npm: npmCards, githubOnly: githubOnly.slice(0, MAX_GITHUB_ONLY) });
    return {
      items,
      info: {
        schemaVersion: DSH_PLUGIN_DISCOVERY_SCHEMA_VERSION,
        source: ['npm', npmCards.length ? 'npm-search' : '', github ? 'github-search' : '', 'curated'].filter(Boolean).join('+'),
        updatedAt: new Date(now()).toISOString(),
        npmTotal: npm?.total || 0,
        githubTotal: github?.total || 0,
        curated: curated.length,
        warnings
      }
    };
  }

  async function discover({ force = false } = {}) {
    if (!force && memory && now() - memory.at < cacheTtlMs) return memory.value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const value = await aggregate();
        if (value.info?.source === 'curated-offline') {
          // Both remote sources failed: prefer the last complete catalog over the bare shelf.
          const previous = memory?.value ?? (await readDisk())?.value;
          if (previous?.items?.length) {
            memory = { at: now(), value: previous };
            return {
              ...previous,
              info: { ...previous.info, stale: true, warnings: [...(previous.info?.warnings || []), ...(value.info?.warnings || [])] }
            };
          }
        }
        memory = { at: now(), value };
        await writeDisk({ at: memory.at, value });
        return value;
      } catch (error) {
        if (memory) return { ...memory.value, info: { ...memory.value.info, stale: true, warnings: [...(memory.value.info?.warnings || []), { ...discoveryFailure(error), code: 'refresh' }] } };
        const disk = await readDisk();
        if (disk?.value?.items?.length) {
          memory = { at: disk.at || now(), value: disk.value };
          return { ...disk.value, info: { ...disk.value.info, stale: true, warnings: [...(disk.value.info?.warnings || []), { ...discoveryFailure(error), code: 'refresh' }] } };
        }
        throw error;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return { discover };
}
