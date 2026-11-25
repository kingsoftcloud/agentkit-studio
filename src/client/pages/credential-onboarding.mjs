import credentialOnboardingStyles from '../styles/credential-onboarding.css.mjs';
import { resolvePaletteStyles } from '../styles/palette.mjs';
import { leaseDocumentResource } from '../dsh/document-resource.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

/** Set once the user finishes or dismisses the guide, so it is not auto-shown again. */
const ONBOARDING_DONE_KEY = 'agentkit-studio:onboarding-done';

export function createCredentialOnboarding({
  ui: { React: { createElement: h, useEffect, useRef, useState }, Modal, ModelSettingsSection, StudioMark, buttonStyle, BRAND = DEFAULT_BRAND },
  hostRemote, window = globalThis.window, document = globalThis.document
}) {
  function ensureCredentialOnboardingStyles() {
    if (!document?.head) return () => {};
    return leaseDocumentResource(document, 'agentkit-studio:onboarding', () => {
      if (document.getElementById('agentkit-credential-onboarding-motion')) return () => {};
      const style = document.createElement('style');
      style.id = 'agentkit-credential-onboarding-motion';
      style.textContent = resolvePaletteStyles(credentialOnboardingStyles, { ...BRAND, controlBorder: BRAND.controlBorder || BRAND.border });
      document.head.appendChild(style);
      return () => style.remove();
    });
  }

  function CredentialOnboarding({ explicit = false, complete = () => {}, openSection = () => {}, dshModel } = {}) {
    const [state, setState] = useState({ status: 'loading', configured: false });
    const [open, setOpen] = useState(false);
    const [stage, setStage] = useState('welcome');
    const lifetime = useRef({ active: true, generation: 0, dismissed: false, completed: false });
    lifetime.current.stage = stage;
    const check = async ({ manual = false } = {}) => {
      const generation = ++lifetime.current.generation;
      setState(current => ({ ...current, status: 'loading', error: '' }));
      const acknowledged = (() => { try { return window.localStorage?.getItem(ONBOARDING_DONE_KEY) === '1'; } catch { return false; } })();
      try {
        const result = await hostRemote.modelCredentialStatus();
        if (!lifetime.current.active || generation !== lifetime.current.generation) return;
        const next = { status: 'ready', configured: result?.configured === true };
        setState(next);
        // 已配置就不自动弹（首次就有、或刚在引导里配好都一样），只有手动打开才显示。
        // 未配置且用户没跳过才首次弹一次；跳过（有标记）后不再自动弹。
        if (next.configured && !explicit && !manual) {
          setOpen(false);
          if (!lifetime.current.completed) { lifetime.current.completed = true; complete(); }
        } else {
          setOpen(explicit || manual || (!next.configured && !acknowledged && !lifetime.current.dismissed));
        }
      } catch {
        if (!lifetime.current.active || generation !== lifetime.current.generation) return;
        // Host 未连接且用户没跳过才显示「正在连接」；连接就绪后由 credential-recheck 重试。
        setState({ status: 'error', configured: false, error: '正在连接 Studio Host，连接成功后继续…' });
        if (!lifetime.current.dismissed && (explicit || manual || !acknowledged)) setOpen(true);
      }
    };
    useEffect(() => {
      lifetime.current.active = true;
      const releaseStyles = ensureCredentialOnboardingStyles();
      void check();
      const refresh = () => { void check(); };
      window.addEventListener('agentkit-studio:model-credential-changed', refresh);
      window.addEventListener('agentkit-studio:credential-recheck', refresh);
      return () => {
        releaseStyles();
        lifetime.current.active = false; lifetime.current.generation += 1;
        window.removeEventListener('agentkit-studio:model-credential-changed', refresh);
        window.removeEventListener('agentkit-studio:credential-recheck', refresh);
      };
    }, []);
    // The welcome dialog is a full-screen modal that starts below the traffic
    // lights, so the blank macOS title band above it has no drag surface: DSH's
    // chrome drag rows and product-document's Studio strip both only exist for
    // mounted chrome pages, and the shell is not mounted yet on a first run.
    // Mount the same transparent strip while the dialog is open, and take it
    // away with the dialog.
    useEffect(() => {
      if (!open) return () => {};
      const doc = document;
      if (!doc?.body || doc.documentElement?.dataset?.platform !== 'darwin') return () => {};
      const strip = doc.createElement('div');
      strip.setAttribute('data-studio-onboarding-drag', 'true');
      strip.setAttribute('aria-hidden', 'true');
      strip.style.cssText = 'position:fixed;top:0;left:80px;right:0;height:var(--dsh-frame-chrome-top,40px);'
        + 'margin:0;padding:0;border:0;background:transparent;pointer-events:none;z-index:2147483000;'
        + '-webkit-app-region:drag;app-region:drag';
      doc.body.appendChild(strip);
      return () => strip.remove();
    }, [open]);
    if (!open) return null;
    const close = () => {
      lifetime.current.dismissed = true;
      setOpen(false);
      try { window.localStorage?.setItem(ONBOARDING_DONE_KEY, '1'); } catch { /* storage unavailable: only this run is affected */ }
      complete();
    };
    const loading = state.status === 'loading';
    // 未配置默认就是可填的简洁表单；已配置显示「可以开始对话了」，点更换模型才进表单。
    const showForm = stage === 'model' || !state.configured;
    const primary = { ...buttonStyle(), height: '44px', color: BRAND.primaryText, background: BRAND.primaryFill };
    const actions = h('div', { className: 'agentkit-onboarding-actions', 'data-studio-controls': true },
      state.status === 'error' ? h('button', { key: 'retry', type: 'button', onClick: () => check({ manual: true }), className: 'agentkit-onboarding-secondary' }, '重试') : null,
      showForm
        ? [
          state.configured ? h('button', { key: 'chat', type: 'button', onClick: close, className: 'agentkit-onboarding-primary', style: primary }, '开始对话') : null,
          h('button', { key: 'later', type: 'button', onClick: close, className: 'agentkit-onboarding-secondary' }, '稍后设置'),
          h('button', { key: 'full', type: 'button', onClick: () => { close(); openSection('agentkit-models'); }, className: 'agentkit-onboarding-secondary' }, '打开完整设置'),
        ]
        : [
          h('button', { key: 'chat', type: 'button', 'data-modal-autofocus': true, onClick: close, className: 'agentkit-onboarding-primary', style: primary }, '开始对话'),
          h('button', { key: 'change', type: 'button', onClick: () => setStage('model'), className: 'agentkit-onboarding-secondary' }, '更换模型'),
        ]);
    return h(Modal, {
      open, onClose: close, headless: true, className: 'agentkit-onboarding-dialog', title: showForm ? '连接你的模型' : '模型凭证已就绪', footer: actions,
    }, h('div', { className: 'agentkit-credential-onboarding-content', 'data-studio-onboarding-stage': stage },
      h('section', { className: 'agentkit-onboarding-copy' },
        h('div', { className: 'agentkit-onboarding-brand' }, h(StudioMark, { size: 32, title: '' }), h('span', null, 'AgentKit Studio')),
        h('h1', null, showForm ? '连接你的模型' : '可以开始对话了'),
        h('p', { className: 'agentkit-onboarding-intro' }, showForm ? '选一个提供商，粘贴 API Key，保存后即可开始对话。' : '已检测到可用模型凭证。'),
        state.status === 'error'
          ? h('p', { className: 'agentkit-onboarding-status', role: 'alert', style: { color: BRAND.danger } }, state.error)
          : loading ? h('p', { className: 'agentkit-onboarding-status', role: 'status' }, '正在检查本机模型配置…') : null,
        actions),
      showForm ? h('section', { className: 'agentkit-onboarding-form', 'aria-label': '连接模型' }, h(ModelSettingsSection, { key: 'quickstart', dshModel, mode: 'model', simple: true, onSaved: close })) : null));
  }
  return { ensureCredentialOnboardingStyles, CredentialOnboarding };
}
