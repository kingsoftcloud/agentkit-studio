/** Host-only shared configuration. No Python import, subprocess or renderer secret reads. */
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { normalizeModelEndpoint } from './model-endpoint.mjs';
import { HEADER_LIMITS, headerEntryProblem, modelRuntimeOptions } from './model-profile-contract.mjs';
import { modelReasoningConfig } from './model-reasoning.mjs';
import { isCredentialRefName } from './credential-ref.mjs';
import { dshModelRoute, HARNESS_SERVICE_MODEL_PROVIDER } from './model-route.mjs';

import { webSearchEndpoint } from './web-search-endpoint.mjs';

const FIELDS = {
  webSearchBaseUrl: [],
  modelProvider: ['MODEL_PROVIDER'], modelName: ['OPENAI_MODEL_NAME', 'DEEPSEEK_MODEL_NAME'],
  modelBaseUrl: ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'DEEPSEEK_BASE_URL'],
  modelApiKey: ['AGENTKIT_MODEL_API_KEY', 'OPENAI_API_KEY', 'MODEL_AGENT_API_KEY', 'DEEPSEEK_API_KEY'],
  cloudAccessKey: ['KSYUN_ACCESS_KEY', 'KS3_ACCESS_KEY'], cloudSecretKey: ['KSYUN_SECRET_KEY', 'KS3_SECRET_KEY'],
  cloudRegion: ['AGENTENGINE_REGION', 'KSYUN_REGION'], cloudAccountId: ['KSYUN_ACCOUNT_ID'],
  cloudServerUrl: ['AGENTENGINE_SERVER_URL'], cloudBucket: ['KS3_BUCKET'],
  cloudSessionToken: ['KSYUN_SESSION_TOKEN'], cloudServiceToken: ['AGENTENGINE_SERVICE_TOKEN'],
  cloudCustomSource: ['AGENTENGINE_PRE_CUSTOM_SOURCE'],
  modelProfiles: [], modelConnections: [], modelProfileKeys: [],
};
const SECRET_FIELDS = new Set(['modelApiKey', 'cloudAccessKey', 'cloudSecretKey', 'cloudSessionToken', 'cloudServiceToken', 'modelProfileKeys']);
const MODEL_ALIASES = {
  modelName: ['model', 'model_name', 'modelName'], modelBaseUrl: ['base_url', 'api_base', 'apiBase'],
  modelApiKey: ['api_key', 'apiKey', 'model_api_key', 'modelApiKey'], modelProvider: ['provider'],
};
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const scalar = x => typeof x === 'string' || typeof x === 'number' ? String(x).trim() : '';

/** An emptied header form removes the field instead of freezing `{}` into the config. */
function withoutEmptyHeaders(profile) {
  if (!record(profile) || !record(profile.headers) || Object.keys(profile.headers).length) return profile;
  const { headers: _headers, ...rest } = profile;
  return rest;
}

export class ConfigurationError extends Error {
  constructor(message) { super(message); this.code = 'CONFIGURATION_INVALID'; }
}

async function readDocument(path, json = false) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new ConfigurationError('全局配置文件不可读取'); }
  try {
    const value = json ? JSON.parse(source.replace(/^\uFEFF/, '')) : parse(source, { maxAliasCount: 50 });
    if (value === null) return {};
    if (!record(value)) throw new Error('object required');
    return value;
  } catch { throw new ConfigurationError('全局配置格式无效，请检查配置文件'); }
}

