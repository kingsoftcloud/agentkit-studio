    function ensureCredentialOnboardingStyles() {
      if (typeof document === 'undefined' || document.getElementById('agentkit-credential-onboarding-motion')) return;
      const style = document.createElement('style');
      style.id = 'agentkit-credential-onboarding-motion';
      style.textContent = `
        @keyframes agentkitCredentialOnboardingIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .agentkit-onboarding-dialog { width: min(960px, 100%); max-height: 100%; padding: 0; overflow: auto; background: ${BRAND.surface}; }
        .agentkit-credential-onboarding-content { display: grid; grid-template-columns: 1fr 1fr; min-height: 480px; font-family: inherit; color: ${BRAND.ink}; animation: agentkitCredentialOnboardingIn 180ms ease-out both; }
        .agentkit-onboarding-copy { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: 48px; }
        .agentkit-onboarding-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; font-size: 14px; font-weight: 500; }
        .agentkit-onboarding-copy h1 { margin: 0; font-size: 28px; line-height: 1.5; font-weight: 500; letter-spacing: -.02em; }
        .agentkit-onboarding-intro { margin: 16px 0 0; font-size: 15px; line-height: 1.8; color: ${BRAND.inkMuted}; }
        .agentkit-onboarding-status { margin: 16px 0 0; font-size: 12px; line-height: 1.6; color: ${BRAND.inkMuted}; }
        .agentkit-onboarding-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 32px; width: 100%; }
        .agentkit-onboarding-actions .agentkit-onboarding-primary { width: 100%; height: 44px; border-radius: 12px; font-size: 14px; }
        .agentkit-onboarding-actions .agentkit-onboarding-secondary { border: 0; padding: 0; background: transparent; color: ${BRAND.inkMuted}; font-size: 12px; }
        .agentkit-credential-guide { display: flex; flex-direction: column; justify-content: center; gap: 24px; padding: 40px; background: ${BRAND.canvas}; border-left: .5px solid ${BRAND.border}; }
        .agentkit-credential-guide ol { display: flex; gap: 16px; list-style: none; padding: 0; margin: 0; }
        .agentkit-credential-guide li { flex: 1; }
        .agentkit-guide-step { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; width: 100%; padding: 0; border: 0; background: transparent; color: ${BRAND.inkMuted}; text-align: left; font: inherit; font-size: 12px; cursor: pointer; }
        .agentkit-guide-step[aria-current=step] { color: ${BRAND.ink}; }
        .agentkit-guide-number { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid ${BRAND.border}; border-radius: 50%; font-size: 12px; }
        .agentkit-guide-step[aria-current=step] .agentkit-guide-number { border-color: ${BRAND.primaryFill}; background: ${BRAND.primaryFill}; color: ${BRAND.primaryText}; }
        .agentkit-guide-preview { padding: 24px; border: .5px solid ${BRAND.border}; border-radius: 16px; background: ${BRAND.surface}; box-shadow: var(--dsw-elevation-subtle, 0 8px 24px rgb(0 0 0 / .04)); }
        .agentkit-guide-preview-header { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; margin-bottom: 24px; }
        .agentkit-guide-preview label { display: block; font-size: 12px; color: ${BRAND.inkMuted}; margin: 16px 0 8px; }
        .agentkit-guide-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; border: .5px solid ${BRAND.controlBorder || BRAND.border}; border-radius: 10px; padding: 0 12px; font-size: 13px; }
        .agentkit-guide-field[data-active=true] { border-color: #1858d6; outline: 2px solid light-dark(#edf3ff, #15243e); }
        .agentkit-guide-caption { margin: 0; color: ${BRAND.inkMuted}; font-size: 12px; line-height: 1.7; }
        .agentkit-guide-next { align-self: flex-start; color: ${BRAND.ink}; background: transparent; border: 0; padding: 0; font: inherit; font-size: 12px; cursor: pointer; }
        .agentkit-onboarding-dialog button:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #1858d6); outline-offset: 4px; }
        @media (max-width: 760px) { .agentkit-credential-onboarding-content { grid-template-columns: 1fr; min-height: 0; } .agentkit-onboarding-copy { padding: 28px; } .agentkit-onboarding-brand { margin-bottom: 20px; } .agentkit-onboarding-copy h1 { font-size: 24px; } .agentkit-credential-guide { padding: 28px; border-left: 0; border-top: .5px solid ${BRAND.border}; } }
        @media (prefers-reduced-motion: reduce) { .agentkit-credential-onboarding-content { animation: none; } }
      `;
      document.head?.appendChild(style);
    }

    /** Host readiness is redacted; DSH owns Settings, modal focus and completion. */
    function CredentialOnboarding({ explicit = false, complete = () => {}, openSection = () => {} } = {}) {
      const [state, setState] = useState({ status: 'loading', configured: false });
      const [open, setOpen] = useState(false);
      const [step, setStep] = useState(0);
      const lifetime = useRef({ active: true, generation: 0, dismissed: false, completed: false });
      const check = async ({ manual = false } = {}) => {
        const generation = ++lifetime.current.generation;
        setState(current => ({ ...current, status: 'loading', error: '' }));
        try {
          const result = await hostRemote.modelCredentialStatus();
          if (!lifetime.current.active || generation !== lifetime.current.generation) return;
          const next = { status: 'ready', configured: result?.configured === true };
          setState(next);
          if (next.configured && !explicit && !manual) {
            setOpen(false);
            if (!lifetime.current.completed) { lifetime.current.completed = true; complete(); }
          } else if (!lifetime.current.dismissed) setOpen(true);
        } catch {
          if (!lifetime.current.active || generation !== lifetime.current.generation) return;
          setState({ status: 'error', configured: false, error: '暂时无法读取凭证状态，请连接 Studio Host 后重试。' });
          if (explicit || manual) setOpen(true);
        }
      };
      useEffect(() => {
        lifetime.current.active = true;
        ensureCredentialOnboardingStyles();
        void check();
        const refresh = () => { void check(); };
        window.addEventListener('agentkit-studio:model-credential-changed', refresh);
        window.addEventListener('agentkit-studio:credential-recheck', refresh);
        return () => {
          lifetime.current.active = false; lifetime.current.generation += 1;
          window.removeEventListener('agentkit-studio:model-credential-changed', refresh);
          window.removeEventListener('agentkit-studio:credential-recheck', refresh);
        };
      }, []);
      if (!open) return null;
      const close = () => { lifetime.current.dismissed = true; setOpen(false); complete(); };
      const configure = () => { close(); openSection('agentkit-models'); };
      const loading = state.status === 'loading';
      const actions = h('div', { className: 'agentkit-onboarding-actions', 'data-studio-controls': true },
        h('button', { type: 'button', disabled: loading, 'data-modal-autofocus': true, className: 'agentkit-onboarding-primary', onClick: configure, style: { ...buttonStyle(), height: '44px', color: BRAND.primaryText, background: BRAND.primaryFill } }, loading ? '检查中…' : state.configured ? '更换模型' : '开始设置'),
        h('button', { type: 'button', onClick: close, className: 'agentkit-onboarding-secondary' }, state.configured ? '开始对话' : '稍后设置'),
        h('button', { type: 'button', disabled: loading, onClick: () => check({ manual: true }), className: 'agentkit-onboarding-secondary' }, state.status === 'error' ? '重试' : '重新检查'));
      const labels = ['选择提供商', '填写凭证', '开始对话'];
      const descriptions = ['选择已有提供商，或填写自己的兼容服务地址。', '填写 API Key 并选择模型。保存时会读取模型目录。', '保存配置后关闭设置，回到新会话即可开始。'];
      return h(Modal, {
        open, onClose: close, headless: true, className: 'agentkit-onboarding-dialog', title: state.configured ? '模型凭证已就绪' : '欢迎使用 AgentKit Studio', footer: actions,
      }, h('div', { className: 'agentkit-credential-onboarding-content' },
        h('section', { className: 'agentkit-onboarding-copy' },
          h('div', { className: 'agentkit-onboarding-brand' }, h(StudioMark, { size: 32, title: '' }), h('span', null, 'AgentKit Studio')),
          h('h1', null, state.configured ? '可以开始对话了' : '让第一个 Agent 跑起来'),
          h('p', { className: 'agentkit-onboarding-intro' }, '连接一个模型，即可在本机开始对话。API Key 保存在本机，云端部署可稍后配置。'),
          h('p', { className: 'agentkit-onboarding-status', role: state.status === 'error' ? 'alert' : 'status', style: state.status === 'error' ? { color: BRAND.danger } : undefined }, state.status === 'error' ? state.error : loading ? '正在检查本机模型配置…' : state.configured ? '已检测到可用模型凭证。' : '尚未配置模型凭证。'), actions),
        h('section', { className: 'agentkit-credential-guide', 'aria-label': '模型配置操作演示' },
          h('ol', null, ...labels.map((label, index) => h('li', { key: label }, h('button', { type: 'button', className: 'agentkit-guide-step', 'aria-current': step === index ? 'step' : undefined, onClick: () => setStep(index) }, h('span', { className: 'agentkit-guide-number', 'aria-hidden': true }, index + 1), label)))),
          h('div', { className: 'agentkit-guide-preview', 'aria-label': '模型配置预览' },
            h('div', { className: 'agentkit-guide-preview-header' }, h(StudioMark, { size: 24, title: '' }), '模型与凭证'),
            h('label', null, '提供商'), h('div', { className: 'agentkit-guide-field', 'data-active': step === 0 }, '金山云模型服务', h('span', { 'aria-hidden': true }, '⌄')),
            h('label', null, 'API Key'), h('div', { className: 'agentkit-guide-field', 'data-active': step === 1 }, step === 0 ? '填写你的 API Key' : '••••••••••••••••'),
            h('label', null, '模型'), h('div', { className: 'agentkit-guide-field', 'data-active': step === 2 }, step === 2 ? '从模型目录选择' : '保存时自动读取')),
          h('p', { className: 'agentkit-guide-caption', role: 'status' }, descriptions[step]),
          h('button', { type: 'button', className: 'agentkit-guide-next', onClick: () => setStep((step + 1) % labels.length) }, step === 2 ? '重新查看步骤' : '查看下一步 →'))));
    }
