/** Host-only shared configuration. No Python import, subprocess or renderer secret reads. */
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';

const FIELDS = {
  modelProvider: ['MODEL_PROVIDER'], modelName: ['OPENAI_MODEL_NAME', 'DEEPSEEK_MODEL_NAME'],
  modelBaseUrl: ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'DEEPSEEK_BASE_URL'],
  modelApiKey: ['AGENTKIT_MODEL_API_KEY', 'OPENAI_API_KEY', 'MODEL_AGENT_API_KEY', 'DEEPSEEK_API_KEY'],
  cloudAccessKey: ['KSYUN_ACCESS_KEY', 'KS3_ACCESS_KEY'], cloudSecretKey: ['KSYUN_SECRET_KEY', 'KS3_SECRET_KEY'],
  cloudRegion: ['AGENTENGINE_REGION', 'KSYUN_REGION'], cloudAccountId: ['KSYUN_ACCOUNT_ID'],
  cloudServerUrl: ['AGENTENGINE_SERVER_URL'], cloudBucket: ['KS3_BUCKET'],
  cloudSessionToken: ['KSYUN_SESSION_TOKEN'], cloudServiceToken: ['AGENTENGINE_SERVICE_TOKEN'],
  cloudCustomSource: ['AGENTENGINE_PRE_CUSTOM_SOURCE'],
};
const SECRET_FIELDS = new Set(['modelApiKey', 'cloudAccessKey', 'cloudSecretKey', 'cloudSessionToken', 'cloudServiceToken']);
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

function project(document) {
  const values = {};
  const sections = ['env', 'environment', 'model', 'cloud', 'settings', 'secrets'].map(key => document[key]).filter(record);
  for (const [field, keys] of Object.entries(FIELDS)) {
    for (const section of [document, ...sections].reverse()) {
      const value = [field, ...keys].map(key => scalar(section[key])).find(Boolean);
      if (value) { values[field] = value; break; }
    }
    if (!values[field] && MODEL_ALIASES[field] && record(document.model)) {
      values[field] = MODEL_ALIASES[field].map(key => scalar(document.model[key])).find(Boolean);
    }
  }
  return values;
}

/** Resolve per field: explicit environment > workspace > shared global > legacy global. */
export function createGlobalConfiguration({ env = process.env, home = homedir(), workspace } = {}) {
  const agentkitHome = String(env.AGENTKIT_HOME || join(home, '.agentkit')).replace(/^~(?=\/|$)/, home);
  const path = join(agentkitHome, 'config.yaml');
  let pendingWrite = Promise.resolve();
  async function resolve() {
    const layers = [
      ['legacy-global', project(await readDocument(join(home, '.agentengine', 'settings.json'), true))],
      ['global', project(await readDocument(path))],
    ];
    if (workspace) layers.push(['workspace', project(await readDocument(join(workspace, '.agentkit', 'config.yaml')))]);
    layers.push(['environment', project(env)]);
    const values = {}, sources = {};
    for (const [source, layer] of layers) for (const [key, value] of Object.entries(layer)) {
      if (value) { values[key] = value; sources[key] = source; }
    }
    return { values, sources };
  }
  async function describe() {
    const { values, sources } = await resolve();
    return {
      modelProvider: values.modelProvider || 'ksyun', modelName: values.modelName || 'deepseek-v4.1-flash',
      modelBaseUrl: values.modelBaseUrl || 'http://kspmas.ksyun.com/v1',
      cloudRegion: values.cloudRegion || 'cn-beijing-6',
      cloudServerUrl: values.cloudServerUrl || 'https://aicp.api.ksyun.com',
      cloudAccountId: values.cloudAccountId || '', cloudBucket: values.cloudBucket || '',
      modelConfigured: Boolean(values.modelApiKey),
      cloudAccountConfigured: Boolean(values.cloudAccessKey && values.cloudSecretKey),
      configurationSources: sources,
      configurationOwner: 'studio-node',
    };
  }
  function update(patch) {
    if (!record(patch) || Object.keys(patch).some(key => !Object.hasOwn(FIELDS, key))) {
      return Promise.reject(new ConfigurationError('存在不支持的配置字段'));
    }
    if (Object.values(patch).some(value => typeof value !== 'string')) {
      return Promise.reject(new ConfigurationError('配置值必须为文本'));
    }
    const write = async () => {
      const document = await readDocument(path);
      document.settings = record(document.settings) ? document.settings : {};
      document.secrets = record(document.secrets) ? document.secrets : {};
      for (const [field, value] of Object.entries(patch)) {
        if (SECRET_FIELDS.has(field)) {
          if (value.trim()) document.secrets[FIELDS[field][0]] = value.trim();
        } else document.settings[field] = value.trim();
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
