import { modelCredentialName } from '../dsh/model-bridge.mjs';
import { importedModelReasoning } from '../../model-catalog-reasoning.mjs';
import { clearModelEffortRange, connectionRecord, headerRecord, modelConnections, normalizedConnectionAddress, stableString } from './model-settings-profiles.mjs';

const providerDrafts = new Map();
const same = (left, right) => stableString(left) === stableString(right);

export function clearProviderDrafts() { providerDrafts.clear(); }
export function providerDraftCount() { return providerDrafts.size; }

export function restoreProviders(saved) {
  const staged = new Map(saved.map(item => [item.id, item]));
  for (const [id, record] of providerDrafts) {
    if (record) staged.set(id, record);
    else staged.delete(id);
  }
  return [...staged.values()];
}

export function rememberProviders(providers, saved) {
  const previous = new Map(saved.map(item => [item.id, item]));
  providerDrafts.clear();
  for (const item of providers) {
    if (!same(item, previous.get(item.id))) providerDrafts.set(item.id, item);
    previous.delete(item.id);
  }
  for (const id of previous.keys()) providerDrafts.set(id, null);
}

/** Migrate inferred providers in memory while keeping their original model IDs. */
export function bindProviders(profiles, groups) {
  const ids = new Map(groups.flatMap(group => group.models.map(({ index }) => [index, group.id])));
  return profiles.map((profile, index) => ({ ...profile, connectionId: ids.get(index) }));
}

export function providerMetadata(record) {
  const baseUrl = normalizedConnectionAddress(record);
  if (!baseUrl) return null;
  const headers = headerRecord(record.headers);
  return {
    id: record.id, provider: record.provider, baseUrl, credentialName: record.credentialName,
    ...(record.connectionName?.trim() ? { connectionName: record.connectionName.trim() } : {}),
    ...(headers ? { headers } : {}),
  };
}

export function updateProvider({ input, existing, providers, profiles, makeId }) {
  const moved = existing && (existing.provider !== input.provider || normalizedConnectionAddress(existing) !== input.baseUrl);
  const id = existing?.id || input.draftId || makeId();
  const credentialName = existing && !moved ? existing.credentialName : modelCredentialName({ id: moved ? makeId() : id });
  // A rotated credential is shared wherever the same reference is used.
  const apiKey = input.apiKey.trim() || (moved ? '' : existing?.apiKey || '');
  const record = connectionRecord({
    ...existing, ...input, id, credentialName, apiKey,
    credentialConfigured: Boolean(existing?.credentialConfigured && !moved),
  });
  const nextProviders = providers.map(item => {
    if (item.id === id) return record;
    return apiKey && item.credentialName === credentialName ? { ...item, apiKey } : item;
  });
  if (!existing) nextProviders.push(record);
  const nextProfiles = profiles.map(profile => {
    if (profile.connectionId !== id) return apiKey && profile.credentialName === credentialName ? { ...profile, apiKey } : profile;
    return {
      ...profile, provider: record.provider, baseUrl: record.baseUrl, credentialName, apiKey, credentialConfigured: record.credentialConfigured,
      connectionName: record.connectionName, ...(moved ? { input: undefined, inputCapability: 'pending', ...clearModelEffortRange(profile) } : {}),
    };
  });
  return { id, providers: nextProviders, profiles: nextProfiles };
}

export function keepDefaultModel(profiles) {
  const enabled = profiles.filter(profile => profile.enabled !== false);
  if (!enabled.length) return null;
  const fallback = enabled.find(profile => profile.default) || enabled[0];
  return profiles.map(profile => profile.default === (profile.id === fallback.id) ? profile : { ...profile, default: profile.id === fallback.id });
}

export function importedProfiles(connections, picks, makeId) {
  const profiles = [];
  for (const group of connections) {
    const items = picks.get(group.id);
    if (!items?.size) continue;
    const source = group.connection;
    const existing = new Set(group.models.map(({ profile }) => profile.modelName.trim()));
    for (const item of items.values()) {
      if (existing.has(item.id)) continue;
      profiles.push({
        id: makeId(item), provider: source.provider, baseUrl: group.address, credentialName: source.credentialName,
        connectionId: group.id, apiKey: source.apiKey || '', connectionName: source.connectionName,
        ...(source.headers ? { headers: source.headers } : {}),
        modelName: item.id, input: item.input || ['text'], inputCapability: item.inputKnown === false ? 'unknown' : 'catalog',
        ...importedModelReasoning(item, source),
        modelOnly: true, enabled: true, default: false,
      });
      existing.add(item.id);
    }
  }
  return profiles;
}

/** Resolve the wire for newly imported models without changing existing profiles. */
export async function checkImportedWires(profiles, probe) {
  const results = await Promise.all(modelConnections(profiles).map(async ({ models }) => {
    const list = models.map(({ profile }) => profile);
    let items;
    try { items = (await probe(list[0], list.map(profile => profile.modelName.trim())))?.items; }
    catch { /* Retain the preferred wire if the connection check could not finish. */ }
    const wires = new Map((items || []).map(({ modelName, wire }) => [modelName, wire]));
    return list.map(profile => [profile.id, wires.get(profile.modelName.trim()) || 'unknown']);
  }));
  return new Map(results.flat());
}
