const STORAGE_KEY = 'agentkit-studio:conversation-agent';

/** Match durable preset identity; display storage never overrides execution. */
export function agentFromSessionPreset(presetId, agents) {
  if (typeof presetId !== 'string') return null;
  const agent = agents.find(item => {
    const id = item?.metadata?.id || item?.id;
    if (!id) return false;
    const encoded = encodeURIComponent(String(id)).replace(/%/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180) || 'unknown';
    return presetId.startsWith(`agentkit-studio-agent-${encoded}-r`);
  });
  return agent?.metadata?.id || agent?.id || null;
}

export function createConversationAgentState({
  storage = () => globalThis.window.localStorage,
  events = globalThis.window,
  createEvent = (type, detail) => new CustomEvent(type, { detail }),
  now = Date.now,
} = {}) {
  const key = sessionId => sessionId ? `${STORAGE_KEY}:${sessionId}` : STORAGE_KEY;
  return {
    readConversationAgent(sessionId) {
      if (!sessionId) return null;
      try {
        const raw = storage().getItem(key(sessionId));
        if (!raw) return null;
        const value = JSON.parse(raw);
        return typeof value?.agentId === 'string' && value.agentId ? value.agentId : null;
      } catch { return null; }
    },
    writeConversationAgent(agentId, sessionId) {
      const value = { agentId: agentId || null, updatedAt: now() };
      try { storage().setItem(key(sessionId), JSON.stringify(value)); } catch { /* private mode */ }
      events.dispatchEvent(createEvent('agentkit-studio:conversation-context-change', value));
    },
  };
}
