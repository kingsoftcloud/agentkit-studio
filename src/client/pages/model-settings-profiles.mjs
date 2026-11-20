import { normalizeModelEndpoint } from '../../model-endpoint.mjs';
import { headerEntryProblem, modelRuntimeOptions, requestHeaders } from '../../model-profile-contract.mjs';
import { modelReasoningConfig } from '../../model-reasoning.mjs';
import { modelCredentialName, modelProfileId } from '../dsh/model-bridge.mjs';

export const profileKey = (profile, index) => String(profile?.id || profile?.credentialName || index || 'default');

let headerRowSequence = 0;
export const headerRowId = () => `ms-header-${++headerRowSequence}`;

/*
 * `profile.headers` 在存储里是普通对象，在编辑区是有序的键值行。两种形状都
 * 能渲染，所以草稿、撤销、重新读取都不会让编辑器丢掉行；行 id 只用于列表 key。
 */
export const headerRows = value => Array.isArray(value) ? value
  : value && typeof value === 'object'
    ? Object.entries(value).map(([name, item]) => ({ id: `ms-header:${name}`, name, value: String(item ?? '') }))
    : [];

/**
 * 行 → 存储里的普通对象；空行与无法表示的行在保存时被丢弃。请求头名称大小写
 * 不敏感，重复名称只保留最后一条，避免把两个「同名」请求头发给网关。
 */
export const headerRecord = rows => {
  const record = {};
  const entries = requestHeaders(Object.fromEntries(headerRows(rows)
    .map(row => [String(row?.name ?? '').trim(), String(row?.value ?? '')])));
  for (const [name, value] of Object.entries(entries)) {
    const duplicate = Object.keys(record).find(key => key.toLowerCase() === name.toLowerCase());
    if (duplicate) delete record[duplicate];
    record[name] = value;
  }
  return Object.keys(record).length ? record : undefined;
};

/** 当前行为什么还不能原样保存（'' 表示可以）；只报告名称，不回显值。 */
export const headerRowProblem = rows => {
  const seen = new Set();
  for (const row of headerRows(rows)) {
    const name = String(row?.name ?? '').trim(), value = String(row?.value ?? '');
    if (!name && !value) continue;
    if (!name || !value) return '请求头名称和值都需要填写，空行在保存时会被丢弃';
    const problem = headerEntryProblem(name, value);
    if (problem) return problem;
    if (seen.has(name.toLowerCase())) return `请求头「${name}」重复，保存时只保留最后一条`;
    seen.add(name.toLowerCase());
  }
  return '';
};

/** JSON with recursively sorted object keys, so a field-order change never reads as an edit. */
export const stableString = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
  : item);

export function normalizedConnectionAddress(profile) {
  try { return normalizeModelEndpoint(profile.baseUrl, profile.provider); }
  catch { return ''; }
}

// The Host can share a catalog only when endpoint and authentication agree.
// Use the first profile's ID for UI keys so request header values stay in memory.
export function connectionIdentity(profile) {
  const headers = Object.entries(headerRecord(profile.headers) || {})
    .map(([name, value]) => [name.toLowerCase(), value]);
  return stableString({
    provider: profile.provider, address: normalizedConnectionAddress(profile) || profile.baseUrl,
    credential: profile.credentialName, headers: Object.fromEntries(headers),
  });
}

export function connectionRecord(item, id = item.id) {
  return {
    id, provider: item.provider, baseUrl: item.baseUrl, credentialName: item.credentialName,
    connectionName: item.connectionName || '', headers: headerRecord(item.headers),
    apiKey: item.apiKey || '', credentialConfigured: Boolean(item.credentialConfigured),
  };
}

const connectionLocation = item => [item.provider, normalizedConnectionAddress(item) || item.baseUrl, item.credentialName];

export function modelConnections(profiles, records = []) {
  const groups = new Map();
  const byIdentity = new Map();
  const register = (item, id) => {
    const group = { id, provider: item.provider, address: normalizedConnectionAddress(item), connection: connectionRecord(item, id), models: [] };
    groups.set(id, group);
    byIdentity.set(connectionIdentity(item), group);
    return group;
  };
  for (const record of records) register(record, record.id);
  for (const [index, profile] of profiles.entries()) {
    const identity = connectionIdentity(profile);
    let group = groups.get(profile.connectionId);
    if (!group || stableString(connectionLocation(group.connection)) !== stableString(connectionLocation(profile))) group = byIdentity.get(identity);
    if (!group) {
      let id = profileKey(profile, index);
      while (groups.has(id)) id += '-provider';
      group = register(profile, id);
    }
    group.models.push({ profile, index });
  }
  const locations = new Map();
  for (const group of groups.values()) {
    group.name = group.connection.connectionName.trim()
      || group.models.find(({ profile }) => profile.connectionName?.trim())?.profile.connectionName.trim() || '';
    group.connection.connectionName = group.name;
    const location = JSON.stringify([group.provider, group.address]);
    if (!locations.has(location)) locations.set(location, []);
    locations.get(location).push(group);
  }
  for (const siblings of locations.values()) {
    siblings.forEach((group, index) => {
      const ambiguous = siblings.some(other => other !== group && other.name === group.name);
      group.label = ambiguous ? [group.name, `连接 ${index + 1}`].filter(Boolean).join(' · ') : group.name;
    });
  }
  return [...groups.values()];
}

export function connectionSource(group) {
  return group.connection;
}

export function clearModelEffortRange(profile) {
  return Array.isArray(profile?.reasoningLevels)
    ? { reasoningLevels: undefined, reasoningEfforts: undefined, defaultReasoningEffort: undefined } : {};
}

export const BUDGET_KEYS = ['maxOutputTokens', 'contextWindow', 'requestTimeoutMs'];
const budgetInteger = value => {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('最大输出 Token、上下文窗口与请求超时必须为大于 0 的整数');
  return number;
};

export const budgetDraft = value => { try { return budgetInteger(value); } catch { return String(value ?? ''); } };

export function modelProfilePayload(profile, index) {
  const options = modelRuntimeOptions(profile);
  for (const key of BUDGET_KEYS) {
    const value = budgetInteger(options[key]);
    if (value === undefined) delete options[key]; else options[key] = value;
  }
  delete options.headers;
  const headers = headerRecord(profile.headers);
  return {
    ...options, ...(headers ? { headers } : {}),
    ...(typeof profile.displayName === 'string' ? { displayName: profile.displayName } : {}),
    ...(profile.connectionName?.trim() ? { connectionName: profile.connectionName.trim() } : {}),
    ...(profile.connectionId ? { connectionId: profile.connectionId } : {}),
    ...(profile.modelOnly === true ? { modelOnly: true } : {}),
    id: modelProfileId(profile, index), provider: profile.provider.trim() || 'ksyun', modelName: profile.modelName.trim(),
    baseUrl: normalizeModelEndpoint(profile.baseUrl, profile.provider), credentialName: modelCredentialName(profile, index),
    enabled: profile.enabled !== false, default: profile.default === true, codexApi: profile.codexApi || 'responses',
    input: profile.input || ['text'],
    ...modelReasoningConfig(profile),
  };
}
