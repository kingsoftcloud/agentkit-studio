/** Browser-side recognition of pasted MCP JSON snippets.
 *
 * The dialog only extracts connection metadata. Secret header values are
 * returned to the caller's transient form state so they can be written to the
 * Host credential service; they are never part of a resource declaration and
 * never reach `server.headers` or `server.env` (the Host store rejects literal
 * secrets there and only persists `env://` credential references).
 */

import { deriveCredentialRefName } from '../../credential-ref.mjs';

export const MCP_JSON_IMPORT_CONTRACT = 'agentkit.mcp-json-import/v1';

// Mirrors the Host store's public-header allowlist: these may keep a literal
// value. Keep both lists in sync; `mcp-protocol-version` is client-owned.
const PUBLIC_HEADER = /^(?:accept|content-type|x-request-source|x-skill-version|x-.*-client|x-.*-surface)$/i;
// ${NAME}, ${user_config.NAME}, ${env:NAME}, ${input:api-key}
const PLACEHOLDER = /\$\{\s*(?:(?:user_config|env|input)\s*[.:]\s*)?([A-Za-z_][A-Za-z0-9_.:/-]*)\s*\}/;
const SECRET_ENV = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i;
const SECRET_VALUE = /(?:^|\s)(?:Bearer|Basic|Token)\s+\S+|[a-z][a-z0-9+.-]*:\/\/[^/\s@]*@/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const DESCRIPTOR_HINTS = ['url', 'endpointUrl', 'endpoint', 'serverUrl', 'command', 'type', 'transport'];
const KNOWN_TYPES = ['http', 'https', 'streamablehttp', 'httpstream', 'streamable', 'sse', 'stdio'];

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => value == null ? '' : String(value).trim();

function slug(value, fallback = '') {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || fallback;
}

/** Stable short digest so same-named servers on different endpoints never share a credential. */
function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0').slice(0, 6);
}

/** Stable Host credential name for a header/env secret that had no ${...} reference. */
export function mcpCredentialName(serverKey, target, scope = '') {
  const prefix = `MCP_${slug(serverKey, 'SERVER').toUpperCase().replace(/-/g, '_')}`;
  const suffix = slug(target, 'CREDENTIAL').toUpperCase().replace(/-/g, '_');
  const digest = scope ? `_${stableHash(scope)}` : '';
  return `${prefix}_${suffix}${digest}`.slice(0, 120).replace(/_+$/, '');
}

/**
 * Reference for a `${VAR}` placeholder or a header/env name. The grammar lives in
 * `src/credential-ref.mjs` so every writer derives the same name: DSH only
 * accepts POSIX identifiers, and a name like `X-API.Token` must not reach the
 * credential store from this path either.
 */
function referenceName(value, fallback) {
  return deriveCredentialRefName(text(value), fallback);
}

function forEachObjectEntry(value, visit) {
  if (!isObject(value)) return;
  for (const [name, entry] of Object.entries(value)) visit(text(name), entry);
}

function readUrl(descriptor) {
  for (const key of ['url', 'endpointUrl', 'endpoint', 'serverUrl']) {
    const value = descriptor[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (isObject(value) && typeof value.url === 'string' && value.url.trim()) return value.url.trim();
  }
  return '';
}

function unwrapMarkdownLink(value) {
  const match = String(value || '').match(/^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i);
  return match ? match[1] : String(value || '');
}

function splitArgs(value) {
  const args = [];
  for (const match of value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}

function deriveKey(descriptor) {
  const url = unwrapMarkdownLink(readUrl(descriptor));
  if (url) {
    try {
      const host = new URL(url).hostname.split('.')[0];
      if (host && !/^\d+$/.test(host)) return slug(host, 'mcp-server');
    } catch { /* the caller reports the invalid URL */ }
  }
  const command = text(descriptor.command);
  if (command) {
    const base = command.split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]+$/, '');
    const name = slug(base);
    if (name) return name;
  }
  return 'mcp-server';
}

function transportOf(descriptor) {
  const declared = text(descriptor.type || descriptor.transport);
  const kind = declared.toLowerCase().replace(/[-_\s]/g, '');
  if (text(descriptor.command) || kind === 'stdio') return { transport: 'stdio', declared, known: !kind || kind === 'stdio' };
  if (kind.includes('sse')) return { transport: 'sse', declared, known: true };
  return { transport: 'http', declared, known: !declared || KNOWN_TYPES.includes(kind) };
}

