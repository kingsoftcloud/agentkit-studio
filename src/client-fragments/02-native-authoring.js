    let pendingAuthoring = false;
    const AUTHORING_PROMPT = '请帮我创建一个 Agent。尽量一轮完成：先用 studio_agent_resources 查询真实的模型/MCP/Skill ID，再用 studio_agent_draft 一次性填好名称、运行时（默认 dsh-native）、系统 Prompt 和资源绑定，然后把草稿摘要（名称、运行时、Prompt 要点、绑定列表）展示给我；我确认后再调用 studio_agent_create 创建。只有当我说的需求缺少关键信息（比如完全没说用途）时才先追问，不要逐项反复确认。我的需求是：';
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
