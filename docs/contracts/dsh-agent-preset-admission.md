# DSH rc.2 Agent preset admission audit

> 状态：窄合同已补齐，并已落地 DSH 原生会话准入闭环。无资源 `dsh-native` 直接使用官方
> preset composition；Harness、Codex 及资源型 Revision 通过 preset-scoped Studio
> `llm/stream` provider bridge 进入同一 Session/Loop/Renderer。资源适配器的真实调用仍需按
> 资源类型分别验收，本文不能把一次文本响应扩大解释为所有资源已经生效。

## 1. 已确认的官方公开边界

截至 `dsh-v0.1.7-rc.2`（`477b4f420553e8a52c2fbccc464d7561b239c443`），官方 DSH 已经公开了两层能力：

1. `session/create` 的 wire 请求含可选 `agentPreset?: string`，响应会回显实际采用的 preset；Host 会校验 preset 是否存在、是否能挂载，并在首轮前拒绝坏 preset。
2. `@deepseek-ai/dsh-agent-preset-registry` 的公开 Remote 含 `agentPresets/list/read/select`。`select` 只能作用于尚未开始首轮的 Session，并把 `agent-preset/selected` 写入 DSH session log；恢复时由 projection 重新得到实际 composition。

本轮在官方 DSH 源码中补了一个窄的客户端合同（已贯通公开的 ClientSessions service、ISessions 和 SessionManager 三层）：

```ts
ctx.sessions.create({ cwd, sessionId?, workspaceId?, agentPreset? })
```

