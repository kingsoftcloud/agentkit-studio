import { codexToolDefinition } from './codex-tool.mjs';
import { DEFAULT_KSYUN_BASE_URL, DEFAULT_KSYUN_MODEL, DSH_DEFAULT_MODEL_SETTINGS_NS, DSH_MODEL_CREDENTIAL, modelCredentialName } from './model-bridge.mjs';
import { createNativeSessionBinding } from './session-entry.mjs';
import { registerPanelNavigation } from './panel-navigation.mjs';
import { installProductCopy } from '../../product-copy.mjs';
import { AGENTKIT_STUDIO_BRAND as PRODUCT_BRAND } from '../../brand.js';

export function mountStudio(ctx, app) {
  const { ui, authoring, connectionOwner, hostRemote, actions, documentEffects, createDshModelBridge, writeConversationAgent, window, CustomEvent } = app;
  const { React, BRAND, PANELS, StudioMark, StudioWordmark, AgentContextSelector, CloudSessionStatus, CodexPluginMarketItem, CredentialOnboarding, ModelSettingsSection, StudioShell, StudioPanelIcon, StudioSettingsLauncher, StudioSettingsSection } = ui;
  const { createElement: h } = React;
  const { adoptProductDocumentTitle, adoptProductDocumentBrand, installResponsiveStyles, installStudioFormStyles } = documentEffects;
  const { openAgentAuthoring } = authoring;
  ctx.effect(() => () => app.dispose(), 'agentkit-studio:application-owner');
  ctx.inject(['locale'], copyCtx => {
    copyCtx.effect(() => installProductCopy(copyCtx.locale), 'agentkit-studio:product-copy');
  });

  ctx.effect(() => authoring.mount(), 'agentkit-studio:authoring-owner');
  ctx.uiConversation.events.register(codexToolDefinition);
  // Settings owns first-run coordination. Registering here makes the
  // guide visible in the real DSH onboarding path and gives the shell a
  // stable entry it can reopen after the user chose “later”.
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'agentkit-studio-credential', order: 20,
  }, props => h(CredentialOnboarding, { ...props, dshModel: createDshModelBridge(ctx) })));
  ctx.effect(() => connectionOwner.bind(ctx.connection), 'agentkit-studio:remote-connection');
  ctx.on('connection/reset', () => window.dispatchEvent(new CustomEvent('agentkit-studio:credential-recheck')));
  // DSH owns the single global plugin center. Studio contributes Codex as
  // an official plugin item through the public plugin-manager slot, so the
  // existing Codex catalog stays available without a second DSH market.
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'agentkit-codex-plugin-market', order: 90, label: 'Codex 插件',
  }, props => h(CodexPluginMarketItem, props)));
  ctx.effect(() => {
    const open = () => ctx.layout?.selectPanel?.('plugins');
    window.addEventListener('agentkit-studio:open-plugin-center', open);
    return () => window.removeEventListener('agentkit-studio:open-plugin-center', open);
  }, 'agentkit-studio:plugin-center-navigation');
  // Schedule is a capability, not a hard requirement for the fixed
  // dsh-v0.2.0-rc.2 host. Older profiles can still expose the Studio
  // product surface and all model/agent/resource surfaces while the automation
  // panel reports that its host service is unavailable.
  // `remote.schedule` is optional across pinned DSH hosts. Cordis proxies
  // reject reading an undeclared property, so keep the optional remote
  // behind the explicit host capability boundary instead of probing it.
  const scheduleRemote = null;
  const encodedAgentId = value => encodeURIComponent(String(value))
    .replace(/%/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180) || 'unknown';
  const presetIdForAgent = agent => {
    const id = String(agent?.metadata?.id || agent?.id || '').trim();
    const revision = Number(agent?.metadata?.revision || agent?.revision || 1) || 1;
    return id ? `agentkit-studio-agent-${encodedAgentId(id)}-r${revision}` : '';
  };
  // The official DSH preset picker calls the public agentPresets Remote
  // directly, so the Studio selector cannot be the only place that
  // applies an Agent's model and permission defaults. Observe the same
  // public selection event and project the Agent binding onto the blank
  // Session after DSH has accepted the preset.
  const applyNativeAgentDefaults = async (sessionId, selectedPreset) => {
    if (app.closed()) return;
    try {
      const roster = await hostRemote.agents();
      if (app.closed()) return;
      const presetId = String(selectedPreset || ctx.sessions?.list?.getSnapshot?.().byId?.[sessionId]?.projectionValues?.agentPreset || '');
      const agent = (roster?.items || []).find(item => presetIdForAgent(item) === presetId);
      if (!agent) return;
      const agentId = String(agent?.metadata?.id || agent?.id || '').trim();
      const admission = await hostRemote.ensureDshPreset(agentId);
      if (app.closed()) return;
      if (admission.modelSelection) {
        const selected = await ctx.remote.session.selectModel({ sessionId, ...admission.modelSelection, saveDefault: false });
        if (app.closed()) return;
        if (!selected?.ok) console.warn('[agentkit-studio] Agent model selection failed:', selected.error?.message || selected.error);
      }
      const permission = await ctx.remote?.commands?.execute?.(sessionId, '/permission read-only', []);
      if (permission && permission.ok === false) console.warn('[agentkit-studio] Agent permission default was not applied:', permission.error?.message || permission.error);
    } catch (error) {
      console.warn('[agentkit-studio] Native Agent session defaults unavailable:', error?.message || error);
    }
  };
  ctx.effect(() => {
    const unsubscribe = ctx.remote.$on?.('agent-preset/selected', (sessionId, selectedPreset) => { void applyNativeAgentDefaults(sessionId, selectedPreset); });
    return () => unsubscribe?.();
  }, 'agentkit-studio:native-agent-session-defaults');
  ctx.effect(() => adoptProductDocumentTitle(), 'agentkit-studio: document title');
  ctx.effect(() => adoptProductDocumentBrand(), 'agentkit-studio: document favicon');
  ctx.effect(() => installResponsiveStyles(), 'agentkit-studio: responsive layout');
  ctx.effect(() => installStudioFormStyles(), 'agentkit-studio: native forms');
  // The public launcher owns only the entry button. DSH retains settings
  // state, shortcuts and the original modal, including Studio's sections.
  ctx.slots.inject('settings.launcher', () => ctx.slots.register(
    { name: 'settings.launcher', locale: 'settings', priority: -20 }, StudioSettingsLauncher,
  ));
  // DSH owns the official composer and its native session.prompt path.
  // Studio does not inject a sink or bridge into InputHub. The authoring
  // tools registered by the Host let this native conversation create and
  // refine a reviewed Agent draft. A selected no-resource dsh-native
  // Agent is admitted through the public DSH preset Remote. Harness,
  // Codex and resource-bearing revisions add a preset-scoped provider
  // listener; the DSH Session, loop and renderer stay in charge.
  // Replace the official DSH brand row through its public slots. This
  // preserves the frame while giving the product its own identity.
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register(
    { name: 'sidebar.brand.mark' },
    ({ size }) => h('span', { style: { display: 'inline-flex', color: BRAND.accentStrong } }, h(StudioMark, { size: size || 24, title: '' })),
  ));
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
    { name: 'sidebar.brand.name' },
    () => h('span', { style: { color: BRAND.ink, fontSize: '13px', fontWeight: 600, letterSpacing: '-0.02em' } }, h(StudioWordmark)),
  ));
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
    { name: 'conversation.hero.brand.mark' },
    ({ size }) => h('span', { style: { display: 'inline-flex', color: BRAND.accentStrong } }, h(StudioMark, { size, title: '' })),
  ));
  ctx.slots.inject('conversation.hero.brand.name', () => ctx.slots.register(
    { name: 'conversation.hero.brand.name' },
    () => h(StudioWordmark),
  ));
  // Use the official session-maybe hero slot so the selector receives the
  // current sessionId/useSessions hooks. This keeps the binding scoped to
  // one blank conversation instead of leaking a global selection across
  // the workspace. DSH still owns session creation and locking.
  ctx.slots.inject('conversation.hero.agentPreset', () => ctx.slots.register(
    // A negative priority intentionally shadows the optional DSH preset
    // picker at this product entry point; the Host still owns the same
    // public registry and session lock semantics underneath.
    { name: 'conversation.hero.agentPreset', priority: -20 },
    props => h(AgentContextSelector, { ...props, studioRemote: ctx.remote, modelDirectories: ctx.modelDirectories }),
  ));
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
    { name: 'conversation.session.header.actions', id: 'agentkit-studio-cloud-status', order: -10 }, CloudSessionStatus,
  ));

  // Authoring entry: only the hero selector keeps the "创建 Agent" button.
  // The composer-left injection was removed — conversation authoring is a
  // fresh-session flow, and a composer button let users seed it mid-chat.

  // Each product domain is a first-class DSH main panel. The rows land in
  // the official panel list directly below New Session, using the product information architecture. Page-level resource tabs remain in
  // the content area; the four product domains never become a second row
  // of tabs inside their own detail page.
  const navigateStudio = target => {
    if (target === 'experts' || target === 'agents') {
      const view = target === 'experts' ? 'catalog' : 'mine';
      try { window.localStorage.setItem('agentkit-studio:agents-view', view); } catch {}
      window.dispatchEvent(new CustomEvent('agentkit-studio:agent-view', { detail: view }));
      target = 'agents';
    }
    const next = PANELS.find(item => item.page === target || item.id === target);
    if (next) ctx.layout.selectPanel(next.id);
  };
  // Agents are bound from the Studio Agents page. Admit the preset,
  // create its Session, select it before the first turn, then hand the
  // Session to DSH's own navigation service. This keeps the native
  // composer visible from the first frame and makes binding an explicit
  // action rather than a side effect of opening a custom chat page.
  ctx.inject(['uiWorkspace', 'sessions', 'modelDirectories'], navCtx => {
    const binding = createNativeSessionBinding({ navCtx, remote: ctx.remote, layout: ctx.layout, hostRemote, writeConversationAgent, actions, isActive: () => !app.closed() });
    const release = actions.registerBinding(binding.bindAgent);
    const releaseSession = actions.registerSessionOpener(sessionId => { if (app.closed()) return; navCtx.uiWorkspace.openSession(sessionId); ctx.layout.selectPanel(null); });
    return () => { binding.dispose(); release(); releaseSession(); };
  });
  ctx.inject(['uiWorkspace'], authoringCtx => {
    authoringCtx.effect(() => {
      let opening = false;
      const openAuthoring = async () => {
        if (opening) return;
        opening = true;
        try { await openAgentAuthoring(authoringCtx.uiWorkspace); }
        catch (error) {
          authoring.cancel();
          actions.confirm({ title: '无法打开创建会话', detail: error?.message || '请稍后重试', confirmLabel: '知道了' });
        } finally { opening = false; }
      };
      window.addEventListener('agentkit-studio:open-authoring', openAuthoring);
      return () => window.removeEventListener('agentkit-studio:open-authoring', openAuthoring);
    }, 'agentkit-studio:authoring-entry');
  });
  PANELS.forEach((panel, index) => {
    ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: panel.id },
      () => h(StudioShell, { page: panel.page, onNavigate: navigateStudio, scheduleRemote }),
    ));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: panel.id, order: 1 + index, label: panel.label },
      props => h(StudioPanelIcon, { ...props, glyph: panel.glyph, panelId: panel.id }),
    ));
  });
  // A reload lands back on the native conversation panel by default.
  // Persist every panel selection (sidebar clicks included — they go
  // through layout.selectPanel, not navigateStudio) via the panelInfo
  // observable, and restore the last one after the panels register.
  registerPanelNavigation(ctx, { window, panels: PANELS });
  // Settings remains the official DSH modal and navigation surface. Studio
  // contributes native sections into that settings dialog. The model page is Studio
  // owned; its save path also writes DSH's public llm-pi-ai settings and
  // credentials contracts so the official composer model seat can resolve it.
  const dshModel = createDshModelBridge(ctx);

  // The Studio model form is not guaranteed to be opened before the user
  // starts a conversation. Keep the official DSH model directory in sync
  // from the Host configuration at plugin boot and after a DSH reconnect,
  // so a fresh chat never falls back to the stale profile default merely
  // because the settings modal was not visited first.
  let modelSyncInFlight = null;
  const syncModelFromStudioHost = async () => {
    if (app.closed()) return;
    if (modelSyncInFlight) return modelSyncInFlight;
    modelSyncInFlight = (async () => {
      try {
        // Keep the DSH write-only credential reference warm even when the
        // Settings modal has never been opened in this profile.
        await hostRemote.syncModelCredential();
        if (app.closed()) return;
        const settings = await hostRemote.settings();
        if (app.closed()) return;
        const profiles = Array.isArray(settings?.modelProfiles) && settings.modelProfiles.length
          ? settings.modelProfiles.map((profile, index) => ({ ...profile, credentialName: modelCredentialName(profile, index) }))
          : [{ provider: settings?.modelProvider || 'ksyun', modelName: settings?.modelName || DEFAULT_KSYUN_MODEL, baseUrl: settings?.modelBaseUrl || DEFAULT_KSYUN_BASE_URL, credentialName: DSH_MODEL_CREDENTIAL }];
        const active = profiles.find(profile => profile.enabled !== false && profile.default === true && profile.modelName)
          || profiles.find(profile => profile.enabled !== false && profile.modelName);
        if (!active?.modelName) return;
        const document = await dshModel.describe();
        const defaultNamespace = (document.namespaces || []).find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
        const defaultValue = defaultNamespace?.value || defaultNamespace?.user || {};
        // Reconcile the full catalog, including credentials/modalities and removed rows.
        // A matching default model alone does not prove synchronization.
        await dshModel.applyProfiles({ profiles, keys: {} });
      } catch (reason) {
        // DSH remains usable when the optional Studio Host is offline;
        // the settings surface reports the actionable error on demand.
        console.warn('[agentkit-studio] model sync skipped:', reason?.message || reason);
      } finally {
        modelSyncInFlight = null;
      }
    })();
    return modelSyncInFlight;
  };
  void syncModelFromStudioHost();
  ctx.on('connection/reset', () => { void syncModelFromStudioHost(); });
  ctx.effect(() => {
    const sync = () => { void syncModelFromStudioHost(); };
    window.addEventListener('agentkit-studio:model-changed', sync);
    return () => window.removeEventListener('agentkit-studio:model-changed', sync);
  }, 'agentkit-studio: model resource synchronization');
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'agentkit-models', order: 190, label: '模型与凭证',
  }, () => h(ModelSettingsSection, { dshModel })));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'agentkit-studio', order: 200, label: PRODUCT_BRAND.name,
  }, StudioSettingsSection));
}