function classifyHeaders(serverKey, headers, warnings, scope) {
  const publicHeaders = {}, credentialHeaders = [];
  forEachObjectEntry(headers, (name, rawValue) => {
    if (!name) return;
    if (!HEADER_NAME.test(name)) { warnings.push(`Header 名称 ${name} 无效，已跳过`); return; }
    if (rawValue !== null && typeof rawValue === 'object') { warnings.push(`Header ${name} 的值不是字符串，已跳过`); return; }
    if (name.toLowerCase() === 'mcp-protocol-version') { warnings.push('Header mcp-protocol-version 由 MCP 客户端协商，已忽略'); return; }
    const value = text(rawValue);
    const placeholder = value.match(PLACEHOLDER);
    // Public headers may never contain interpolation; the Host store rejects it.
    if (PUBLIC_HEADER.test(name) && !value.includes('${')) { publicHeaders[name] = value; return; }
    if (value.includes('${') && !placeholder) warnings.push(`Header ${name} 的占位符无法解析，已按字面量凭证处理`);
    if (placeholder && value.replace(PLACEHOLDER, '').trim()
      && !(name.toLowerCase() === 'authorization' && /^Bearer\s*$/i.test(value.replace(PLACEHOLDER, '').trim()))) {
      warnings.push(`Header ${name} 的模板只保留凭证引用，额外前缀/后缀会丢失`);
    }
    const fallback = mcpCredentialName(serverKey, name, scope);
    const reference = placeholder?.[1] ? referenceName(placeholder[1], fallback) : fallback;
    credentialHeaders.push({ target: 'header', key: name, reference, credentialRef: `env://${reference}`,
      ...(placeholder ? { placeholder: true } : { value }) });
  });
  return { publicHeaders, credentialHeaders };
}

function classifyEnv(serverKey, env, warnings, scope) {
  const publicEnv = {}, credentialHeaders = [];
  forEachObjectEntry(env, (name, rawValue) => {
    if (!name) return;
    if (rawValue !== null && typeof rawValue === 'object') { warnings.push(`环境变量 ${name} 的值不是字符串，已跳过`); return; }
    const value = text(rawValue), placeholder = value.match(PLACEHOLDER);
    if (!placeholder && !SECRET_ENV.test(`${name} ${value}`) && !SECRET_VALUE.test(value)) { publicEnv[name] = value; return; }
    if (value.includes('${') && !placeholder) warnings.push(`环境变量 ${name} 的占位符无法解析，已按字面量凭证处理`);
    if (placeholder && value.replace(PLACEHOLDER, '').trim()) warnings.push(`环境变量 ${name} 的模板只保留凭证引用，额外前后缀会丢失`);
    const fallback = mcpCredentialName(serverKey, name, scope);
    const reference = placeholder?.[1] ? referenceName(placeholder[1], fallback) : fallback;
    credentialHeaders.push({ target: 'env', key: name, reference, credentialRef: `env://${reference}`,
      ...(placeholder ? { placeholder: true } : { value }) });
  });
  return { publicEnv, credentialHeaders };
}

