# DSH rc.2 Agent preset admission audit

> 状态：窄合同已补齐，Studio Agent 的动态绑定执行仍未签收。本文记录公开接缝和停止条件，不能用来验收“选择一个 Studio Agent 后对话已经由它执行”。

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
- 这条边界适合静态 profile preset 和后续正式的 Studio admission/provider 实现，也适合先做一个最小“无资源 DSH Native Agent”验证。

## 3. 仍然没有解决的事情

### 3.1 Studio Agent ID 不是 DSH preset ID

AgentKit Studio 的 Agent Catalog、Revision 和资源绑定在 KsADK server 侧；DSH Host 的 preset roster 来自本地 profile 的 Cordis composition。当前没有一个公开合同把：

```text
Studio AgentRevision → DSH PresetDefinition → session/create.agentPreset
```

动态地连起来。把 Studio Agent ID 直接当成 preset ID，或在浏览器 localStorage 里做同名映射，都会让 DSH Host 运行默认 composition，属于假绑定。

### 3.2 资源绑定不能靠 preset 字符串自动出现

Studio Revision 中的模型白名单、MCP、Skill、知识库和记忆库是 KsADK 资源合同；DSH preset 的 `plugins` 是 DSH Host 侧的 Cordis 插件声明。两者的类型、权限、生命周期和 secret 归属不同。当前 DSH Native Runtime Adapter 对带 MCP/Skill/Tool/platform resource 的 Build 会 fail closed（`DSH_NATIVE_RESOURCE_ADAPTER_UNAVAILABLE`），因此一次普通 DSH 回显不能作为资源已经生效的证据。

### 3.3 不能用当前 selector 验收

当前 Studio 对话页的 Agent selector 只保存 Agent 上下文；虽然 DSH 的 `ctx.sessions.create({ agentPreset })` 已经可以合法透传，但 selector 尚未把 Studio Agent Revision 解析为 DSH Host 注册的 preset，也没有调用 `agentPresets.select` 或带 preset 的会话创建。因此以下结果都不能验收绑定 Agent 执行：

- 下拉框显示了 Agent 名称；
- DSH 原生会话能正常回显；
- KsADK `conversation-surface` 能返回一个 Build；
- session 列表中出现了一个普通会话。

## 4. 下一步 P0 验收合同

必须先选定并实现一个公开 admission/provider 方案，再接 UI：

1. **静态最小闭环**：用一个明确声明的 DSH preset，调用 `ctx.sessions.create({ agentPreset })` 或 `remote.agentPresets.select`，验证 session header/projection 为该 preset，首轮的工具/系统提示确实来自该 composition。
2. **Studio 动态闭环**：AgentRevision 生成可审计的 DSH profile/preset 引用，包含版本、资源快照摘要和能力集合；Session 创建时由 Host 校验该引用，禁止浏览器直接指定任意插件行。
3. **资源闭环**：至少一个 MCP 或 Skill 在真实首轮中被调用，并在 canonical event 中带 `agentId`、`revisionId`、`resourceRefs`；仅“列表里有绑定”不算通过。
4. **恢复闭环**：刷新/重启后从 DSH projection 和 KsADK canonical transcript 恢复同一 Agent Revision；首轮后的 preset 切换必须得到官方 `agent-preset/locked` 或等价 typed error。

在第 2 项合同落地前，Studio 应继续把“无 Agent · DSH 原生会话”和“绑定 Agent · KsADK canonical conversation”分开显示，绑定入口 fail closed，不把当前 DSH 默认 preset 冒充 Studio Agent。

## 5. 公开 DSH 变更记录

变更位于官方 DSH rc.2 工作树：

- `packages/api/session-controller/src/client/contract/sessions.ts`：`ISessions.create` 接受 `agentPreset`。
- `packages/api/session-controller/src/client/sessions/manager.ts`：将该字段透传至 `remote.session.create`。
- `packages/api/session-controller/src/client/sessions/service.ts`：公开 `ctx.sessions.create()` 便利接口不再丢弃该字段。
- `packages/api/session-controller/tests/sessions-service.client.spec.ts`：增加 wire 透传合同测试。

这四处改动不改变默认无 preset 的行为，也没有改变官方 Host、InputHub 或 Session Controller 的内部执行路径。
