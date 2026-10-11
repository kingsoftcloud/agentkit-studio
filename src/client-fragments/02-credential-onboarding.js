    const CREDENTIAL_ONBOARDING_SEEN = 'agentkit-studio:credential-onboarding-seen';

    function credentialGuideDismissed() {
      try { return Boolean(window.localStorage.getItem(CREDENTIAL_ONBOARDING_SEEN)); }
      catch { return false; }
    }

    /** Host readiness is redacted; DSH owns Settings and the modal layer. */
    function CredentialOnboarding() {
      const [state, setState] = useState({ status: 'loading', configured: false });
      const [open, setOpen] = useState(false);
      const lifetime = useRef({ active: true, generation: 0, dismissed: false });
      const check = async ({ manual = false } = {}) => {
        const generation = ++lifetime.current.generation;
        setState(current => ({ ...current, status: 'loading', error: '' }));
        try {
          const result = await hostRemote.modelCredentialStatus();
          if (!lifetime.current.active || generation !== lifetime.current.generation) return;
          const next = { status: 'ready', configured: result?.configured === true };
          setState(next);
          if (next.configured) setOpen(false);
          else if (!lifetime.current.dismissed && (manual || !credentialGuideDismissed())) setOpen(true);
        } catch {
          if (!lifetime.current.active || generation !== lifetime.current.generation) return;
          // A failed Host read is not proof of a missing credential.
          setState({ status: 'error', configured: false, error: '暂时无法读取凭证状态，请连接 Studio Host 后重试。' });
        }
      };
      useEffect(() => {
        lifetime.current.active = true;
        void check();
        const refresh = () => { void check(); };
        const openGuide = () => {
          lifetime.current.dismissed = false;
          setOpen(true);
          void check({ manual: true });
        };
        window.addEventListener('agentkit-studio:model-credential-changed', refresh);
        window.addEventListener('agentkit-studio:credential-recheck', refresh);
        window.addEventListener('agentkit-studio:credential-onboarding', openGuide);
        return () => {
          lifetime.current.active = false;
          lifetime.current.generation += 1;
          window.removeEventListener('agentkit-studio:model-credential-changed', refresh);
          window.removeEventListener('agentkit-studio:credential-recheck', refresh);
          window.removeEventListener('agentkit-studio:credential-onboarding', openGuide);
        };
      }, []);
      if (!open) return null;
      const close = (reason = 'later') => {
        lifetime.current.dismissed = true;
        setOpen(false);
        try { window.localStorage.setItem(CREDENTIAL_ONBOARDING_SEEN, reason); } catch { /* private mode */ }
      };
      const configure = () => {
        close('settings');
        window.dispatchEvent(new CustomEvent('agentkit-studio:open-settings'));
      };
      const loading = state.status === 'loading';
      const actions = h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', onClick: () => close(), style: buttonStyle() }, '稍后设置'),
        h('button', { type: 'button', onClick: () => close('skipped'), style: buttonStyle() }, '跳过本次'),
        h('button', { type: 'button', disabled: loading, onClick: () => check({ manual: true }), style: buttonStyle() }, state.status === 'error' ? '重试' : '重新检查'),
        h('button', { type: 'button', disabled: loading, 'data-modal-autofocus': true, onClick: configure, style: { ...buttonStyle(), color: 'var(--dsw-static-neutral-00, #fff)', background: BRAND.primaryFill } }, loading ? '检查中…' : '去配置模型凭证'));
      return h(Modal, {
        open, onClose: () => close(), title: '先完成模型凭证设置', closeLabel: '稍后设置',
        description: '配置一个模型 API Key，即可开始本机 Agent 对话。云端凭证可在需要部署时再设置。', footer: actions,
      }, state.status === 'error' ? h('p', { role: 'alert', style: { color: BRAND.danger } }, state.error) :
        h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, loading ? '正在读取本机 Host 的凭证状态…' : '当前未检测到模型凭证；保存配置后会自动重新检查。'));
    }
