# @kingsoftcloud/agentkit-harness

AgentKit Harness 是一个 **DSH 插件**。它复用 DSH 的 `AgentRegistry`、`SessionStore`、Session persistence、AgentLoop 和 `agent/assistant-stream`，只提供 Studio 侧的薄服务外观。公共 Harness 合同没有第二套 Session 状态机、事件 envelope 或文件存储。

当前包可从源码独立打包并安装到 DSH profile。npm registry 发布需要对应 scope 权限；打包成功不等于 registry 已发布。

```sh
pnpm pack:harness
# 在目标 DSH profile 的 npm 项目中安装生成的 tgz：
pnpm add /path/to/kingsoftcloud-agentkit-harness-0.0.1.tgz
```

宿主需要先加载 DSH 的 Agent、Session、LLM 和 AgentLoop 插件，再加载本包：

```js
import AgentKitHarness from '@kingsoftcloud/agentkit-harness';

await ctx.plugin(AgentKitHarness);
const harness = ctx.agentkitHarness;
const { agent } = await harness.create({
  sessionId: SessionId('studio-demo'),
  agentOptions: { provider: 'mock', model: 'mock' },
});
agent.followup(createUserMessage({
  content: [{ type: 'text', text: '你好' }],
  source: { kind: 'user' },
}));
```

插件本身不接 KsADK、Python 或 Studio 控制面。模型适配器通过 `createDshHarnessAdapter()` 接受已经符合 DSH `StreamChunk` 的模型；宿主再用 `ctx.llm.registerAdapter()` 注册它。持久化由宿主加载的 `@deepseek-ai/dsh-session-persistence-*` 插件负责，恢复调用 `harness.resume()`。

## 合同边界

- Durable transcript：DSH `SessionEvent`，序号从 `0` 开始。
- Live output：DSH `AssistantStreamFrame`（`start/chunk/end`）。
- LLM wire：DSH `GenerateOptions` 和 `StreamChunk`。
- 生命周期：DSH `AgentHandle.dispose()`；Harness 不复制 store 或 recovery loop。

`@kingsoftcloud/agentkit-harness` 只在 DSH Host 中有意义；它是独立 npm 发布的 DSH 插件，不是脱离 DSH 的另一套运行时。

包内的 `src/local-runtime.mjs` 只给同仓库 Studio 的 Host HTTP 兼容入口使用，未加入 npm exports，也不属于独立 Harness 的会话或流式合同。独立消费者应加载 DSH 插件并使用上面的 Agent、Session、persistence 和 AssistantStream 接口。
