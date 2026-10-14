import credentialOnboardingStyles from '../styles/credential-onboarding.css.mjs';
import { resolvePaletteStyles } from '../styles/palette.mjs';
import { leaseDocumentResource } from '../dsh/document-resource.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

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
    const [step, setStep] = useState(0);
    const [stage, setStage] = useState('welcome');
    const lifetime = useRef({ active: true, generation: 0, dismissed: false, completed: false });
    lifetime.current.stage = stage;
    const check = async ({ manual = false } = {}) => {
      const generation = ++lifetime.current.generation;
      setState(current => ({ ...current, status: 'loading', error: '' }));
      try {
        const result = await hostRemote.modelCredentialStatus();
        if (!lifetime.current.active || generation !== lifetime.current.generation) return;
        const next = { status: 'ready', configured: result?.configured === true };
        setState(next);
        if (next.configured && !explicit && !manual && lifetime.current.stage === 'welcome') {
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
    if (!open) return null;
    const close = () => { lifetime.current.dismissed = true; setOpen(false); complete(); };
    const configure = () => setStage('model');
    const loading = state.status === 'loading';
    const actions = stage === 'welcome' ? h('div', { className: 'agentkit-onboarding-actions', 'data-studio-controls': true },
      h('button', { type: 'button', disabled: loading, 'data-modal-autofocus': true, className: 'agentkit-onboarding-primary', onClick: configure, style: { ...buttonStyle(), height: '44px', color: BRAND.primaryText, background: BRAND.primaryFill } }, loading ? '检查中…' : state.configured ? '更换模型' : '开始设置'),
      h('button', { type: 'button', onClick: close, className: 'agentkit-onboarding-secondary' }, state.configured ? '开始对话' : '稍后设置'),
      h('button', { type: 'button', disabled: loading, onClick: () => check({ manual: true }), className: 'agentkit-onboarding-secondary' }, state.status === 'error' ? '重试' : '重新检查')) : h('div', { className: 'agentkit-onboarding-actions', 'data-studio-controls': true },
      stage === 'cloud' ? h('button', { type: 'button', 'data-modal-autofocus': true, onClick: close, className: 'agentkit-onboarding-primary', style: { ...buttonStyle(), height: '44px', color: BRAND.primaryText, background: BRAND.primaryFill } }, '跳过，开始对话') : null,
      h('button', { type: 'button', onClick: () => setStage(stage === 'cloud' ? 'model' : 'welcome'), className: 'agentkit-onboarding-secondary' }, '上一步'),
      h('button', { type: 'button', onClick: close, className: 'agentkit-onboarding-secondary' }, '稍后设置'),
      h('button', { type: 'button', onClick: () => { close(); openSection('agentkit-models'); }, className: 'agentkit-onboarding-secondary' }, '打开完整设置'));
    const labels = ['选择提供商', '填写凭证', '开始对话'];
    const descriptions = ['选择已有提供商，或填写自己的兼容服务地址。', '填写 API Key 并选择模型。保存时会读取模型目录。', '保存配置后关闭设置，回到新会话即可开始。'];
    return h(Modal, {
      open, onClose: close, headless: true, className: 'agentkit-onboarding-dialog', title: state.configured ? '模型凭证已就绪' : '欢迎使用 AgentKit Studio', footer: actions,
    }, h('div', { className: 'agentkit-credential-onboarding-content', 'data-studio-onboarding-stage': stage },
      h('section', { className: 'agentkit-onboarding-copy' },
        h('div', { className: 'agentkit-onboarding-brand' }, h(StudioMark, { size: 32, title: '' }), h('span', null, 'AgentKit Studio')),
        h('h1', null, stage === 'model' ? '连接你的模型' : stage === 'cloud' ? '云端配置，可以跳过' : state.configured ? '可以开始对话了' : '让第一个 Agent 跑起来'),
        h('p', { className: 'agentkit-onboarding-intro' }, stage === 'cloud' ? '本机对话已经可以使用。需要云端构建、部署和资源访问时，再填写云端凭证即可。' : '连接一个模型，即可在本机开始对话。API Key 保存在本机，云端部署可稍后配置。'),
        h('p', { className: 'agentkit-onboarding-status', role: state.status === 'error' ? 'alert' : 'status', style: state.status === 'error' ? { color: BRAND.danger } : undefined }, state.status === 'error' ? state.error : loading ? '正在检查本机模型配置…' : state.configured ? '已检测到可用模型凭证。' : '尚未配置模型凭证。'), actions),
      stage !== 'welcome' ? h('section', { className: 'agentkit-onboarding-form', 'aria-label': stage === 'model' ? '连接模型' : '云端配置（可选）' }, h(ModelSettingsSection, { key: stage, dshModel, mode: stage, onSaved: stage === 'model' ? () => setStage('cloud') : close })) : h('section', { className: 'agentkit-credential-guide', 'aria-label': '模型配置操作演示' },
        h('ol', null, ...labels.map((label, index) => h('li', { key: label }, h('button', { type: 'button', className: 'agentkit-guide-step', 'aria-current': step === index ? 'step' : undefined, onClick: () => setStep(index) }, h('span', { className: 'agentkit-guide-number', 'aria-hidden': true }, index + 1), label)))),
        h('div', { className: 'agentkit-guide-preview', 'aria-label': '模型配置预览' },
          h('div', { className: 'agentkit-guide-preview-header' }, h(StudioMark, { size: 24, title: '' }), '模型与凭证'),
          h('label', null, '提供商'), h('div', { className: 'agentkit-guide-field', 'data-active': step === 0 }, '金山云模型服务', h('span', { 'aria-hidden': true }, '⌄')),
          h('label', null, 'API Key'), h('div', { className: 'agentkit-guide-field', 'data-active': step === 1 }, step === 0 ? '填写你的 API Key' : '••••••••••••••••'),
          h('label', null, '模型'), h('div', { className: 'agentkit-guide-field', 'data-active': step === 2 }, step === 2 ? '从模型目录选择' : '保存时自动读取')),
        h('p', { className: 'agentkit-guide-caption', role: 'status' }, descriptions[step]),
        h('button', { type: 'button', className: 'agentkit-guide-next', onClick: () => setStep((step + 1) % labels.length) }, step === 2 ? '重新查看步骤' : '查看下一步 →'))));
  }
  return { ensureCredentialOnboardingStyles, CredentialOnboarding };
}
