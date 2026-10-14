import { ALLOWED_RUNTIME_TYPES, RUNTIME_LABELS } from '../theme.mjs';

export async function readStartChecks(remote, { timeoutMs = 8000 } = {}) {
  const bounded = async callback => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(callback),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('check timeout')), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const [host, credential, catalog] = await Promise.allSettled([
    bounded(() => remote.settings()), bounded(() => remote.modelCredentialStatus()), bounded(() => remote.runtimes()),
  ]);
  const credentialKnown = credential.status === 'fulfilled' && typeof credential.value?.configured === 'boolean';
  // The older RPC carrier supplies a default native entry with source=dsh;
  // that fallback is not a response from a runtime catalog.
  const catalogFallback = catalog.status === 'fulfilled' && catalog.value?.source === 'dsh';
  const catalogKnown = catalog.status === 'fulfilled' && Array.isArray(catalog.value?.items) && !catalogFallback;
  const runtimes = catalogKnown ? [...new Set(catalog.value.items.map(item => item?.runtimeType).filter(type => ALLOWED_RUNTIME_TYPES.includes(type)))] : [];
  return [
    { id: 'host', label: 'Host 连接', status: host.status === 'fulfilled' && host.value && typeof host.value === 'object' ? 'confirmed' : 'unknown', detail: host.status === 'fulfilled' && host.value && typeof host.value === 'object' ? '已读取当前 Host 配置' : '暂时无法读取，请连接 Host 后重新检查' },
    { id: 'credential', label: '模型凭证', status: credentialKnown ? credential.value.configured ? 'confirmed' : 'missing' : 'unknown', detail: credentialKnown ? credential.value.configured ? '已配置；模型请求仍以实际运行结果为准' : '先配置一个模型 API Key' : '暂时无法确认凭证状态', action: credentialKnown && !credential.value.configured ? 'credentials' : null },
    { id: 'runtime', label: '运行目标目录', status: catalogKnown ? runtimes.length ? 'confirmed' : 'missing' : 'unknown', detail: catalogKnown ? runtimes.length ? runtimes.map(type => RUNTIME_LABELS[type] || type).join('、') : 'Host 尚未登记支持的运行目标' : catalogFallback ? '当前连接未提供运行目标目录，请在 Agent 中查看实际运行结果' : '暂时无法读取运行目标目录' },
  ];
}
