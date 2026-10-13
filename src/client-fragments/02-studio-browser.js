    // Commands exist only during a live Tool call. Opening saved tool history
    // never replays navigation. The official controller owns the destination.
    function installStudioBrowser(ctx) {
      ctx.effect(() => {
        const lifetime = new AbortController();
        let timer;
        const rpc = async (endpoint, payload) => {
          const result = await ctx.connection.rpc.call('/agentkit-ui', endpoint, payload, lifetime.signal);
          if (!result?.ok) throw new Error(result?.error?.code || 'BROWSER_UI_UNAVAILABLE');
          return result.value;
        };
        const poll = async () => {
          if (lifetime.signal.aborted) return;
          try {
            const sessionId = ctx.sidebarRight.mounted.getSnapshot();
            if (!sessionId || !ctx.sidebarRightTabs.get('browser')) return;
            const request = await rpc('browser/claim', { sessionId });
            if (!request || lifetime.signal.aborted) return;
            const receipt = { sessionId, requestId: request.requestId, claim: request.claim };
            try {
              // Recheck the live request and target after each asynchronous
              // boundary, so switching conversations cannot redirect it.
              await rpc('browser/confirm', receipt);
              if (lifetime.signal.aborted) return;
              if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId || Date.now() >= request.expiresAt) throw new Error('BROWSER_TARGET_CHANGED');
              ctx.sidebarRight.openTab('browser', { params: { url: request.url } });
              const tab = ctx.sidebarRight.active();
              await rpc('browser/ack', { ...receipt, kind: tab?.kind, tabId: tab?.id });
            } catch {
              if (!lifetime.signal.aborted) await rpc('browser/ack', { ...receipt, error: true }).catch(() => undefined);
            }
          } catch { /* Missing/offline Hosts remain usable; no false success. */ }
          finally { if (!lifetime.signal.aborted) timer = setTimeout(poll, 1000); }
        };
        void poll();
        return () => { lifetime.abort(); clearTimeout(timer); };
      }, 'agentkit-studio: browser command receiver');
    }
