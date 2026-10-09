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

当前 Studio 已经提供 DSH 原生宿主和本地 Agent Catalog 的创建入口。Agents 页的“绑定到新
会话”通过 Host `agents/ensure-preset` 创建/注册 Revision preset，调用公开
`agentPresets.select`，再由 `uiWorkspace.openSession` 打开 DSH 原生 Conversation。无
Agent 时仍直接走原生 `session.prompt`；Harness、Codex 和资源型 Revision 在同一 DSH
Session/Loop 中由 preset-scoped `llm/stream` provider bridge 委托给 Studio transport。
Workspace 选择仍是 DSH 原生 composer 的独立上下文，不是 Agent 绑定条件；已有 Agent
Session 在未选择 Workspace 时也可以直接发送，Workspace 只在需要 cwd、文件和工作区工具
时作为额外上下文加入。

对话页的 Agent 选择器通过 DSH Connection 的 `/agentkit` 本地控制通道读取真实 Host
目录，避免 opaque `srcdoc` iframe 的跨域读取失败。它仍只允许在空白会话首轮前切换
Agent；首轮后由 DSH preset registry 锁定。选择器与 Host 的 catalog 传输已在 rc.2 浏览器
中验证，当前 10 个真实 Host Agent 可列出并可选择；最新目录和选择语义留存在
[`agent-selection-live-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/agent-selection-live-2026-09-27.json)。
当前页面 AX 核对确认，候选选择不会重建 DSH 左侧会话树；记录见
[`agent-selector-session-scope-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/agent-selector-session-scope-2026-09-27.json)。
选中可读取的 Agent 后，选择器提供“绑定到新会话”动作；该动作创建新的 DSH Session、
在首轮前固定 Agent preset，然后直接打开官方 Conversation。它不会进入 Studio 自定义
聊天页，也不会为 Agent 自动创建或切换 Workspace；用户仍可使用 DSH 原生 Workspace
选择器。这样选择动作与执行目标一一对应，不会把三种 runtime 的事件混到同一个 DSH
session log。

Agent Teams 随官方 DSH CLI 提供，但默认关闭。当前固定的 DSH 0.2.0-rc.2 和 Studio
`make profile-install` 从官方 Web profile 初始化，不自动加入 Teams bundle；可在插件市场
启用官方 `@deepseek-ai/dsh-experimental-agent-team-profile`，同时加载工具和团队界面。
开启会替换普通 subagent 委派工具，不能据此宣称 Codex、AgentKit Harness 或云端也已具备
同样的 Teams 能力，这些路径仍需独立验收。

历史验收（2026-09-27）曾在临时 AgentKit 0.1.7-rc.2 profile 默认装载 Teams，并通过官方
116/116 测试和 1/1 headless E2E；Studio 普通 DSH 对话真实完成 `list_agents` 和
`spawn_teammate`。该结果不代表新版发布 profile 默认开启。同期 KsADK Host Teams lifecycle
返回 `available=false`、`health=failed`、`reason=authority_profile_unavailable`；历史失败证据见
[`verification-rerun-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/verification-rerun-2026-09-27.json)。

创建入口收敛为“对话创建”和“手动配置”。对话创建通过官方 `uiWorkspace.openWorkspace`
打开新的无工作区会话，清空该新会话的 Agent 绑定及侧栏 Agent 筛选，再向原生输入框填入
创建引导；不自动发送消息，不修改原会话。多轮讨论逐步澄清用途、提示词和资源，持续更新
Host 草稿，用户明确确认后才创建 Revision。手动配置直接填写同样的字段，Blank 和 Research
提示词模板放在可选折叠区。模型、MCP、Skill、知识库和记忆在创建或编辑页绑定，资源库仅
管理资源生命周期。两种创建方式复用同一个 Host-owned Agent/Revision 事实源。

官方 `deepseek-harness-sdk` 可以作为 DSH Native Agent 的进程间运行时入口，但它
不会自动完成 Studio Revision 装配或 KsADK canonical Session 写入。采用 SDK 时仍需
由 Host adapter 负责 profile/preset、事件映射、取消/恢复和资源绑定。详细能力、限制
和验收顺序见 [`dsh-sdk-runtime-decision.md`](./dsh-sdk-runtime-decision.md)。当前版本
已经用官方 mock SSE smoke 验证 SDK 的真实流式协议和 DSH 日志落盘，但这不是 Studio
Agent 的端到端创建/绑定/对话验收；服务端审批请求也尚未由固定协议发出。