function normalizeProfiles(value) {
  if (!Array.isArray(value)) return [];
  const profiles = value.filter(record).map(profile => ({
    ...nativeModelOptions(profile),
    id: scalar(profile.id) || `${scalar(profile.provider) || 'provider'}:${scalar(profile.modelName) || scalar(profile.model)}`,
    ...(scalar(profile.displayName) ? {displayName:scalar(profile.displayName)} : {}),
    ...(scalar(profile.connectionName) ? { connectionName: scalar(profile.connectionName) } : {}),
    ...(scalar(profile.connectionId) ? { connectionId: scalar(profile.connectionId) } : {}),
    ...(profile.modelOnly === true ? { modelOnly: true } : {}),
    provider: scalar(profile.provider) || 'ksyun',
    modelName: scalar(profile.modelName) || scalar(profile.model),
    baseUrl: scalar(profile.baseUrl) || scalar(profile.baseURL) || '',
    credentialName: scalar(profile.credentialName) || '',
    enabled: profile.enabled !== false,
    default: profile.default === true,
    ...(profile.codexApi ? { codexApi: profile.codexApi === 'chat-completions' ? 'chat-completions' : 'responses' } : {}),
    ...(Array.isArray(profile.input) ? { input: [...new Set(profile.input.filter(item => ['text', 'image'].includes(item)))] } : {}),
    // Store the selected default and supported subset. The provider table
    // still supplies wire values when a runtime reads the profile.
    ...modelReasoningConfig({ ...profile, provider: scalar(profile.provider) || 'ksyun' }),
  })).filter(profile => profile.modelName);
  if (!profiles.length) return profiles;
  // Older config files did not have a default marker. Preserve their first
  // valid profile as the default and normalize multiple markers to one.
  const defaultIndex = profiles.findIndex(profile => profile.default);
  return profiles.map((profile, index) => ({ ...profile, default: defaultIndex < 0 ? index === 0 : index === defaultIndex }));
}

// These fields affect the Native model contract and must survive config reads
// and portable import; silently discarding them changes a frozen execution.
function nativeModelOptions(profile) {
  const result = {};
  if (profile.protocol !== undefined) {
    if (!['openai-chat', 'openai-responses', 'anthropic-messages'].includes(profile.protocol))
      throw new ConfigurationError('模型协议格式无效');
    result.protocol = profile.protocol;
  }
  for (const key of ['contextWindow', 'maxOutputTokens', 'requestTimeoutMs']) if (profile[key] !== undefined) {
    if (!Number.isSafeInteger(profile[key]) || profile[key] <= 0) throw new ConfigurationError('模型预算或超时格式无效');
    result[key] = profile[key];
  }
  if (profile.parameters !== undefined) {
    if (!record(profile.parameters)) throw new ConfigurationError('模型参数格式无效');
    result.parameters = structuredClone(profile.parameters);
  }
  if (profile.headers !== undefined) {
    // Request headers reach a gateway verbatim, so a hand-edited config file is
    // validated before it is persisted or frozen into an execution: a bad name
    // or a CR/LF value is refused instead of being sent upstream.
    if (!record(profile.headers)) throw new ConfigurationError('请求头格式无效');
    const entries = Object.entries(profile.headers);
    if (entries.length > HEADER_LIMITS.count) throw new ConfigurationError('请求头格式无效');
    const seen = new Set();
    for (const [name, value] of entries) {
      if (headerEntryProblem(name, value)) throw new ConfigurationError('请求头格式无效');
      // Header names are case-insensitive: two spellings of one header would be
      // merged into a single ambiguous wire value, so the contract keeps one.
      if (seen.has(name.toLowerCase())) throw new ConfigurationError('请求头格式无效');
      seen.add(name.toLowerCase());
    }
    // An empty record means “no custom headers”: drop the field instead of
    // freezing an empty object into the user's configuration file.
    if (entries.length) result.headers = Object.fromEntries(entries.map(([name, value]) => [name, value.trim()]));
  }
  return modelRuntimeOptions(result);
}

function normalizeModelConnections(value) {
  const connections = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!record(item)) continue;
    const id = scalar(item.id), provider = scalar(item.provider), credentialName = scalar(item.credentialName);
    if (!id || !provider || !credentialName || !scalar(item.baseUrl)) continue;
    const { headers } = nativeModelOptions({ headers: item.headers });
    const connectionName = scalar(item.connectionName);
    connections.push({ id, provider, baseUrl: normalizeModelEndpoint(item.baseUrl, provider), credentialName,
      ...(connectionName ? { connectionName } : {}), ...(headers ? { headers } : {}) });
  }
  return connections;
}

