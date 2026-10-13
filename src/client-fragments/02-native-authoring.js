    let pendingAuthoring = false;
    const AUTHORING_PROMPT = '我想通过对话创建一个 Agent。先了解用途、使用场景和输出要求，信息不足时逐步澄清，每轮最多问两个关键问题；根据讨论持续更新草稿，展示名称、运行时、提示词和实际可用的资源绑定。我明确确认草稿后再创建，不要提前创建，也不要编造资源。我的需求是：';
    async function openAgentAuthoring(uiWorkspace) {
      pendingAuthoring = false;
      await uiWorkspace.openWorkspace(null, sessionId => {
        writeConversationAgent('', sessionId);
        window.__AGENTKIT_STUDIO_SET_SESSION_FILTER__?.('');
        pendingAuthoring = true;
      });
      if (pendingAuthoring) window.dispatchEvent(new CustomEvent('agentkit-studio:seed-authoring'));
    }
    function seedAgentAuthoring(inputActions) {
      if (!inputActions?.captureInsertion || !inputActions?.insertText) return false;
      return inputActions.insertText(AUTHORING_PROMPT, inputActions.captureInsertion()) !== false;
    }
    function NativeAuthoringButton({ inputActions }) {
      useEffect(() => {
        const seed = () => {
          if (pendingAuthoring && seedAgentAuthoring(inputActions)) pendingAuthoring = false;
        };
        seed();
        window.addEventListener('agentkit-studio:seed-authoring', seed);
        return () => window.removeEventListener('agentkit-studio:seed-authoring', seed);
      }, [inputActions]);
      return h('button', {
        type: 'button', disabled: !inputActions, title: '新建会话，通过多轮对话完善 Agent 草稿',
        onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:open-authoring')),
        style: { ...buttonStyle(), fontSize: '11px', padding: '5px 8px', whiteSpace: 'nowrap' },
      }, '创建 Agent');
    }
