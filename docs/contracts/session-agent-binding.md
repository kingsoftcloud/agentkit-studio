# 会话与 Agent 绑定合同

## 产品决定

一个会话只有一个主执行身份：一个具体的 Agent Revision，或者没有 Agent。
`agentRef` 允许为空；为空时，会话直接使用 DSH 原生会话循环和当前工作区的基础能力。
这让用户可以像使用原始 DSH 一样工作，同时不把 Agent 选择变成发送消息的前置条件。

会话开始后不允许把主 Agent 换成另一个 Agent。需要换执行身份时创建新会话，或者
从当前会话派生一个带新绑定的会话。这样历史消息、模型、工具权限、记忆边界和回放
都有稳定的解释。

多个 Agent 的协作通过 Agent 编排产生子运行。子运行有自己的 `agentRef`、Revision、
资源权限和运行状态；父会话只显示子运行的进度和结果，不把多个 Agent 的事件写成同一
个主 Agent 的事件。

## 绑定层级

| 对象 | 绑定内容 | 生命周期 |
| --- | --- | --- |
| Workspace | 可见资源、组织策略、基础 DSH 能力 | 工作区级，可被多个 Agent 使用 |
| Agent Revision | 模型引用、系统指令、MCP、Skill、知识库、记忆库、权限和运行目标 | 版本化；运行时固定到一个 Revision |
| Session | `agentRef`、`revisionRef`、runtime、workspace、user 和 DSH session id | 创建时确定；发送首条消息后不可变 |
| Schedule | Agent/Revision、触发器、输入模板、Channel、并发和重试策略 | 触发时创建新的 Session/Run |
| Channel binding | Agent/Revision、Channel 凭证引用、路由和幂等策略 | 由 Host/Server 持有凭证和投递状态 |

MCP、Skill、知识库和记忆库的默认绑定属于 Agent Revision。Workspace 可以提供共享
资源目录和策略，但一次运行能实际使用哪些资源，必须经过 Revision 的绑定和权限计算。
定时任务不能只绑定一个裸会话，因为会话是运行实例；它必须绑定 Agent Revision，每次
触发生成一个新的运行实例。

## 三种用户入口的准确含义

1. **无 Agent · DSH 原生会话**：`agentRef = null`，复用 DSH 的 Conversation、Session
   Controller、模型设置和基础工作区能力。
2. **DSH Native Harness Agent**：由 DSH 自己的 Agent Loop、Session、模型和工具注册表
   承载。它直接走 DSH 原生 `session.prompt`，不调用 KsADK `CreateSession/RunAgent`，
   也不需要桥接层。
3. **KsADK Harness Agent（可选适配目标）**：只有当运行目标明确是外部 KsADK Host
   时，才由 Studio 的类型化 `conversation:stream` 合同承载，再用窄适配器把外部事件
   投影回 DSH 会话；产品插件不直接调用旧的 KOP session/run action。
4. **Codex Agent**：由 Codex Runtime Adapter 承载 Thread/Turn/Item，再投影到同一
   Session/Conversation 合同；这和 KsADK 适配是两条独立路径。

“无 Agent”是会话上下文，不是第三个低代码 Agent 类型。当前 Host Runtime Catalog
中的 `adk` 和 `langgraph` 不进入新版 Studio 首期创建器；重新开放前必须有独立的
运行、回放、取消、恢复和资源权限合同证据。

## 不变量

- 未选择 Agent 时可以直接发送消息；UI 不弹出强制 Agent 选择。
- 已发送消息的会话不能切换主 Agent；切换操作引导创建新会话。
- 一个主会话的事件只能归属于一个主 Agent；子 Agent 事件必须带 child run identity。
- Agent Revision 发布后不可原地改变资源绑定；变更创建新 Revision。
- Schedule、Channel 和外部触发不能复用用户手工会话的状态或凭证。
- Renderer 只保存 `agentRef`/`revisionRef` 等非敏感引用；模型密钥、Channel secret 和
  记忆库凭证由 Host/Server 管理。

## 当前实现状态

