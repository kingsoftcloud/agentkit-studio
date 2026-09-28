    function StudioSettingsSection() {
      return h('div', {
        style: { color: BRAND.ink, fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
      },
      h(SectionHeading, { eyebrow: 'AgentKit Studio', title: 'Studio 设置', detail: '产品级配置会通过 Studio Host 的 settings schema 持久化。当前 Host 尚未连接，展示项保持只读。' }),
      h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '0 18px', background: BRAND.surface } },
        h(SettingsRow, { label: '会话绑定策略', value: '可选 Agent', detail: '不选择 Agent 时直接使用 DSH 原生会话；选择后在新会话创建时固定主 Agent', tone: 'accent' }),
        h(SettingsRow, { label: '默认执行目标', value: 'Local Host', detail: '创建 Agent 和运行会话时使用的默认目标', tone: 'signal' }),
        h(SettingsRow, { label: 'Studio Host', value: '待接入', detail: 'Health、capability 和 Session Remote 尚未连接', tone: 'signal' }),
        h(SettingsRow, { label: '事件流诊断', value: '关闭', detail: '连接 Host 后可以开启结构化 Session 事件日志' }),
        h(SettingsRow, { label: 'AgentKit Studio 版本', value: STUDIO_VERSION, detail: '产品功能与运行适配层版本' }),
        h(SettingsRow, { label: 'DSH 宿主兼容版本', value: DSH_VERSION, detail: '固定的宿主基线，不代表 Studio 产品版本' })),
      h('div', { style: { marginTop: '16px', padding: '14px 16px', borderRadius: '12px', color: BRAND.inkMuted, background: BRAND.canvas, fontSize: '12px', lineHeight: 1.55 } }, '工作区、会话、模型和凭证的通用设置继续由系统设置页承载；Studio 只扩展自己的执行目标、Host 能力和产品选项。'));
    }

    function apply(ctx) {
      activeConnection = ctx.connection;
      // Schedule is a capability, not a hard requirement for the fixed
      // dsh-v0.1.7-rc.2 host. Older profiles can still expose the Studio
      // product surface and all model/agent/resource surfaces while the automation
      // panel reports that its host service is unavailable.
      const scheduleRemote = ctx.remote && typeof ctx.remote.schedule?.catalog === 'function'
        ? ctx.remote.schedule
        : null;
      ctx.effect(() => adoptProductDocumentTitle(), 'agentkit-studio: document title');
      ctx.effect(() => adoptProductDocumentBrand(), 'agentkit-studio: document favicon');
      ctx.effect(() => installResponsiveStyles(), 'agentkit-studio: responsive layout');
      // DSH owns the official composer and its native session.prompt path.
      // Studio does not inject a sink or bridge into InputHub. The authoring
      // tools registered by the Host let this native conversation create and
      // refine a reviewed Agent draft. A selected no-resource dsh-native
      // Agent is admitted through the public DSH preset Remote; resource
      // bindings remain explicitly fail-closed until a provider materializes
      // them.
      // Replace the official DSH brand row through its public slots. This
      // preserves the frame while giving the product its own identity.
      ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register(
        { name: 'sidebar.brand.mark' },
        ({ size }) => h('span', { style: { display: 'inline-flex', color: BRAND.accentStrong } }, h(StudioMark, { size: size || 24, title: '' })),
      ));
      ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
        { name: 'sidebar.brand.name' },
        () => h('span', { style: { color: BRAND.ink, fontSize: '13px', fontWeight: 800, letterSpacing: '-0.02em' } }, 'AgentKit Studio'),
      ));
      ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
        { name: 'conversation.hero.brand.mark' },
        ({ size }) => h('span', { style: { display: 'inline-flex', color: BRAND.accentStrong } }, h(StudioMark, { size, title: '' })),
      ));
      ctx.slots.inject('conversation.hero.brand.name', () => ctx.slots.register(
        { name: 'conversation.hero.brand.name' },
        () => h('span', null, 'AgentKit Studio'),
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
        props => h(AgentContextSelector, { ...props, studioRemote: ctx.remote }),
      ));

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        { name: 'conversation.input.left', id: 'studio-authoring', order: 150 },
        props => h(NativeAuthoringButton, props),
      ));

      // Each product domain is a first-class DSH main panel. The rows land in
      // the official panel list directly below New Session, using the product information architecture. Page-level resource tabs remain in
      // the content area; the four product domains never become a second row
      // of tabs inside their own detail page.
      const navigateStudio = target => {
        const next = PANELS.find(item => item.page === target || item.id === target);
        if (next) ctx.layout.selectPanel(next.id);
      };
      ctx.effect(() => {
        const openAuthoring = () => {
          pendingAuthoring = true;
          ctx.layout.selectPanel(null);
          window.dispatchEvent(new CustomEvent('agentkit-studio:seed-authoring'));
        };
        const openBoundConversation = event => {
          const agentId = String(event?.detail?.agentId || '').trim();
          if (!agentId) return;
          try { window.localStorage.setItem(OPEN_BOUND_CONVERSATION_KEY, agentId); } catch {}
          navigateStudio('studio-agents');
        };
        window.addEventListener('agentkit-studio:open-authoring', openAuthoring);
        window.addEventListener('agentkit-studio:open-bound-conversation', openBoundConversation);
        return () => {
          window.removeEventListener('agentkit-studio:open-authoring', openAuthoring);
          window.removeEventListener('agentkit-studio:open-bound-conversation', openBoundConversation);
        };
      }, 'agentkit-studio:authoring-entry');
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
        if (modelSyncInFlight) return modelSyncInFlight;
        modelSyncInFlight = (async () => {
          try {
            // Keep the DSH write-only credential reference warm even when the
            // Settings modal has never been opened in this profile.
            await hostRemote.syncModelCredential();
            const settings = await hostRemote.settings();
            const profiles = Array.isArray(settings?.modelProfiles) && settings.modelProfiles.length
              ? settings.modelProfiles.map((profile, index) => ({ ...profile, credentialName: modelCredentialName(profile, index) }))
              : [{ provider: settings?.modelProvider || 'ksyun', modelName: settings?.modelName || DEFAULT_KSYUN_MODEL, baseUrl: settings?.modelBaseUrl || DEFAULT_KSYUN_BASE_URL, credentialName: DSH_MODEL_CREDENTIAL }];
            const active = profiles.find(profile => profile.enabled !== false && profile.modelName);
            if (!active?.modelName) return;
            const document = await dshModel.describe();
            const defaultNamespace = (document.namespaces || []).find(item => item.ns === DSH_DEFAULT_MODEL_SETTINGS_NS);
            const defaultValue = defaultNamespace?.value || defaultNamespace?.user || {};
            if (defaultValue?.model === active.modelName && defaultValue?.provider) return;
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
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-models', order: 190, label: '模型与凭证',
      }, () => h(ModelSettingsSection, { dshModel })));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-studio', order: 200, label: 'AgentKit Studio',
      }, StudioSettingsSection));
    }

    return {
      name: 'agentkit-studio',
      inject: ['slots', 'layout', 'connection', 'remote', 'remote.settings', 'remote.credentials', 'remote.llm', 'remote.agentPresets'],
      apply,
    };
  },
});
