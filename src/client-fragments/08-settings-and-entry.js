    function StudioSettingsSection() {
      const [host, setHost] = useState({ status: 'loading', error: '' });
      const [desktopUpdate, setDesktopUpdate] = useState({ phase: 'idle' });
      const updateLifetime = useRef({ active: false, revision: 0, opening: false });
      const desktopUpdates = typeof window === 'undefined' ? undefined : window.dshDesktop?.updates;
      useEffect(() => {
        let active = true;
        hostRemote.settings().then(() => { if (active) setHost({ status: 'ready', error: '' }); })
          .catch(error => { if (active) setHost({ status: 'error', error: error?.message || 'Studio Host 不可达' }); });
        return () => { active = false; };
      }, []);
      useEffect(() => {
        const bridge = desktopUpdates;
        if (!bridge) return undefined;
        const lifetime = updateLifetime.current;
        lifetime.active = true;
        const revision = lifetime.revision;
        const unsubscribe = bridge.subscribe(state => {
          lifetime.revision += 1;
          if (lifetime.active && state) setDesktopUpdate(state);
        });
        bridge.status().then(state => {
          if (lifetime.active && revision === lifetime.revision && state) setDesktopUpdate(state);
        }).catch(() => undefined);
        return () => { lifetime.active = false; lifetime.revision += 1; unsubscribe?.(); };
      }, [desktopUpdates]);
      const checkDesktopUpdate = async () => {
        const bridge = desktopUpdates;
        const lifetime = updateLifetime.current;
        if (!bridge || lifetime.opening || ['checking', 'downloading', 'verifying', 'installing'].includes(desktopUpdate.phase)) return;
        lifetime.opening = true;
        lifetime.revision += 1;
        setDesktopUpdate(current => ({ ...current, phase: 'checking' }));
        try {
          await bridge.open();
          const revision = lifetime.revision;
          const state = await bridge.status();
          if (lifetime.active && revision === lifetime.revision && state) setDesktopUpdate(state);
        } catch {
          if (lifetime.active) setDesktopUpdate({ phase: 'error', failure: 'check' });
        } finally { lifetime.opening = false; }
      };
      const updateButtonLabel = desktopUpdate.phase === 'checking' ? '检查中…'
        : desktopUpdate.phase === 'available' ? `发现 ${desktopUpdate.version || '新版本'}`
          : desktopUpdate.phase === 'ready' ? `安装 ${desktopUpdate.version || '新版本'}`
            : desktopUpdate.phase === 'error' ? '重试检查更新' : '检查更新';
      return h('div', {
        style: { color: BRAND.ink, fontFamily: 'inherit' },
      },
      h(SectionHeading, { eyebrow: 'AgentKit Studio', title: 'Studio 设置', detail: '查看当前产品与 Host 状态。模型和凭证在「模型与凭证」中配置，资源绑定在 Agent 编辑页完成。' }),
      h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '14px', padding: '0 18px', background: BRAND.surface } },
        h(SettingsRow, { label: '会话绑定策略', value: '可选 Agent', detail: '不选择 Agent 时直接使用 DSH 原生会话；选择后在新会话创建时固定主 Agent', tone: 'accent' }),
        h(SettingsRow, { label: '默认执行目标', value: 'Local Host', detail: '创建 Agent 和运行会话时使用的默认目标', tone: 'signal' }),
        h(SettingsRow, { label: 'Studio Host', value: host.status === 'ready' ? '已连接' : host.status === 'loading' ? '检查中' : '连接失败', detail: host.status === 'ready' ? '已成功读取 Host 配置' : host.error || '正在读取 Host 配置', tone: 'signal' }),
        h(SettingsRow, { label: 'AgentKit Studio 版本', value: STUDIO_VERSION, detail: '当前安装的桌面应用版本' }),
        h(SettingsRow, { label: 'Studio 插件版本', value: STUDIO_PLUGIN_VERSION, detail: '产品功能与运行适配层版本' }),
        h(SettingsRow, { label: 'DSH 宿主兼容版本', value: DSH_VERSION, detail: '固定的宿主基线，不代表 Studio 产品版本' }),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '14px 0' } },
          h('div', null,
            h('div', { style: { fontSize: '12px', fontWeight: 700 } }, '桌面更新'),
            h('div', { role: 'status', style: { marginTop: '4px', color: BRAND.inkMuted, fontSize: '11px' } }, !desktopUpdates ? '请在 AgentKit Studio 桌面应用中检查更新。' : desktopUpdate.phase === 'error' ? '更新检查失败，可重试。' : desktopUpdate.version ? `目标版本：${desktopUpdate.version}` : '使用 Studio 的更新源检查新版本。')),
          h('button', { type: 'button', onClick: checkDesktopUpdate, disabled: !desktopUpdates || ['checking', 'downloading', 'verifying', 'installing'].includes(desktopUpdate.phase), style: { border: '1px solid ' + BRAND.border, borderRadius: '8px', padding: '7px 11px', color: BRAND.accentStrong, background: BRAND.surface, fontSize: '11px', fontWeight: 700, cursor: 'pointer' } }, updateButtonLabel))),
      h('div', { style: { marginTop: '16px', padding: '14px 16px', borderRadius: '12px', color: BRAND.inkMuted, background: BRAND.canvas, fontSize: '12px', lineHeight: 1.55 } },
        h('div', null, '工作区、会话、模型和凭证的通用设置继续由系统设置页承载；Studio 只扩展自己的执行目标、Host 能力和产品选项。'),
        h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:credential-onboarding')), style: { marginTop: '10px', border: '1px solid ' + BRAND.border, borderRadius: '8px', padding: '6px 10px', color: BRAND.accentStrong, background: BRAND.surface, fontSize: '11px', fontWeight: 700 } }, '重新打开凭证引导')));
    }

    function StudioSettingsLauncher({ wide, settingsOpen, settingsShortcut, openSettings, openOnboarding, t }) {
      const label = t('trigger');
      useEffect(() => {
        const open = () => openSettings?.();
        const guide = () => openOnboarding?.('agentkit-studio-credential');
        window.addEventListener('agentkit-studio:open-settings', open);
        window.addEventListener('agentkit-studio:credential-onboarding', guide);
        return () => {
          window.removeEventListener('agentkit-studio:open-settings', open);
          window.removeEventListener('agentkit-studio:credential-onboarding', guide);
        };
      }, [openSettings, openOnboarding]);
      return h(Tooltip, { disabled: settingsOpen, label, shortcutKeys: settingsShortcut?.keys },
        h('button', {
          type: 'button', className: 'agentkit-settings-launcher', 'data-wide': wide,
          'aria-label': label, 'aria-keyshortcuts': settingsShortcut?.aria,
          'aria-haspopup': 'dialog', 'aria-expanded': settingsOpen, onClick: openSettings,
        }, h(IconSettingsOutlineMedium, { size: wide ? 16 : 18 }), wide && h('span', null, label)));
    }

    function apply(ctx) {
      ctx.uiConversation.events.register(codexToolDefinition);
      // Settings owns first-run coordination. Registering here makes the
      // guide visible in the real DSH onboarding path and gives the shell a
      // stable entry it can reopen after the user chose “later”.
      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding', id: 'agentkit-studio-credential', order: 20,
      }, CredentialOnboarding));
      activeConnection = { rpc: ctx.connection.rpc };
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
        try {
          const roster = await hostRemote.agents();
          const presetId = String(selectedPreset || ctx.sessions?.list?.getSnapshot?.().byId?.[sessionId]?.projectionValues?.agentPreset || '');
          const agent = (roster?.items || []).find(item => presetIdForAgent(item) === presetId);
          if (!agent) return;
          const agentId = String(agent?.metadata?.id || agent?.id || '').trim();
          const admission = await hostRemote.ensureDshPreset(agentId);
          if (admission.modelSelection) {
            const selected = await ctx.remote.session.selectModel({ sessionId, ...admission.modelSelection, saveDefault: false });
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
      const ACTIVE_PANEL_KEY = 'agentkit-studio:active-panel';
      const navigateStudio = target => {
        const next = PANELS.find(item => item.page === target || item.id === target);
        if (next) ctx.layout.selectPanel(next.id);
      };
      // Agents are bound from the Studio Agents page. Admit the preset,
      // create its Session, select it before the first turn, then hand the
      // Session to DSH's own navigation service. This keeps the native
      // composer visible from the first frame and makes binding an explicit
      // action rather than a side effect of opening a custom chat page.
      ctx.inject(['uiWorkspace', 'sessions', 'modelDirectories'], navCtx => {
        window.__AGENTKIT_STUDIO_BIND_AGENT__ = async (agentOrOptions, requestedBuildId = '') => {
          const options = agentOrOptions && typeof agentOrOptions === 'object' ? agentOrOptions : { agentId: agentOrOptions, buildId: requestedBuildId };
          const value = String(options.agentId || '').trim();
          const buildId = String(options.buildId || '').trim();
          if (!value && options.workspaceFree !== true) return;
          try {
            // Keep the DSH-native blank-session semantics. An Agent binding
            // must not force a filesystem Workspace; users can choose one in
            // the native composer when they need workspace tools.
            const admission = value ? await hostRemote.ensureDshPreset(value, buildId) : null;
            const sessionId = await navCtx.sessions.create({});
            if (admission) {
              const selected = await ctx.remote?.agentPresets?.select?.(sessionId, admission.presetId);
              if (selected === undefined || selected === null || (typeof selected === 'object' && selected.ok === false)) {
                throw new Error(selected?.error?.message || 'DSH 拒绝绑定该 Agent');
              }
            }
            const modelSelection = options.modelSelection || admission?.modelSelection;
            if (modelSelection) {
              // The new Session may not have a browser scope until it is
              // opened. Select through DSH's durable Remote first; the native
              // directory observes the resulting projection when it mounts.
              const result = await ctx.remote.session.selectModel({ sessionId, ...modelSelection, saveDefault: false });
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
      ctx.inject(['uiWorkspace'], authoringCtx => {
        authoringCtx.effect(() => {
          let opening = false;
          const openAuthoring = async () => {
            if (opening) return;
            opening = true;
            try { await openAgentAuthoring(authoringCtx.uiWorkspace); }
            catch (error) {
              pendingAuthoring = false;
              window.__AGENTKIT_CONFIRM__?.({ title: '无法打开创建会话', detail: error?.message || '请稍后重试', confirmLabel: '知道了' });
            } finally { opening = false; }
          };
          window.addEventListener('agentkit-studio:open-authoring', openAuthoring);
          return () => window.removeEventListener('agentkit-studio:open-authoring', openAuthoring);
        }, 'agentkit-studio:authoring-entry');
      });
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
      ctx.effect(() => {
        let restoring = true;
        const subscription = ctx.layout.panelInfo?.subscribe?.(() => {
          if (restoring) return;
          try {
            const info = ctx.layout.panelInfo.getSnapshot?.();
            const id = String(info?.activePanelId || '');
            if (id) window.localStorage.setItem(ACTIVE_PANEL_KEY, id);
            else window.localStorage.removeItem(ACTIVE_PANEL_KEY);
          } catch { /* layout store unavailable */ }
        });
        const timer = setTimeout(() => {
          try {
            const last = window.localStorage.getItem(ACTIVE_PANEL_KEY);
            const next = PANELS.find(item => item.id === last);
            if (next) ctx.layout.selectPanel(next.id);
          } catch { /* private mode */ }
          finally { restoring = false; }
        }, 0);
        return () => {
          clearTimeout(timer);
          subscription?.unsubscribe?.();
        };
      }, 'agentkit-studio:active-panel-restore');
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
      ctx.effect(() => {
        const sync = () => { void syncModelFromStudioHost(); };
        window.addEventListener('agentkit-studio:model-changed', sync);
        return () => window.removeEventListener('agentkit-studio:model-changed', sync);
      }, 'agentkit-studio: model resource synchronization');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-models', order: 190, label: '模型与凭证',
      }, () => h(ModelSettingsSection, { dshModel })));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-studio', order: 200, label: 'AgentKit Studio',
      }, StudioSettingsSection));
    }

    return {
      name: 'agentkit-studio',
      inject: ['slots', 'layout', 'connection', 'remote', 'remote.session', 'remote.settings', 'remote.credentials', 'remote.llm', 'remote.agentPresets', 'remote.commands', 'sessions', 'modelDirectories', 'uiConversation'],
      apply,
    };
  },
});
