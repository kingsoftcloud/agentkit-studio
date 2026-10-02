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
      // dsh-v0.2.0-rc.2 host. Older profiles can still expose the Studio
      // product surface and all model/agent/resource surfaces while the automation
      // panel reports that its host service is unavailable.
      const scheduleRemote = ctx.remote && typeof ctx.remote.schedule?.catalog === 'function'
        ? ctx.remote.schedule
        : null;
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
        try {
          const roster = await hostRemote.agents();
          const presetId = String(selectedPreset || ctx.sessions?.list?.getSnapshot?.().byId?.[sessionId]?.projectionValues?.agentPreset || '');
          const agent = (roster?.items || []).find(item => presetIdForAgent(item) === presetId);
          if (!agent) return;
          const agentId = String(agent?.metadata?.id || agent?.id || '').trim();
          const admission = await hostRemote.ensureDshPreset(agentId);
          if (admission.modelSelection && ctx.modelDirectories?.directoryFor) {
            const selected = await ctx.modelDirectories.directoryFor(sessionId).select(admission.modelSelection);
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
        props => h(AgentContextSelector, { ...props, studioRemote: ctx.remote, modelDirectories: ctx.modelDirectories }),
      ));

      // Authoring entry: only the hero selector keeps the "创建 Agent" button.
      // The composer-left injection was removed — conversation authoring is a
      // fresh-session flow, and a composer button let users seed it mid-chat.

      // Each product domain is a first-class DSH main panel. The rows land in
      // the official panel list directly below New Session, using the product information architecture. Page-level resource tabs remain in
      // the content area; the four product domains never become a second row
      // of tabs inside their own detail page.
      const ACTIVE_PANEL_KEY = 'agentkit-studio:active-panel';
      const navigateStudio = target => {
        const next = PANELS.find(item => item.page === target || item.id === target);
        if (next) ctx.layout.selectPanel(next.id);
      };
      // Agents are bound from the Studio Agents page. Create the Session,
      // admit its preset, select it before the first turn, then hand the
      // Session to DSH's own navigation service. This keeps the native
      // composer visible from the first frame and makes binding an explicit
      // action rather than a side effect of opening a custom chat page.
      ctx.inject(['uiWorkspace', 'sessions', 'modelDirectories'], navCtx => {
        window.__AGENTKIT_STUDIO_BIND_AGENT__ = async (agentOrOptions, requestedBuildId = '') => {
          const options = agentOrOptions && typeof agentOrOptions === 'object' ? agentOrOptions : { agentId: agentOrOptions, buildId: requestedBuildId };
          const value = String(options.agentId || '').trim();
          const buildId = String(options.buildId || '').trim();
          if (!value) return;
          try {
            // Keep the DSH-native blank-session semantics. An Agent binding
            // must not force a filesystem Workspace; users can choose one in
            // the native composer when they need workspace tools.
            const sessionId = await navCtx.sessions.create({});
            const admission = await hostRemote.ensureDshPreset(value, buildId);
            const selected = await ctx.remote?.agentPresets?.select?.(sessionId, admission.presetId);
            if (selected === undefined || selected === null || (typeof selected === 'object' && selected.ok === false)) {
              throw new Error(selected?.error?.message || 'DSH 拒绝绑定该 Agent');
            }
            if (admission.modelSelection) {
              const result = await navCtx.modelDirectories.directoryFor(sessionId).select(admission.modelSelection);
              if (!result?.ok) throw new Error(result?.error?.message || 'Agent 绑定的模型不可用');
            }
            try {
              const permission = await ctx.remote?.commands?.execute?.(sessionId, '/permission read-only', []);
              if (permission && permission.ok === false) console.warn('[agentkit-studio] Agent permission default was not applied:', permission.error?.message || permission.error);
            } catch (error) {
              console.warn('[agentkit-studio] Agent permission default unavailable:', error?.message || error);
            }
            writeConversationAgent(value, sessionId);
            window.__AGENTKIT_STUDIO_SET_SESSION_FILTER__?.(value);
            navCtx.uiWorkspace.openSession(sessionId);
            ctx.layout.selectPanel(null);
          } catch (error) {
            const message = error?.message || 'Agent 绑定失败';
            console.error('[agentkit-studio] native Agent binding failed:', error);
            window.__AGENTKIT_CONFIRM__?.({ title: 'Agent 绑定失败', detail: message, confirmLabel: '知道了' });
          }
        };
        return () => { try { delete window.__AGENTKIT_STUDIO_BIND_AGENT__; } catch {} };
      });
      // A reload lands back on the native conversation panel by default.
      // Persist every panel selection (sidebar clicks included — they go
      // through layout.selectPanel, not navigateStudio) via the panelInfo
      // observable, and restore the last one after the panels register.
      ctx.effect(() => {
        const subscription = ctx.layout.panelInfo?.subscribe?.(() => {
          try {
            const info = ctx.layout.panelInfo.getSnapshot?.();
            const id = String(info?.activePanelId || '');
            if (id) window.localStorage.setItem(ACTIVE_PANEL_KEY, id);
          } catch { /* layout store unavailable */ }
        });
        const timer = setTimeout(() => {
          try {
            const last = window.localStorage.getItem(ACTIVE_PANEL_KEY);
            const next = PANELS.find(item => item.id === last);
            if (next) ctx.layout.selectPanel(next.id);
          } catch { /* private mode */ }
        }, 0);
        return () => {
          clearTimeout(timer);
          subscription?.unsubscribe?.();
        };
      }, 'agentkit-studio:active-panel-restore');
      ctx.effect(() => {
        const openAuthoring = () => {
          pendingAuthoring = true;
          ctx.layout.selectPanel(null);
          window.dispatchEvent(new CustomEvent('agentkit-studio:seed-authoring'));
        };
        window.addEventListener('agentkit-studio:open-authoring', openAuthoring);
        return () => {
          window.removeEventListener('agentkit-studio:open-authoring', openAuthoring);
        };
      }, 'agentkit-studio:authoring-entry');
      // Studio patch 007: register a sidebar session filter so selecting an
      // Agent in the hero selector narrows the DSH sidebar to sessions bound
      // to that Agent. The filter reads a global variable (synced from the
      // selector) so it stays reactive without a DSH re-derive trigger.
      ctx.effect(() => {
        let unregister = null;
        try {
          const mod = require('@deepseek-ai/dsh-client-ui-workspace');
          if (mod && typeof mod.registerSessionFilter === 'function') {
            // Expose a setter on the window so the selector can update the
            // active Agent without re-registering the filter.
            window.__AGENTKIT_STUDIO_SESSION_FILTER__ = { activeAgentId: '' };
            window.__AGENTKIT_STUDIO_SET_SESSION_FILTER__ = agentId => {
              window.__AGENTKIT_STUDIO_SESSION_FILTER__.activeAgentId = String(agentId || '');
            };
            const filter = session => {
              if (session.blank) return true;
              const activeId = window.__AGENTKIT_STUDIO_SESSION_FILTER__?.activeAgentId || '';
              if (!activeId) return true;
              try {
                const raw = window.localStorage.getItem(`${CONVERSATION_AGENT_KEY}:${session.id}`);
                if (!raw) return false;
                const value = JSON.parse(raw);
                return String(value?.agentId || '') === activeId;
              } catch { return true; }
            };
            unregister = mod.registerSessionFilter(filter);
          }
        } catch { /* ui-workspace not loaded or patch not applied; sidebar stays unfiltered */ }
        return () => { if (unregister) unregister(); };
      }, 'agentkit-studio:sidebar-session-filter');
      // After a long suspend (laptop sleep / frozen tab) the DSH web client
      // reconnects, but statically-loaded plugin panel registrations are not
      // rebuilt by the platform's reconnect path — the Studio panel rows
      // vanish until a manual reload. Detect that state when the tab becomes
      // visible or the network returns and reload once (30 s loop guard).
      ctx.effect(() => {
        const recover = () => {
          if (document.visibilityState !== 'visible') return;
          const hasStudioPanel = [...document.querySelectorAll('button')]
            .some(button => button.textContent?.trim() === 'Agents');
          if (hasStudioPanel) return;
          try {
            const last = Number(window.sessionStorage.getItem('agentkit-studio:reload-guard') || 0);
            if (Date.now() - last < 30000) return;
            window.sessionStorage.setItem('agentkit-studio:reload-guard', String(Date.now()));
          } catch { /* private mode: still reload once per visibility event */ }
          window.location.reload();
        };
        document.addEventListener('visibilitychange', recover);
        window.addEventListener('online', recover);
        recover();
        return () => {
          document.removeEventListener('visibilitychange', recover);
          window.removeEventListener('online', recover);
        };
      }, 'agentkit-studio:auto-recover');
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
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-models', order: 190, label: '模型与凭证',
      }, () => h(ModelSettingsSection, { dshModel })));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-studio', order: 200, label: 'AgentKit Studio',
      }, StudioSettingsSection));
    }

    return {
      name: 'agentkit-studio',
      inject: ['slots', 'layout', 'connection', 'remote', 'remote.settings', 'remote.credentials', 'remote.llm', 'remote.agentPresets', 'remote.commands', 'sessions', 'modelDirectories'],
      apply,
    };
  },
});
