/** Curated DSH plugin catalog shown by the Studio plugin market.
 *
 * The built-in list ships with the product and stays available offline. An
 * operator can point `AGENTKIT_STUDIO_DSH_PLUGIN_INDEX` (or
 * `DSH_PLUGIN_INDEX_URL`) at an HTTPS JSON document to refresh the list
 * without a product release. Installation, profile writes, compatibility
 * checks, approvals and runtime loading stay owned by the official DSH plugin
 * manager; this module is metadata only.
 *
 * Trust boundary: a remote document may describe which plugins to offer and
 * how to present them. It may not declare host verification probes
 * (`expectedEntries`, `service`, `readinessNote`) — those stay host-owned so a
 * remote list cannot make the adapter call arbitrary host services.
 */

export const DSH_PLUGIN_CATALOG_SCHEMA_VERSION = 1;
export const DSH_PLUGIN_INDEX_ENV = 'AGENTKIT_STUDIO_DSH_PLUGIN_INDEX';
export const DSH_PLUGIN_INDEX_ENV_ALIASES = Object.freeze([DSH_PLUGIN_INDEX_ENV, 'DSH_PLUGIN_INDEX_URL']);

const MAX_ENTRIES = 500;
const PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9.^~<>=*+-]+)?$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class DshPluginCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DshPluginCatalogError';
    this.code = code;
    this.details = details;
  }
}

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function text(value, max) {
  return scalar(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function textList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function httpsUrl(value) {
  const candidate = text(value, 400);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/** Short glyph or HTTPS image for the market row; remote lists cannot inline data. */
function iconValue(value) {
  const candidate = scalar(value).trim();
  if (!candidate) return '';
  if (candidate.length <= 8 && !/[\s<>]/.test(candidate)) return candidate;
  return httpsUrl(candidate);
}

function normalizeService(service) {
  if (!service || typeof service !== 'object' || Array.isArray(service)) return undefined;
  const name = text(service.name, 64);
  const methods = textList(service.methods, 16, 64).filter(method => IDENTIFIER.test(method));
  if (!name || !IDENTIFIER.test(name) || !methods.length) return undefined;
  const probe = text(service.probe, 64);
  return { name, methods, ...(probe && IDENTIFIER.test(probe) ? { probe } : {}) };
}

function withoutEmpty(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== '' && value !== undefined));
}

/** Normalize one catalog row. Invalid ids/specs are dropped instead of guessed. */
export function normalizeCatalogEntry(raw, { source = 'builtin' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = text(raw.id ?? raw.pluginId ?? raw.name, 120);
  if (!id || !PACKAGE_SPEC.test(id)) return null;
  const installSpec = text(raw.installSpec, 140) || id;
  if (!PACKAGE_SPEC.test(installSpec)) return null;
  const entry = {
    id,
    installSpec,
    displayName: text(raw.displayName, 80) || id,
    description: text(raw.description, 400),
    category: text(raw.category, 24) || '其他',
    tags: textList(raw.tags, 8, 24),
    featured: raw.featured === true,
    experimental: raw.experimental === true,
    capabilities: textList(raw.capabilities, 12, 40),
    homepage: httpsUrl(raw.homepage),
    repository: httpsUrl(raw.repository),
    author: text(raw.author, 60),
    icon: iconValue(raw.icon),
    origin: source,
  };
  if (source === 'builtin') {
    entry.expectedEntries = textList(raw.expectedEntries, 12, 60);
    entry.service = normalizeService(raw.service);
    entry.readinessNote = text(raw.readinessNote, 200);
    entry.defaultEnabled = raw.defaultEnabled === true;
    entry.tags = entry.tags.length ? entry.tags : textList(raw.capabilities, 4, 24);
  }
  return withoutEmpty(entry);
}

/** First-party bundles Studio curates for the DSH plugin market. */
export const DSH_CURATED_PLUGINS = Object.freeze([
  {
    id: '@kingsoftcloud/agentkit-personal-assistant',
    installSpec: '@kingsoftcloud/agentkit-personal-assistant',
    displayName: '个人助理',
    description: '右侧助理对话面板，并可连接用户专属云电脑：看屏幕、开浏览器、操作桌面。',
    category: '助理',
    tags: ['个人助理', '云电脑', '桌面', '浏览器'],
    featured: true,
    experimental: true,
    defaultEnabled: false,
    capabilities: ['助理对话面板', '云电脑桌面画面', '浏览器 / 终端 / 文件', '剪贴板快捷键'],
    readinessNote: '插件已启用；首次使用需要在「设置 → 个人助理」中连接云端电脑。',
  },
  {
    id: '@deepseek-ai/dsh-experimental-agent-team-profile',
    installSpec: '@deepseek-ai/dsh-experimental-agent-team-profile',
    displayName: 'Agent Teams',
    description: '团队委派、成员会话、共享任务板与成员消息。',
    category: '协作',
    tags: ['团队', '委派', '共享任务'],
    featured: true,
    experimental: true,
    defaultEnabled: false,
    capabilities: ['spawn_teammate', 'list_agents', 'team_task', '成员会话'],
    expectedEntries: ['agent-team', 'tool-agent-team', 'ui-agent-team'],
    service: { name: 'agentTeams', methods: ['listMembers', 'spawnTeammate', 'createTask'] },
    readinessNote: 'Host 已加载 Agent Teams 服务、工具和 Web 界面。',
  },
  {
    id: '@deepseek-ai/dsh-experimental-voice-input-bundle',
    installSpec: '@deepseek-ai/dsh-experimental-voice-input-bundle',
    displayName: '语音输入',
    description: '本地语音识别、麦克风录音与可编辑草稿插入。',
    category: '输入',
    tags: ['语音', '转写'],
    featured: true,
    experimental: true,
    defaultEnabled: false,
    capabilities: ['麦克风录音', 'SenseVoice 转写', '草稿插入'],
    expectedEntries: ['speech-to-text', 'speech-to-text-sensevoice', 'api-speech-to-text', 'ui-voice-input'],
    service: { name: 'speechToText', methods: ['snapshot', 'prepare', 'transcribe'], probe: 'snapshot' },
    readinessNote: 'Host 已加载语音服务；首次使用仍需准备本地识别模型并获得麦克风权限。',
  },
  {
    id: '@deepseek-ai/dsh-experimental-auto-review',
    installSpec: '@deepseek-ai/dsh-experimental-auto-review',
    displayName: 'Auto Review',
    description: '在工具调用执行前使用当前模型进行风险审查和授权决策。',
    category: '权限',
    tags: ['权限', '审查'],
    featured: true,
    experimental: true,
    defaultEnabled: false,
    capabilities: ['工具风险审查', 'Auto 权限模式', '拒绝原因展示'],
    expectedEntries: ['auto-review'],
    service: { name: 'permissionPresets', methods: ['current', 'registerAuto', 'set'] },
    readinessNote: 'Host 已加载 Auto Review 权限扩展；实际审查会增加一次模型调用。',
  },
]);

const BUILTIN_BY_ID = new Map(DSH_CURATED_PLUGINS.map(item => [item.id, item]));

export function dshCuratedPlugin(id) {
  return BUILTIN_BY_ID.get(String(id || '').trim());
}

function cloneEntry(entry) {
  return {
    ...entry,
    ...(Array.isArray(entry.tags) ? { tags: [...entry.tags] } : {}),
    ...(Array.isArray(entry.capabilities) ? { capabilities: [...entry.capabilities] } : {}),
    ...(Array.isArray(entry.expectedEntries) ? { expectedEntries: [...entry.expectedEntries] } : {}),
    ...(entry.service ? { service: { ...entry.service, methods: [...entry.service.methods] } } : {}),
  };
}

export function dshCuratedEntries() {
  return DSH_CURATED_PLUGINS.map(cloneEntry);
}

/** Parse a remote index document (`{ plugins: [...] }` or a bare array). */
export function normalizeCatalogDocument(document) {
  const payload = Array.isArray(document) ? { plugins: document } : document;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DshPluginCatalogError('DSH_PLUGIN_CATALOG_INVALID', '插件索引必须是 JSON 对象或数组');
  }
  if (payload.schemaVersion !== undefined && payload.schemaVersion !== DSH_PLUGIN_CATALOG_SCHEMA_VERSION) {
    throw new DshPluginCatalogError('DSH_PLUGIN_CATALOG_VERSION_UNSUPPORTED', '插件索引版本不受支持');
  }
  const rows = payload.plugins;
  if (!Array.isArray(rows)) throw new DshPluginCatalogError('DSH_PLUGIN_CATALOG_INVALID', '插件索引缺少 plugins 数组');
  if (rows.length > MAX_ENTRIES) throw new DshPluginCatalogError('DSH_PLUGIN_CATALOG_TOO_LARGE', '插件索引条目数超出上限');
  const entries = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows) {
    const entry = normalizeCatalogEntry(row, { source: 'remote' });
    if (!entry || seen.has(entry.id)) { skipped += 1; continue; }
    seen.add(entry.id);
    entries.push(entry);
  }
  const updatedAt = text(payload.updatedAt, 40);
  return { entries, updatedAt: Number.isNaN(Date.parse(updatedAt)) ? '' : updatedAt, skipped };
}

/** Built-in rows first; remote rows refresh copy and append new plugins. */
export function mergeCatalogEntries(builtin = dshCuratedEntries(), remote = []) {
  const merged = new Map();
  for (const entry of builtin) merged.set(entry.id, cloneEntry(entry));
  for (const entry of remote) {
    const existing = merged.get(entry.id);
    if (!existing) {
      merged.set(entry.id, cloneEntry({ ...entry, origin: 'remote' }));
      continue;
    }
    merged.set(entry.id, cloneEntry({
      ...existing,
      displayName: entry.displayName || existing.displayName,
      description: entry.description || existing.description,
      category: entry.category && entry.category !== '其他' ? entry.category : existing.category,
      tags: entry.tags?.length ? entry.tags : existing.tags,
      featured: entry.featured || existing.featured,
      experimental: entry.experimental || existing.experimental,
      capabilities: entry.capabilities?.length ? entry.capabilities : existing.capabilities,
      homepage: entry.homepage || existing.homepage,
      repository: entry.repository || existing.repository,
      author: entry.author || existing.author,
      icon: entry.icon || existing.icon,
      installSpec: entry.installSpec || existing.installSpec,
      origin: 'remote',
    }));
  }
  return [...merged.values()];
}
