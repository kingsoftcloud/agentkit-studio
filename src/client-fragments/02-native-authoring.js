    let pendingAuthoring = false;
    const AUTHORING_PROMPT = '请帮我创建一个 Agent。先使用 studio_agent_draft 读取草稿，通过多轮对话补充用途、运行时、Prompt 和资源绑定；用 studio_agent_resources 查询真实资源。展示草稿并等我确认后，再调用 studio_agent_create。我的需求是：';
    function seedAgentAuthoring(inputActions) {
      if (!inputActions?.captureInsertion || !inputActions?.insertText) return false;
      return inputActions.insertText(AUTHORING_PROMPT, inputActions.captureInsertion()) !== false;
    }
    function NativeAuthoringButton({ inputActions }) {
      const [notice, setNotice] = useState('');
      useEffect(() => {
        const seed = () => {
          if (pendingAuthoring && seedAgentAuthoring(inputActions)) pendingAuthoring = false;
        };
        seed();
        window.addEventListener('agentkit-studio:seed-authoring', seed);
        return () => window.removeEventListener('agentkit-studio:seed-authoring', seed);
      }, [inputActions]);
      return h('button', {
        type: 'button', disabled: !inputActions, title: notice || '在当前聊天中描述需求，生成并确认 Agent',
        onClick: () => setNotice(seedAgentAuthoring(inputActions) ? '已填入当前输入框，请补充需求后发送' : '当前输入框忙碌，请稍后重试'),
        style: { ...buttonStyle(), fontSize: '11px', padding: '5px 8px', whiteSpace: 'nowrap' },
      }, '创建 Agent');
    }
