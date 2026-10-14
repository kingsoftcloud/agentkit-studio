/** Commands belong to one mounted Studio; nested DSH capabilities may rebind. */
export function createStudioActions({ confirm }) {
  let current = null;
  let closed = false;
  return {
    confirm: options => closed ? Promise.resolve(false) : confirm(options),
    bindAgent(...args) {
      if (closed) return Promise.resolve();
      return current ? current.run(...args) : confirm({ title: '会话服务尚未就绪', detail: '请连接 DSH 后重试。', confirmLabel: '知道了' });
    },
    registerBinding(run) {
      if (closed) return () => {};
      const owner = { run };
      current = owner;
      return () => { if (current === owner) current = null; };
    },
    dispose() { closed = true; current = null; },
  };
}
