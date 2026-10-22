/** Frozen Host configuration and SDK/lifecycle composition for E2B commands.
 * Credentials stay in closures. Only binding facts enter a Build or receipt;
 * transportOptions is a trusted supervisor-construction port, never a tool.
 */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant, scopeKey } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeE2BSandboxOwner } from '../../packages/agentkit-harness/src/native/e2b-sandbox-owner.mjs';
import { createNativeE2BSdkLifecycle, createNativeE2BSdkTransport, NATIVE_E2B_SDK_TRANSPORT } from './native-e2b-sdk-transport.mjs';

export const STUDIO_NATIVE_E2B_HOST = 'agentkit.studio-native-e2b-host/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const nonempty = value => typeof value === 'string' && !!value.trim();
const types = new Map([['', 'aio'], ['aio', 'aio'], ['allinone', 'aio'], ['code', 'code'],
  ['codeinterpreter', 'code'], ['codesandbox', 'code'], ['browser', 'browser'],
  ['browsersandbox', 'browser'], ['private', 'private'], ['custom', 'private']]);

/** Studio keeps its existing local workspace default. An explicit KsADK E2B
 * selection must never silently fall back to local process execution. */
export function nativeCommandBackend(env = {}) {
  const raw = env.KSADK_SANDBOX_BACKEND;
  invariant(raw == null || typeof raw === 'string', 'studio_native_sandbox_backend_invalid');
  const selected = raw?.trim().toLowerCase() || 'local_process';
  if (selected === 'local' || selected === 'local_process') return 'local_process';
  invariant(selected === 'e2b', 'studio_native_sandbox_backend_unsupported');
  return 'e2b';
}

function configuration(env, sandboxEnvironment) {
  invariant(nativeCommandBackend(env) === 'e2b', 'studio_native_e2b_not_selected');
  const template = env.KSADK_SANDBOX_TEMPLATE_ID || env.KSADK_SKILL_RUNTIME_TEMPLATE_ID;
  invariant(nonempty(template) && template.trim().length <= 256, 'studio_native_e2b_template_required');
  const rawTimeout = env.KSADK_SANDBOX_TIMEOUT || env.KSADK_SKILL_RUNTIME_TIMEOUT || '900';
  invariant(typeof rawTimeout === 'string' && /^[0-9]+$/u.test(rawTimeout.trim()), 'studio_native_e2b_timeout_invalid');
  const timeoutSeconds = Number(rawTimeout.trim());
  invariant(Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 86400, 'studio_native_e2b_timeout_invalid');
  const bool = raw => {
    invariant(raw == null || typeof raw === 'string', 'studio_native_e2b_internet_policy_invalid');
    return raw == null || ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  };
  const allowInternetAccess = bool(env.KSADK_SANDBOX_ALLOW_INTERNET_ACCESS ?? env.KSADK_SKILL_RUNTIME_ALLOW_INTERNET_ACCESS);
  const rawType = env.KSADK_SANDBOX_TYPE ?? 'aio';
  invariant(typeof rawType === 'string', 'studio_native_e2b_type_invalid');
  const sandboxType = types.get(rawType.trim().toLowerCase().replace(/[_\- ]/gu, ''));
  invariant(sandboxType, 'studio_native_e2b_type_invalid');
  const source = env.KSADK_TRAFFIC_SOURCE ?? '';
  invariant(typeof source === 'string' && !/[^\x20-\x7e]/u.test(source), 'studio_native_e2b_traffic_source_invalid');
  invariant(sandboxEnvironment && typeof sandboxEnvironment === 'object' && !Array.isArray(sandboxEnvironment)
    && Object.values(sandboxEnvironment).every(value => typeof value === 'string'), 'studio_native_e2b_environment_invalid');
  // SDK connection validation is shared with the production transport. There
  // is no endpoint probe, ambient SDK default, or managed-cluster URL rewrite.
  return { connection: { apiUrl: env.E2B_API_URL, domain: env.E2B_DOMAIN, apiKey: env.E2B_API_KEY,
    headers: { 'X-Traffic-Source': source.trim() || 'agentkit' } },
    template: template.trim(), timeoutSeconds, allowInternetAccess, sandboxType, env: copy(sandboxEnvironment) };
}

export async function createNativeE2BHostBinding({ env, scope, sessionId, workspaceRoot, stateRoot,
  assertAuthority, assertReconciliationAuthority = null, sandboxEnvironment = {}, loadSdk } = {}) {
  scopeKey(scope);
  invariant(nonempty(sessionId) && typeof assertAuthority === 'function', 'studio_native_e2b_host_authority_required');
  invariant(assertReconciliationAuthority === null || typeof assertReconciliationAuthority === 'function',
    'studio_native_e2b_reconciliation_authority_invalid');
  // Capture all settings before importing the SDK; the source object can be
  // changed by another Host operation while the asynchronous import is pending.
  const fixedScope = copy(scope), fixed = configuration(env ?? {}, sandboxEnvironment);
  const options = { connection: fixed.connection, ...(loadSdk ? { loadSdk } : {}) };
  const lifecycle = await createNativeE2BSdkLifecycle({ ...options, template: fixed.template,
    timeoutSeconds: fixed.timeoutSeconds, allowInternetAccess: fixed.allowInternetAccess, env: fixed.env });
  const bindingDigest = hash({ contract: STUDIO_NATIVE_E2B_HOST, lifecycle: lifecycle.bindingDigest,
    sandboxType: fixed.sandboxType, scope: fixedScope, sessionId });
  const owner = createNativeE2BSandboxOwner({ stateRoot, workspaceRoot, scope: fixedScope, sessionId, bindingDigest,
    assertAuthority, assertReconciliationAuthority, inspectSandbox: lifecycle.inspectSandbox,
    createSandbox: input => lifecycle.createSandbox({ ...input,
      metadata: { ...input.metadata, runtime: 'agentkit', sandbox_type: fixed.sandboxType, session_id: sessionId } }),
    killSandbox: lifecycle.killSandbox });
  const binding = Object.freeze({ contract: STUDIO_NATIVE_E2B_HOST, backend: 'e2b', bindingDigest,
    transportContract: NATIVE_E2B_SDK_TRANSPORT, template: fixed.template, sandboxType: fixed.sandboxType,
    timeoutSeconds: fixed.timeoutSeconds, allowInternetAccess: fixed.allowInternetAccess });
  // Options are returned only when the trusted Host constructs a supervisor.
  // They are freshly copied; mutating one cannot retarget another transport.
  const transportOptions = () => ({ connection: copy(fixed.connection) });
  return Object.freeze({ binding, owner, transportOptions,
    createTransport: () => createNativeE2BSdkTransport({ ...transportOptions(), ...(loadSdk ? { loadSdk } : {}) }) });
}
