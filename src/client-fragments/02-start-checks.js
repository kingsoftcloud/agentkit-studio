    // This is a configuration check, not a model call or a runtime smoke test.
    // Only retain public status fields; Host settings and credential values
    // never become renderer state or diagnostic output.
    async function readStartChecks(remote, { timeoutMs = 8000 } = {}) {
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

    function StartChecks() {
      const [state, setState] = useState({ phase: 'idle', rows: [], checkedAt: '' });
      const lifetime = useRef({ active: true, revision: 0 });
      const refresh = async () => {
        const revision = ++lifetime.current.revision;
        setState({ phase: 'checking', rows: [], checkedAt: '' });
        const rows = await readStartChecks(hostRemote);
        if (!lifetime.current.active || revision !== lifetime.current.revision) return;
        setState({ phase: 'done', rows, checkedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      };
      useEffect(() => {
        lifetime.current.active = true;
        void refresh();
        const changed = () => { void refresh(); };
        window.addEventListener('agentkit-studio:model-credential-changed', changed);
        window.addEventListener('agentkit-studio:credential-recheck', changed);
        return () => {
          lifetime.current.active = false; lifetime.current.revision += 1;
          window.removeEventListener('agentkit-studio:model-credential-changed', changed);
          window.removeEventListener('agentkit-studio:credential-recheck', changed);
        };
      }, []);
      return h('section', { className: 'agentkit-start-checks', 'aria-label': '开始前检查', 'aria-busy': state.phase === 'checking' },
        h('div', { className: 'agentkit-form-heading' },
          h('div', null, h('h3', null, '开始前检查'), h('p', null, '查看当前配置，确认下一步。')),
          h('button', { type: 'button', onClick: refresh, disabled: state.phase === 'checking', style: buttonStyle() }, state.phase === 'checking' ? '检查中…' : '重新检查')),
        h('div', { role: 'status', 'aria-live': 'polite' }, state.phase === 'checking' ? h('p', { className: 'agentkit-form-note' }, '正在读取 Host、凭证和运行目标…') :
          state.rows.map(row => h('div', { key: row.id, className: 'agentkit-check-row', 'data-check-state': row.status },
            h('div', null, h('div', { className: 'agentkit-check-label' }, row.label), h('div', { className: 'agentkit-form-note' }, row.detail)),
            h('div', { className: 'agentkit-check-actions' }, h('span', { className: 'agentkit-check-state' }, { confirmed: '已确认', missing: '缺少配置', unknown: '未知' }[row.status]),
              row.action === 'credentials' ? h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:credential-onboarding')), style: buttonStyle() }, '配置模型') : null)))),
        h('p', { className: 'agentkit-form-note' }, '目录登记和凭证配置不代表工具执行或模型调用已通过验证。', state.checkedAt ? ` 检查于 ${state.checkedAt}` : ''));
    }
