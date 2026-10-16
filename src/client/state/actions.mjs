/** Commands belong to one mounted Studio; nested DSH capabilities may rebind. */
export function createStudioActions({ confirm }) {
  let current = null;
  let sessionOpener = null;
  let closed = false;
  return {
    confirm: options => closed ? Promise.resolve(false) : confirm(options),
    bindAgent(...args) {
      if (closed) return Promise.resolve();
      if (!current && args[0]?.throwOnError) return Promise.reject(new Error('会话服务尚未就绪，请连接 DSH 后重试。'));
      return current ? current.run(...args) : confirm({ title: '会话服务尚未就绪', detail: '请连接 DSH 后重试。', confirmLabel: '知道了' });
    },
    openSession(sessionId) { if (!closed && sessionOpener) return sessionOpener.run(sessionId); },
    registerSessionOpener(run) { const owner = { run }; sessionOpener = owner; return () => { if (sessionOpener === owner) sessionOpener = null; }; },
    registerBinding(run) {
      if (closed) return () => {};
      const owner = { run };
      current = owner;
      return () => { if (current === owner) current = null; };
    },
    dispose() { closed = true; current = null; sessionOpener = null; },
  };
}