当前 Studio 已经提供 DSH 原生宿主和本地 Agent Catalog 的创建入口。绑定 Agent 的
执行路线是类型化 `conversation:stream`；Host 负责 Build/Run admission 和 canonical
Session，DSH 仍负责无 Agent 会话的原生渲染、日志和恢复。无 Agent 时仍直接走原生
`session.prompt`。本地 Host 已用官方 `deepseek-harness-sdk` 驱动 rc.2 DSH Native，完成
真实创建后的 Build、surface、SSE 流和 terminal `run.completed` 验证；证据在
`agent-selection-dsh-native-real-2026-09-27.json`。浏览器绑定 Agent 的入口尚未把该 Host
stream 接到官方 composer，因此不能把 composer 的 context 选择器当成执行切换。

对话页的 Agent 选择器通过 DSH Connection 的 `/agentkit` 本地控制通道读取真实 Host
目录，避免 opaque `srcdoc` iframe 的跨域读取失败。它当前显示为 `候选智能体`，选中后
显示 `未绑定当前会话`，只负责在新会话前记录候选 Agent；这个选择不会重新筛选或重建
DSH 左侧本地会话列表，也不会改变已经打开的会话。直到动态 `AgentRevision → DSH
admission/provider` 合同落地，不会把普通
DSH `session.prompt` 误报成绑定 Agent 执行。选择器与 Host 的 catalog 传输已
在 rc.2 浏览器中验证，当前 10 个真实 Host Agent 可列出并可选择；最新目录和选择语义
留存在 [`agent-selection-live-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/agent-selection-live-2026-09-27.json)。
当前页面 AX 核对确认，候选选择不会重建 DSH 左侧会话树；记录见
[`agent-selector-session-scope-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/agent-selector-session-scope-2026-09-27.json)。
选中可读取的 Agent 后，选择器提供“打开绑定对话”动作；该动作切到 Studio 的
Host-owned conversation 并固定这个 Agent，当前 DSH 会话继续保留，不发生隐式动态切换。
要真正选择 Agent 对话，产品入口应从 Agent 卡片/详情打开 Host-owned conversation；当前
Host stream 已经可运行，但该浏览器入口仍是下一项产品收口工作。现阶段不要把对话页下拉框
当成这个入口：它只保存上下文引用，用户若直接发送，仍然是 DSH 原生会话。收口后的明确
路径是“Agents → 选择 Agent → 打开绑定 Agent 对话”，由 Host 创建/恢复该 Agent 的
canonical Session，并将输入提交到 `conversation:stream`；无 Agent 的“新会话”继续走
DSH 原生 composer。这样选择动作与执行目标一一对应，不会把三种 runtime 的事件混到同一
个 DSH session log。

Agent Teams 已在 AgentKit 的 rc.2 profile 中默认装载并通过官方 116/116 测试和 1/1
headless E2E；Studio 对话中真实完成了 `list_agents` 和 `spawn_teammate`。该默认范围是
AgentKit profile，不扩展为所有 DSH profile；只有 DSH Native 的普通会话已验证到 Team
工具。Codex/KsADK 绑定 Agent 的 Teams 能力还要分别通过其运行时合同验证，当前不能在
它们的 Agent 卡片上显示“Teams 已可用”。KsADK Host 的 `/api/v1/plugins/teams/lifecycle`
当前还返回 `available=false`、`health=failed`、`reason=authority_profile_unavailable`，
因此 Host 侧也不能宣称默认启用；该失败证据记录在
[`verification-rerun-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/verification-rerun-2026-09-27.json)。

创建入口收敛为两个明确的产品动作：Agents 独立页的“快速创建”只创建最小 Blank
Revision，“一键创建”使用内置模板（当前包含 Blank 和 Research）。资源绑定不再阻塞
创建流程；模型、MCP、Skill、知识库和记忆在资源页或 Agent 详情中绑定。对话页的自然
语言 Agent 编排和定时任务编排可以生成同样的 Host-owned Revision/Schedule，但不能
另建一套浏览器本地状态。

官方 `deepseek-harness-sdk` 可以作为 DSH Native Agent 的进程间运行时入口，但它
不会自动完成 Studio Revision 装配或 KsADK canonical Session 写入。采用 SDK 时仍需
由 Host adapter 负责 profile/preset、事件映射、取消/恢复和资源绑定。详细能力、限制
和验收顺序见 [`dsh-sdk-runtime-decision.md`](./dsh-sdk-runtime-decision.md)。当前版本
已经用官方 mock SSE smoke 验证 SDK 的真实流式协议和 DSH 日志落盘，但这不是 Studio
Agent 的端到端创建/绑定/对话验收；服务端审批请求也尚未由固定协议发出。
