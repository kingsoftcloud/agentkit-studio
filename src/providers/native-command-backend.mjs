const backendError = code => Object.assign(new Error(code), { code });

/** Studio keeps its existing local workspace default. An explicit KsADK E2B
 * selection must never silently fall back to local process execution. */
export function nativeCommandBackend(env = {}) {
  const raw = env.KSADK_SANDBOX_BACKEND;
  if (raw != null && typeof raw !== 'string') throw backendError('studio_native_sandbox_backend_invalid');
  const selected = raw?.trim().toLowerCase() || 'local_process';
  if (selected === 'local' || selected === 'local_process') return 'local_process';
  if (selected !== 'e2b') throw backendError('studio_native_sandbox_backend_unsupported');
  return 'e2b';
}