实现只把 `agentPreset` 传给既有 `remote.session.create`，没有注入 InputHub、SessionCommandController，也没有新增第二套会话状态。2026-09-27 在 rc.2 上重新运行了客户端合同、官方 Host preset 合同和 preset registry 三个测试文件：3 个文件、82 项测试全部通过。完整记录见 [`dsh-agent-preset-admission-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/dsh-agent-preset-admission-2026-09-27.json)。

## 2. 这项补丁解决了什么

- DSH Client feature 可以使用类型安全的 `ctx.sessions.create({ agentPreset })`，不必绕过公开 Remote 或拼接未声明的 RPC。
- Session 创建事实仍由 DSH Host 持久化；preset projection、锁定首轮后的切换拒绝、`agent-preset/selected` 事件继续由官方 registry 负责。
- 这条边界适合静态 profile preset 和后续正式的 Studio admission/provider 实现，也适合先做一个最小“当前 DSH 模型路由 + Agent Prompt”的真实 DSH Native Agent 验证。

## 3. 当前 Studio 实现的边界

Studio Host 现在通过 `agents/ensure-preset` 使用公开 `ctx.agentPresets.register` 注册一个稳定的、按 Agent Revision 版本化的 preset；对有系统 Prompt 的准入 Revision 挂载官方 `@deepseek-ai/dsh-persona` row。浏览器只在官方 session-scoped `conversation.hero.agentPreset` 槽位中调用 `ctx.remote.agentPresets.select(sessionId, presetId)`。首轮之后 DSH 自己锁定 preset，Studio 不注入 InputHub、SessionCommandController，也不维护第二套会话状态。

这条链对所有 Studio 支持的 `dsh-native`、`harness`、`codex` Revision 都建立 preset；其中
无资源、模型路由一致的 `dsh-native` 走官方模型适配器，其他 Revision 在 preset 内挂载
`@kingsoftcloud/agentkit-studio/dsh-runtime-plugin`，由 `llm/stream` waterfall 只替换实际
传输。DSH 的 request header 保留用户选择的 provider/model，因此原生模型选择器不会显示
内部的 `agentkit-studio/local:<agentId>` 路由。

官方直连准入仍要求：

- runtime 是 `dsh-native`；
- 最多一个模型绑定，且模型 id 必须与 Studio 全局配置解析出的 DSH 当前活动模型一致；
- 不含 Tool、MCP、Skill、知识库、记忆库或其他插件绑定；
- DSH Host 已提供 `agentPresets` registry 和公开 Remote。

runtime 不在支持集合时 Host 返回 typed error（`DSH_PRESET_REGISTRY_UNAVAILABLE` 或
`STUDIO_PRESET_RUNTIME_UNSUPPORTED`）。资源加载、MCP 调用或知识库检索失败则由 Studio
provider 返回 typed runtime error，不会静默回退为默认 DSH Agent。当前已验证模型路由一致时
系统 Prompt 会通过 persona row 进入 DSH composition；资源执行需看对应的工具/检索事件。

### Codex Provider（当前实现）

本地 `runtime: codex` Revision 已接入同一个 preset-scoped provider，但实际模型执行走官方
Codex App Server 的 newline-delimited JSON-RPC：Host 启动 `codex app-server --stdio`，完成
`initialize`、`thread/start` 和 `turn/start` 后，把 `item/agentMessage/delta` 以及 reasoning/plan
增量映射回 DSH `llm/stream` block。每个 DSH turn 使用一个 ephemeral Thread，默认 cwd 为系统临时目录，
因此选择 Agent 不会强制绑定 DSH Workspace；Workspace 仍由 DSH 自己管理文件和命令上下文。

当前 Provider 明确采用无人值守策略（默认 `approvalPolicy=never`），命令、文件变更、权限申请和
交互输入不会被静默批准。Codex 二进制不存在、App Server 提前退出、超时和失败会以
`CODEX_PROVIDER_UNAVAILABLE`、`CODEX_TRANSPORT_*`、`CODEX_TIMEOUT` 或 `CODEX_TURN_FAILED`
返回。DSH 负责外层 Session/历史/渲染，Codex Thread 的长期恢复和跨 turn 原生持久化仍不是本适配器
的承诺；DSH 会话历史会在下一次临时 turn 中作为文本上下文传入。

## 4. 仍然没有解决的事情

### 4.1 Studio Agent ID 不是 DSH preset ID

AgentKit Studio 的 Agent Catalog、Revision 和资源绑定在 KsADK server 侧；DSH Host 的 preset roster 来自本地 profile 的 Cordis composition。除了上面的模型路由一致窄准入以外，当前没有一个公开合同把：

```text
Studio AgentRevision → DSH PresetDefinition → session/create.agentPreset
```

动态地连起来。把资源型 Studio Agent ID 直接当成 preset ID，或在浏览器 localStorage 里做同名映射，都会让 DSH Host 运行默认 composition，属于假绑定。

### 4.2 资源绑定不能靠 preset 字符串自动出现

Studio Revision 中的模型白名单、MCP、Skill、知识库和记忆库是 KsADK 资源合同；DSH preset 的 `plugins` 是 DSH Host 侧的 Cordis 插件声明。两者的类型、权限、生命周期和 secret 归属不同。Studio provider 会把已绑定资源交给 Host-owned Resource Adapter；适配器物化失败时返回 `RESOURCE_*` typed error。preset 字符串本身仍不携带资源 secret，也不能替代真实工具调用或检索事件。

### 4.3 资源型 selector 仍不能验收真实执行

当前 Studio 对话页对资源型 Revision 已调用 Host 准入、`agentPresets.select` 和 provider bridge；本地 Harness 的 Skill/MCP/知识库路径已有单测和本地运行探针。云端资源的授权、secret 解析和生产 MCP/知识库事件仍要按 Server/资源服务的真实凭证补充验收。因此以下结果仍不能单独验收绑定资源后的完整生产执行：

- 下拉框显示了 Agent 名称；
- DSH 原生会话能正常回显；
- KsADK `conversation-surface` 能返回一个 Build；
- session 列表中出现了一个普通会话。

## 5. 下一步 P0 验收合同

必须先选定并实现一个公开 admission/provider 方案，再接 UI：

1. **静态最小闭环**：用一个明确声明的 DSH preset，调用 `ctx.sessions.create({ agentPreset })` 或 `remote.agentPresets.select`，验证 session header/projection 为该 preset，首轮的工具/系统提示确实来自该 composition。
2. **Studio 动态闭环**：AgentRevision 生成可审计的 DSH profile/preset 引用，包含版本、资源快照摘要和能力集合；Session 创建时由 Host 校验该引用，禁止浏览器直接指定任意插件行。
3. **资源闭环**：至少一个 MCP 或 Skill 在真实首轮中被调用，并在 canonical event 中带 `agentId`、`revisionId`、`resourceRefs`；仅“列表里有绑定”不算通过。
4. **恢复闭环**：刷新/重启后从 DSH projection 和 KsADK canonical transcript 恢复同一 Agent Revision；首轮后的 preset 切换必须得到官方 `agent-preset/locked` 或等价 typed error。

Studio 继续把“无 Agent · DSH 原生会话”和“绑定 Agent · DSH 原生 Session + Studio provider bridge”分开显示；Workspace 由 DSH 原生选择器管理，不是 Agent 绑定条件。没有可用 provider 或资源适配器时返回 typed error，不把默认 DSH preset 冒充 Studio Agent。

## 6. 公开 DSH 变更记录

变更位于官方 DSH rc.2 工作树：

- `packages/api/session-controller/src/client/contract/sessions.ts`：`ISessions.create` 接受 `agentPreset`。
- `packages/api/session-controller/src/client/sessions/manager.ts`：将该字段透传至 `remote.session.create`。
- `packages/api/session-controller/src/client/sessions/service.ts`：公开 `ctx.sessions.create()` 便利接口不再丢弃该字段。
- `packages/api/session-controller/tests/sessions-service.client.spec.ts`：增加 wire 透传合同测试。

这四处改动不改变默认无 preset 的行为，也没有改变官方 Host、InputHub 或 Session Controller 的内部执行路径。
