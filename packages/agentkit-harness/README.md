# @kingsoftcloud/agentkit-harness

AgentKit Harness 的产品入口包含 Studio Native 执行引擎和 DSH 服务外观。本目录还保留单独发布的 **DSH facade 包**；二者的分发范围不同。

## Studio Native 执行引擎

Studio 的新 `runtime.type = "harness"` Revision / Build 默认采用
`agentkit.native-dsh-turn/v1`。`../agentkit-harness-core/` 提供独立 TypeScript
状态机和完整执行循环，`src/native/` 提供 Node 模型、SQLite、工具和其他端口，
Studio Host 负责组装。Native 管理预算、重试、副作用和 Run 恢复；DSH 保留产品
Session、工具权限及展示，通过维护版外部回合接口将执行权交给 Native。

Native 有自己的持久化 Run / 意图 / 回执 / 事件格式，通过版本化投影写入 DSH
Session，不能将它理解为仅替换模型调用。安装和执行不依赖 Python 或 uv。
这部分由仓库根目录的 **Studio 包**分发，并需要维护版 DSH；下面的
`pnpm pack:harness` 只生成 facade 包，不包含 `src/native/` 或 TS 核心。
Studio 通过根目录 `package.json` 安装并绑定独立的 Core、Node 和 UI 包。

## 独立 DSH facade 包

以下说明仅适用于独立安装的 facade。它复用 DSH 的 `AgentRegistry`、`SessionStore`、
Session persistence、AgentLoop 和 `agent/assistant-stream`。facade 公共合同不复制
产品 Session 状态机、事件 envelope 或文件存储；这不代表 Studio Native 没有自己的 Run 存储。

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

独立 facade 不接 KsADK、Python 或 Studio 控制面。模型适配器通过 `createDshHarnessAdapter()` 接受已经符合 DSH `StreamChunk` 的模型；宿主再用 `ctx.llm.registerAdapter()` 注册它。facade 的产品会话持久化由宿主加载的 `@deepseek-ai/dsh-session-persistence-*` 插件负责，恢复调用 `harness.resume()`。

## 合同边界

- Durable transcript：DSH `SessionEvent`，序号从 `0` 开始。
- Live output：DSH `AssistantStreamFrame`（`start/chunk/end`）。
- LLM wire：DSH `GenerateOptions` 和 `StreamChunk`。
- facade 生命周期：DSH `AgentHandle.dispose()`；facade 不复制 store 或 recovery loop。Studio Native 的 Run 恢复由 Native 执行层负责。

`@kingsoftcloud/agentkit-harness` 只在 DSH Host 中有意义；它是独立 npm 发布的 DSH 插件，不是脱离 DSH 的另一套运行时。

包内的 `src/local-runtime.mjs` 只给同仓库 Studio 的 Host HTTP 兼容入口使用，未加入 npm exports，也不属于独立 Harness 的会话或流式合同。独立消费者应加载 DSH 插件并使用上面的 Agent、Session、persistence 和 AssistantStream 接口。
