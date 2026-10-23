/** Host-only shared configuration. No Python import, subprocess or renderer secret reads. */
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { normalizeModelEndpoint } from './model-endpoint.mjs';

const FIELDS = {
  modelProvider: ['MODEL_PROVIDER'], modelName: ['OPENAI_MODEL_NAME', 'DEEPSEEK_MODEL_NAME'],
  modelBaseUrl: ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'DEEPSEEK_BASE_URL'],
  modelApiKey: ['AGENTKIT_MODEL_API_KEY', 'OPENAI_API_KEY', 'MODEL_AGENT_API_KEY', 'DEEPSEEK_API_KEY'],
  cloudAccessKey: ['KSYUN_ACCESS_KEY', 'KS3_ACCESS_KEY'], cloudSecretKey: ['KSYUN_SECRET_KEY', 'KS3_SECRET_KEY'],
  cloudRegion: ['AGENTENGINE_REGION', 'KSYUN_REGION'], cloudAccountId: ['KSYUN_ACCOUNT_ID'],
  cloudServerUrl: ['AGENTENGINE_SERVER_URL'], cloudBucket: ['KS3_BUCKET'],
  cloudSessionToken: ['KSYUN_SESSION_TOKEN'], cloudServiceToken: ['AGENTENGINE_SERVICE_TOKEN'],
  cloudCustomSource: ['AGENTENGINE_PRE_CUSTOM_SOURCE'],
  modelProfiles: [], modelProfileKeys: [],
};
const SECRET_FIELDS = new Set(['modelApiKey', 'cloudAccessKey', 'cloudSecretKey', 'cloudSessionToken', 'cloudServiceToken', 'modelProfileKeys']);
const MODEL_ALIASES = {
  modelName: ['model', 'model_name', 'modelName'], modelBaseUrl: ['base_url', 'api_base', 'apiBase'],
  modelApiKey: ['api_key', 'apiKey', 'model_api_key', 'modelApiKey'], modelProvider: ['provider'],
};
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const scalar = x => typeof x === 'string' || typeof x === 'number' ? String(x).trim() : '';

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
    provider: scalar(profile.provider) || 'ksyun',
    modelName: scalar(profile.modelName) || scalar(profile.model),
    baseUrl: scalar(profile.baseUrl) || scalar(profile.baseURL) || '',
    credentialName: scalar(profile.credentialName) || '',
    enabled: profile.enabled !== false,
    default: profile.default === true,
    ...(profile.codexApi ? { codexApi: profile.codexApi === 'chat-completions' ? 'chat-completions' : 'responses' } : {}),
    ...(Array.isArray(profile.input) ? { input: [...new Set(profile.input.filter(item => ['text', 'image'].includes(item)))] } : {}),
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
  return result;
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
    if (values.modelProfiles) values.modelProfiles = values.modelProfiles.map(profile => ({ ...profile,
      apiKey: scalar(env[profile.credentialName]) || scalar(values.modelProfileKeys?.[profile.credentialName]) || (profile.credentialName === 'AGENTKIT_MODEL_API_KEY' ? values.modelApiKey : '') || '',
    }));
    return { values, sources };
  }
  async function describe() {
    const { values, sources } = await resolve();
    return {
      modelProvider: values.modelProvider || 'ksyun', modelName: values.modelName || 'deepseek-v4.1-flash',
      modelProfiles: (values.modelProfiles?.length ? values.modelProfiles : [{ id: 'default', provider: values.modelProvider || 'ksyun', modelName: values.modelName || 'deepseek-v4.1-flash', baseUrl: values.modelBaseUrl || 'http://kspmas.ksyun.com/v1', credentialName: 'AGENTKIT_MODEL_API_KEY', enabled: true, apiKey: values.modelApiKey }]).map(({ apiKey, ...profile }) => ({ ...profile, credentialConfigured: Boolean(apiKey) })),
      modelBaseUrl: values.modelBaseUrl || 'http://kspmas.ksyun.com/v1',
      cloudRegion: values.cloudRegion || 'cn-beijing-6',
      cloudServerUrl: values.cloudServerUrl || 'https://aicp.api.ksyun.com',
      cloudAccountId: values.cloudAccountId || '', cloudBucket: values.cloudBucket || '',
      modelConfigured: Boolean(values.modelApiKey || values.modelProfiles?.some(profile => profile.apiKey)),
      cloudAccountConfigured: Boolean(values.cloudAccessKey && values.cloudSecretKey),
      configurationSources: sources,
      configurationOwner: 'studio-node',
    };
  }
  function update(patch) {
    if (!record(patch) || Object.keys(patch).some(key => !Object.hasOwn(FIELDS, key))) {
      return Promise.reject(new ConfigurationError('存在不支持的配置字段'));
    }
    try {
      patch = { ...patch,
        ...(typeof patch.modelBaseUrl === 'string' ? { modelBaseUrl: normalizeModelEndpoint(patch.modelBaseUrl, patch.modelProvider) } : {}),
        ...(Array.isArray(patch.modelProfiles) ? { modelProfiles: patch.modelProfiles.map(profile => record(profile)
          ? { ...profile, baseUrl: profile.baseUrl ? normalizeModelEndpoint(profile.baseUrl, profile.provider) : '' } : profile) } : {}),
      };
    } catch (error) { return Promise.reject(error); }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'modelProfiles') {
        if (!Array.isArray(value) || value.some(profile => !record(profile) || !scalar(profile.modelName) || !scalar(profile.provider))) return Promise.reject(new ConfigurationError('模型目录格式无效'));
        if (value.some(profile => profile.codexApi && !['responses', 'chat-completions'].includes(profile.codexApi))) return Promise.reject(new ConfigurationError('Codex 模型接口格式无效'));
        try { value.forEach(nativeModelOptions); } catch (error) { return Promise.reject(error); }
      } else if (key === 'modelProfileKeys') {
        if (!record(value) || Object.values(value).some(item => typeof item !== 'string')) return Promise.reject(new ConfigurationError('模型凭证格式无效'));
      } else if (typeof value !== 'string') return Promise.reject(new ConfigurationError('配置值必须为文本'));
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
        else document.settings[field] = value.trim();
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, stringify(document), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      return describe();
    };
    const result = pendingWrite.then(write);
    pendingWrite = result.catch(() => {}); // One rejected write must not block later corrections.
    return result;
  }
  return { resolve, describe, update };
}
