    function ensureCredentialOnboardingStyles() {
      if (typeof document === 'undefined' || document.getElementById('agentkit-credential-onboarding-motion')) return;
      const style = document.createElement('style');
      style.id = 'agentkit-credential-onboarding-motion';
      style.textContent = `
        @keyframes agentkitCredentialOnboardingIn {
          from { opacity: 0; transform: translateY(8px) scale(.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes agentkitCredentialOnboardingPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, .12); transform: scale(1); }
          50% { box-shadow: 0 0 0 7px rgba(37, 99, 235, 0); transform: scale(1.04); }
        }
        .agentkit-credential-onboarding-content {
          animation: agentkitCredentialOnboardingIn 240ms cubic-bezier(.2,.8,.2,1) both;
        }
        .agentkit-credential-onboarding-mark {
          display: inline-flex; align-items: center; justify-content: center;
          width: 30px; height: 30px; margin-bottom: 10px; border-radius: 10px;
          color: var(--dsw-static-neutral-00, #fff); background: ${BRAND.primaryFill};
          animation: agentkitCredentialOnboardingPulse 1.8s ease-in-out 240ms 2 both;
        }
        @media (prefers-reduced-motion: reduce) {
          .agentkit-credential-onboarding-content, .agentkit-credential-onboarding-mark { animation: none; }
        }
      `;
      document.head?.appendChild(style);
    }

    /** Host readiness is redacted; DSH owns Settings and the modal layer. */
    function CredentialOnboarding({ explicit = false, complete = () => {}, openSection = () => {} } = {}) {
      const [state, setState] = useState({ status: 'loading', configured: false });
      const [open, setOpen] = useState(false);
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
            if (!lifetime.current.completed) {
              lifetime.current.completed = true;
              complete();
            }
          } else if (!lifetime.current.dismissed) setOpen(true);
        } catch {
          if (!lifetime.current.active || generation !== lifetime.current.generation) return;
          // A failed Host read is not proof of a missing credential.
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
          lifetime.current.active = false;
          lifetime.current.generation += 1;
          window.removeEventListener('agentkit-studio:model-credential-changed', refresh);
          window.removeEventListener('agentkit-studio:credential-recheck', refresh);
        };
      }, []);
      if (!open) return null;
      const close = (reason = 'later') => {
        lifetime.current.dismissed = true;
        setOpen(false);
        complete();
      };
      const configure = () => {
        close('settings');
        openSection('agentkit-models');
      };
      const loading = state.status === 'loading';
      const actions = h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', onClick: () => close(), style: buttonStyle() }, '稍后设置'),
        h('button', { type: 'button', onClick: () => close('skipped'), style: buttonStyle() }, '跳过本次'),
        h('button', { type: 'button', disabled: loading, onClick: () => check({ manual: true }), style: buttonStyle() }, state.status === 'error' ? '重试' : '重新检查'),
        h('button', { type: 'button', disabled: loading, 'data-modal-autofocus': true, onClick: configure, style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: BRAND.primaryFill } }, loading ? '检查中…' : '去配置模型凭证'));
      return h(Modal, {
        open, onClose: () => close(), title: state.configured ? '模型凭证已就绪' : '先完成模型凭证设置', closeLabel: '稍后设置',
        description: '配置一个模型 API Key，即可开始本机 Agent 对话。云端凭证可在需要部署时再设置。', footer: actions,
      }, h('div', { className: 'agentkit-credential-onboarding-content' },
        h('div', { className: 'agentkit-credential-onboarding-mark', 'aria-hidden': 'true' }, '✦'),
        state.status === 'error' ? h('p', { role: 'alert', style: { color: BRAND.danger } }, state.error) :
          h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, loading ? '正在读取本机 Host 的凭证状态…' : state.configured ? '已检测到可用凭证；可直接开始对话，也可以进入设置更换模型。' : '当前未检测到模型凭证；保存配置后会自动重新检查。')));
    }
