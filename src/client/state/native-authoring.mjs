export const AUTHORING_PROMPT = '我想通过对话创建一个 Agent。先了解用途、使用场景和输出要求，信息不足时逐步澄清，每轮最多问两个关键问题；根据讨论持续更新草稿，展示名称、运行时、提示词和实际可用的资源绑定。我明确确认草稿后再创建，不要提前创建，也不要编造资源。我的需求是：';

/** Native navigation owns Session creation; this owner only stages the prompt. */
export function createNativeAuthoring({
  writeConversationAgent,
  events = globalThis.window,
  createEvent = type => new CustomEvent(type),
}) {
  let pending = false;
  let generation = 0;
  let closed = false;
  let scopeOwner = null;
  const subscriptions = new Set();
  const dispose = () => {
    closed = true; generation++; pending = false;
    for (const off of subscriptions) off();
  };
  const seedAgentAuthoring = inputActions => {
    if (!inputActions?.captureInsertion || !inputActions?.insertText) return false;
    return inputActions.insertText(AUTHORING_PROMPT, inputActions.captureInsertion()) !== false;
  };
  return {
    mount() {
      closed = false; pending = false;
      generation++;
      // Navigation advances the request generation, so the scope identity
      // is kept separately from outstanding navigation requests.
      const token = {};
      scopeOwner = token;
      return () => { if (scopeOwner === token) { scopeOwner = null; dispose(); } };
    },
    pending: () => pending,
    seedAgentAuthoring,
    request() { if (!closed) events.dispatchEvent(createEvent('agentkit-studio:open-authoring')); },
    consume(inputActions) {
      if (!closed && pending && seedAgentAuthoring(inputActions)) pending = false;
    },
    async openAgentAuthoring(uiWorkspace) {
      if (closed) return;
      const owner = ++generation;
      pending = false;
      try {
        await uiWorkspace.openWorkspace(null, sessionId => {
          if (closed || owner !== generation) return;
          writeConversationAgent('', sessionId);
          pending = true;
        });
      } catch (error) {
        if (owner === generation) pending = false;
        throw error;
      }
      if (!closed && owner === generation && pending) events.dispatchEvent(createEvent('agentkit-studio:seed-authoring'));
    },
    cancel() { generation++; pending = false; },
    dispose,
    subscribe(inputActions) {
      const seed = () => this.consume(inputActions);
      seed();
      events.addEventListener('agentkit-studio:seed-authoring', seed);
      const off = () => { events.removeEventListener('agentkit-studio:seed-authoring', seed); subscriptions.delete(off); };
      subscriptions.add(off);
      return off;
    },
  };
}