function project(document) {
  const values = {};
  const sections = ['env', 'environment', 'model', 'cloud', 'settings', 'secrets'].map(key => document[key]).filter(record);
  for (const [field, keys] of Object.entries(FIELDS)) {
    if (field === 'modelProfiles') {
      for (const section of [document, ...sections].reverse()) {
        const profiles = normalizeProfiles(section.modelProfiles);
        if (profiles.length) { values.modelProfiles = profiles; break; }
      }
      continue;
    }
    if (field === 'modelConnections') {
      for (const section of [document, ...sections].reverse()) {
        if (Array.isArray(section.modelConnections)) { values.modelConnections = normalizeModelConnections(section.modelConnections); break; }
      }
      continue;
    }
    if (field === 'modelProfileKeys') {
      for (const section of [document, ...sections].reverse()) {
        if (record(section.modelProfileKeys)) { values.modelProfileKeys = { ...section.modelProfileKeys }; break; }
      }
      continue;
    }
    for (const section of [document, ...sections].reverse()) {
      const value = [field, ...keys].map(key => scalar(section[key])).find(Boolean);
      if (value) { values[field] = value; break; }
    }
    if (!values[field] && MODEL_ALIASES[field] && record(document.model)) {
      values[field] = MODEL_ALIASES[field].map(key => scalar(document.model[key])).find(Boolean);
    }
  }
  const keys = values.modelProfileKeys || {};
  if (Array.isArray(values.modelProfiles)) values.modelProfiles = values.modelProfiles.map(profile => ({
    ...profile, apiKey: scalar(keys[profile.credentialName]) || '',
  }));
  return values;
}

