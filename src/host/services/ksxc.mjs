import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KsxcRuntimeError, readKsxcCompanyConfig } from '../../providers/ksxc-command.mjs';
import { assertKsxcCatalogModel, createKsxcRuntime, createManagedKsxcCommand } from '../../providers/ksxc-runtime.mjs';
import { createKsxcAccounts } from './ksxc-accounts.mjs';
import { createKsxcGatewayStatus } from './ksxc-gateway.mjs';
import { createKsxcReleases } from './ksxc-releases.mjs';
import { createManagedKsxcConnectionClient } from './ksxc-connection-client.mjs';

const unavailable = () => new KsxcRuntimeError('KSXC_HOST_UNAVAILABLE', '当前 Studio Host 尚未配置 KSXC。');
// A standalone desktop Host and its credential store belong to one DSH profile.
export const KSXC_DESKTOP_USER = 'desktop-profile';

// A desktop launch inherits only launchd's environment, so no shell export can
// reach the Host. The company configuration therefore ships with the plugin.
const shippedCompanyConfig = fileURLToPath(new URL('./ksxc-company.json', import.meta.url));
const shippedOrigins = new Set(Object.values(JSON.parse(readFileSync(shippedCompanyConfig, 'utf8'))).flatMap(value => {
  try { return [new URL(value).origin]; } catch { return []; }
}));

export async function createKsxcHost({ storeDir, ksxcStoreDir = storeDir, env, credentials, managedRuntime, managedResourceContext, portableRuntime,
  defaultCompanyConfig = shippedCompanyConfig, gatewayFetchImpl = fetch }) {
  const managed = managedRuntime?.identity.runtimeName === 'ksxc';
  const desktop = !managedRuntime && !portableRuntime;
  // An explicit path always wins. Managed and portable Hosts must name their company.
  const configured = String(env.AGENTKIT_KSXC_COMPANY_CONFIG_PATH ?? '').trim();
  const companyConfigPath = configured || (desktop ? defaultCompanyConfig : '');
  const shipped = !configured && Boolean(companyConfigPath);
  if ((!managed && !desktop) || (!managed && !companyConfigPath)) return null;
  let companyConfig, gateway;
  try {
    companyConfig = await readKsxcCompanyConfig({ companyConfigPath });
    const api = new URL(companyConfig.baseUrl);
    gateway = new URL(env.AGENTKIT_KSXC_WPS_GATEWAY || api.origin);
    for (const url of [api, gateway]) {
      // The shipped gateway is HTTP-only; any other plain HTTP endpoint still needs the explicit opt-in.
      const plainHttp = (shipped && shippedOrigins.has(url.origin)) || env.AGENTKIT_KSXC_ALLOW_HTTP === '1';
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && plainHttp))
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw unavailable();
    }
  } catch {
    if (managed) throw unavailable();
    return null;
  }
  const releases = desktop ? createKsxcReleases({
    root: join(ksxcStoreDir, 'ksxc'), lock: env.AGENTKIT_KSXC_RELEASES_PATH, companyConfigPath,
  }) : undefined;
  const accounts = desktop ? createKsxcAccounts({ credentials, companyConfig, gateway }) : undefined;
  const gatewayStatus = desktop ? createKsxcGatewayStatus({ companyConfig, fetchImpl: gatewayFetchImpl }) : undefined;
  const command = managed ? createManagedKsxcCommand(env) : undefined;
  if (managed) await command.validate();
  const managedConnection = managed ? createManagedKsxcConnectionClient({ identity: managedRuntime.identity, companyConfig, env,
    stateRoot: join(ksxcStoreDir, 'ksxc', 'runtime'), getCallerPermit: managedResourceContext.ksxcPermit }) : undefined;
  const runtime = createKsxcRuntime({
    commandFor: managed ? () => command : releases.command,
    connectionFor: managed ? managedConnection : accounts.connection,
    companyConfig, companyConfigPath, stateRoot: join(ksxcStoreDir, 'ksxc', 'runtime'), env,
  });
  return {
    runtime, releases, accounts, managedConnection, gatewayStatus,
    async desktopModels(signal) {
      const entries = await runtime.listModels({ userId: KSXC_DESKTOP_USER, signal });
      return {
        items: entries.map(item => ({ resourceId: item.id, name: item.name, source: 'ksxc', provider: 'ksxc' })),
        ...(entries.length === 1 ? { defaultModel: entries[0].id } : {}),
      };
    },
  };
}

export function ksxcAgentPreference(spec = {}) {
  const bindings = spec.bindings || {};
  const model = bindings.modelProfileId;
  // KSXC saves a catalog identifier. Endpoints, keys and provider configuration
  // are not part of this Agent runtime's data contract.
  if (Object.keys(spec.runtime || {}).some(key => key !== 'type') || typeof model !== 'string'
    || !/^[^\s\x00-\x1f\x7f]{1,512}$/.test(model)
    || (bindings.modelProfileIds !== undefined && (!Array.isArray(bindings.modelProfileIds)
      || bindings.modelProfileIds.some(id => id !== model)))
    || ['provider', 'modelProvider', 'model', 'modelConfig', 'modelProfiles', 'endpoint', 'baseUrl', 'apiKey', 'credentialName']
      .some(key => spec[key] !== undefined || bindings[key] !== undefined)) {
    throw new KsxcRuntimeError('KSXC_MODEL_INVALID', '请选择当前 KSXC 企业账号的默认模型。');
  }
  return model;
}

export async function validateDesktopKsxcAgent(ksxc, record) {
  if (record.spec?.runtime?.type !== 'ksxc') return;
  const model = ksxcAgentPreference(record.spec);
  if (!ksxc?.accounts) throw unavailable();
  assertKsxcCatalogModel(await ksxc.runtime.listModels({ userId: KSXC_DESKTOP_USER }), model);
}