function normalizeEntry(serverKey, descriptor, source) {
  const warnings = [], errors = [];
  const key = text(serverKey) || deriveKey(descriptor);
  const { transport, declared, known } = transportOf(descriptor);
  if (declared && !known) warnings.push(`未识别的传输方式 ${declared}，已按 ${transport.toUpperCase()} 处理`);
  const entry = {
    key, displayName: text(descriptor.name || descriptor.displayName) || key,
    description: text(descriptor.description || descriptor.detail), version: text(descriptor.version) || '1.0.0',
    transport, endpointUrl: '', command: '', args: [], publicHeaders: {}, publicEnv: {},
    credentialHeaders: [], envRefs: {}, warnings, errors, source,
  };
  if (transport === 'stdio') {
    entry.command = text(descriptor.command);
    if (Array.isArray(descriptor.args)) entry.args = descriptor.args.map(item => typeof item === 'string' ? item : JSON.stringify(item));
    else if (typeof descriptor.args === 'string' && descriptor.args.trim()) {
      entry.args = splitArgs(descriptor.args.trim());
      warnings.push('启动参数是字符串，已按空格拆分');
    } else if (descriptor.args != null) warnings.push('args 不是数组或字符串，已忽略');
    if (!entry.command) errors.push('stdio MCP 缺少启动命令');
    if (descriptor.env != null && !isObject(descriptor.env)) warnings.push('env 不是对象，已忽略');
    const env = classifyEnv(key, descriptor.env, warnings, `${entry.command} ${entry.args.join(' ')}`);
    entry.publicEnv = env.publicEnv;
    entry.credentialHeaders = env.credentialHeaders;
    if (entry.args.some(arg => PLACEHOLDER.test(arg))) warnings.push('启动参数包含 ${...} 引用，当前导入不会替换，请手动确认');
  } else {
    entry.endpointUrl = unwrapMarkdownLink(readUrl(descriptor));
    if (!/^https?:\/\//i.test(entry.endpointUrl)) errors.push('缺少可直接访问的 http(s) MCP 地址');
    else if (entry.endpointUrl.includes('${')) errors.push('MCP 地址包含 ${...} 变量，当前导入不支持替换，请填写真实地址');
    else {
      let parsed;
      try { parsed = new URL(entry.endpointUrl); } catch { parsed = null; }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) errors.push('MCP 地址不是有效的 http(s) URL');
      else {
        if (parsed.username || parsed.password) errors.push('MCP 地址不能内嵌用户名或密码，请改用认证 Header');
        if (parsed.search) warnings.push('MCP 地址包含查询参数，将按原样保存；如含凭证建议改用认证 Header');
      }
    }
    if (descriptor.headers != null && !isObject(descriptor.headers)) warnings.push('headers 不是对象，已忽略');
    const headers = classifyHeaders(key, descriptor.headers, warnings, entry.endpointUrl);
    entry.publicHeaders = headers.publicHeaders;
    entry.credentialHeaders = headers.credentialHeaders;
    if (isObject(descriptor.env) && Object.keys(descriptor.env).length) warnings.push('HTTP MCP 的 env 不会用于请求，已忽略');
    if (Array.isArray(descriptor.args) && descriptor.args.length) warnings.push('HTTP MCP 的 args 不会用于请求，已忽略');
  }
  entry.envRefs = Object.fromEntries(entry.credentialHeaders.map(row => [row.key, `env://${row.reference}`]));
  return entry;
}

function descriptorRows(rows, source) {
  return rows.filter(isObject).map(item => [text(item.name || item.key || item.id), item, source]);
}

function collectRows(parsed) {
  if (Array.isArray(parsed)) {
    const rows = descriptorRows(parsed, 'array');
    return rows.length ? { rows } : { error: 'JSON 数组中没有可识别的 MCP Server 配置。' };
  }
  if (!isObject(parsed)) return { error: '请粘贴 JSON 对象或数组形式的 MCP 配置。' };
  for (const wrapper of ['mcpServers', 'servers']) {
    if (isObject(parsed[wrapper])) return { rows: Object.entries(parsed[wrapper]).map(([key, value]) => [key, value, wrapper]) };
    if (Array.isArray(parsed[wrapper])) return { rows: descriptorRows(parsed[wrapper], wrapper) };
  }
  if (isObject(parsed.mcp) && isObject(parsed.mcp.servers)) {
    return { rows: Object.entries(parsed.mcp.servers).map(([key, value]) => [key, value, 'mcp.servers']) };
  }
  if (DESCRIPTOR_HINTS.some(name => typeof parsed[name] === 'string' && parsed[name].trim())) return { rows: [['', parsed, 'direct']] };
  return { rows: Object.entries(parsed).filter(([, value]) => isObject(value)).map(([key, value]) => [key, value, 'map']) };
}

/** Recognizes mcpServers, servers, bare name->server maps, single descriptors and arrays. */
export function parseMcpJsonImport(value) {
  const raw = text(value);
  if (!raw) return { ok: false, error: '请先粘贴 MCP JSON 配置。' };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { return { ok: false, error: `JSON 格式无法解析：${error?.message || '语法错误'}` }; }
  const collected = collectRows(parsed);
  if (collected.error) return { ok: false, error: collected.error };
  const entries = collected.rows.filter(([, descriptor]) => isObject(descriptor))
    .map(([key, descriptor, source]) => normalizeEntry(key, descriptor, source));
  if (!entries.length) return { ok: false, error: '没有找到 MCP Server 配置。支持 {"mcpServers": {...}}、{"servers": {...}} 或直接粘贴单个服务配置。' };
  return { ok: true, contract: MCP_JSON_IMPORT_CONTRACT, entries,
    warnings: entries.flatMap(entry => entry.warnings.map(message => `${entry.key}：${message}`)) };
}