/** Resolve per field: explicit environment > workspace > shared global > legacy global. */
export function createGlobalConfiguration({ env = process.env, home = homedir(), workspace, inheritLegacy = true } = {}) {
  const agentkitHome = String(env.AGENTKIT_HOME || join(home, '.agentkit')).replace(/^~(?=\/|$)/, home);
  const path = join(agentkitHome, 'config.yaml');
  let pendingWrite = Promise.resolve();
  async function resolve() {
    const layers = [
      ...(inheritLegacy ? [['legacy-global', project(await readDocument(join(home, '.agentengine', 'settings.json'), true))]] : []),
      ['global', project(await readDocument(path))],
    ];
    if (workspace) layers.push(['workspace', project(await readDocument(join(workspace, '.agentkit', 'config.yaml')))]);
    layers.push(['environment', project(env)]);
    const values = {}, sources = {};
    for (const [source, layer] of layers) for (const [key, value] of Object.entries(layer)) {
      if (value) { values[key] = value; sources[key] = source; }
    }
    // Resolve keys after merging layers so workspace profiles can reuse global
    // credentials, and environment overrides retain their documented precedence.
    for (const field of ['modelProfiles', 'modelConnections']) {
      if (values[field]) values[field] = values[field].map(item => ({ ...item,
        apiKey: scalar(env[item.credentialName]) || scalar(values.modelProfileKeys?.[item.credentialName]) || (item.credentialName === 'AGENTKIT_MODEL_API_KEY' ? values.modelApiKey : '') || '',
      }));
    }
    return { values, sources };
  }
  async function describe() {
    const { values, sources } = await resolve();
    return {
      modelProvider: values.modelProvider || 'ksyun', modelName: values.modelName || 'deepseek-v4.1-flash',
      modelProfiles: (values.modelProfiles?.length ? values.modelProfiles : [{ id: 'default', provider: values.modelProvider || 'ksyun', modelName: values.modelName || 'deepseek-v4.1-flash', baseUrl: values.modelBaseUrl || 'http://kspmas.ksyun.com/v1', credentialName: 'AGENTKIT_MODEL_API_KEY', enabled: true, apiKey: values.modelApiKey }]).map(({ apiKey, ...profile }) => ({ ...profile, credentialConfigured: Boolean(apiKey) })),
      modelConnections: (values.modelConnections || []).map(({ apiKey, ...connection }) => ({ ...connection, credentialConfigured: Boolean(apiKey) })),
      modelBaseUrl: values.modelBaseUrl || 'http://kspmas.ksyun.com/v1',
      cloudRegion: values.cloudRegion || 'cn-beijing-6',
      cloudServerUrl: values.cloudServerUrl || 'https://aicp.api.ksyun.com',
      cloudAccountId: values.cloudAccountId || '', cloudBucket: values.cloudBucket || '',
      modelConfigured: Boolean(values.modelApiKey || values.modelProfiles?.some(profile => profile.apiKey)),
      cloudAccountConfigured: Boolean(values.cloudAccessKey && values.cloudSecretKey),
      configurationSources: sources,
      configurationOwner: 'studio-node',
      webSearchBaseUrl: values.webSearchBaseUrl || '',
    };
  }
  const listeners = new Set();
  function update(patch) {
    if (record(patch) && Object.hasOwn(patch, 'webSearchBaseUrl')) {
      try { patch = { ...patch, webSearchBaseUrl: webSearchEndpoint(patch.webSearchBaseUrl) }; }
      catch { return Promise.reject(new ConfigurationError('搜索 API 地址需使用 HTTPS，或本机 HTTP，且不能包含凭据或查询参数。')); }
    }
    if (!record(patch) || Object.keys(patch).some(key => !Object.hasOwn(FIELDS, key))) {
      return Promise.reject(new ConfigurationError('存在不支持的配置字段'));
    }
    try {
      patch = { ...patch,
        ...(typeof patch.modelBaseUrl === 'string' ? { modelBaseUrl: normalizeModelEndpoint(patch.modelBaseUrl, patch.modelProvider) } : {}),
        ...(Array.isArray(patch.modelProfiles) ? { modelProfiles: patch.modelProfiles.map(profile => record(profile)
          ? withoutEmptyHeaders({ ...profile, baseUrl: profile.baseUrl ? normalizeModelEndpoint(profile.baseUrl, profile.provider) : '' }) : profile) } : {}),
      };
      if (Object.hasOwn(patch, 'modelConnections')) {
        const connections = normalizeModelConnections(patch.modelConnections);
        if (!Array.isArray(patch.modelConnections) || connections.length !== patch.modelConnections.length
          || new Set(connections.map(item => item.id)).size !== connections.length) throw new ConfigurationError('模型提供商配置格式无效');
        patch.modelConnections = connections;
      }
    } catch (error) { return Promise.reject(error); }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'modelProfiles') {
        if (!Array.isArray(value) || value.some(profile => !record(profile) || !scalar(profile.modelName) || !scalar(profile.provider))) return Promise.reject(new ConfigurationError('模型目录格式无效'));
        if (value.some(profile => !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(String(profile.id || '').trim())
          || profile.credentialName !== undefined && String(profile.credentialName).trim() && !isCredentialRefName(profile.credentialName))) return Promise.reject(new ConfigurationError('模型 ID 或凭证引用格式无效'));
        // A route is keyed on the connection id, falling back to provider+endpoint
        // and finally the profile id. Reserve the Harness service route against
        // every spelling a profile could produce, so a connection id (not just an
        // id) cannot shadow it either.
        if (value.some(profile => profile.enabled !== false && [
          dshModelRoute(profile),
          dshModelRoute({ ...profile, connectionId: undefined }),
          dshModelRoute({ ...profile, connectionId: String(profile.id || '') }),
        ].includes(HARNESS_SERVICE_MODEL_PROVIDER)))
          return Promise.reject(new ConfigurationError('模型 ID 与 Star Harness 内部路由冲突，请修改模型 ID'));
        if (value.some(profile => profile.codexApi && !['responses', 'chat-completions'].includes(profile.codexApi))) return Promise.reject(new ConfigurationError('Codex 模型接口格式无效'));
        try { value.forEach(nativeModelOptions); } catch (error) { return Promise.reject(error); }
      } else if (key === 'modelProfileKeys') {
        if (!record(value) || Object.values(value).some(item => typeof item !== 'string')) return Promise.reject(new ConfigurationError('模型凭证格式无效'));
      } else if (key !== 'modelConnections' && typeof value !== 'string') return Promise.reject(new ConfigurationError('配置值必须为文本'));
    }
    const write = async () => {
      const document = await readDocument(path);
      document.settings = record(document.settings) ? document.settings : {};
      document.secrets = record(document.secrets) ? document.secrets : {};
      for (const [field, value] of Object.entries(patch)) {
        if (field === 'modelProfileKeys') {
          const current = record(document.secrets.modelProfileKeys) ? document.secrets.modelProfileKeys : {};
          for (const [name, key] of Object.entries(value)) if (String(key).trim()) current[name] = String(key).trim();
          document.secrets.modelProfileKeys = current;
        } else if (SECRET_FIELDS.has(field)) {
          if (value.trim()) document.secrets[FIELDS[field][0]] = value.trim();
        } else if (field === 'modelProfiles') document.settings.modelProfiles = value.map(profile => {
          const { apiKey, ...metadata } = profile;
          return metadata;
        });
        else if (field === 'modelConnections') document.settings.modelConnections = value;
        else document.settings[field] = value.trim();
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, stringify(document), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      const current = await describe();
      for (const listener of listeners) listener(current);
      return current;
    };
    const result = pendingWrite.then(write);
    pendingWrite = result.catch(() => {}); // One rejected write must not block later corrections.
    return result;
  }
  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  return { resolve, describe, update, onChange };
}
