# 产品组合复核：2026-09-24

## 结论

继续验证 DSH Native，但将“复用现成 DSH 应用页面”的假设收紧为“复用 DSH 宿主、会话和工作台机制，由 Studio 拥有产品组合”。当前是 P0 验证工程，尚不能认定最终架构通过。侧栏换标与页面能打开不足以证明模型配置或真实会话已接通。

新工程继续采用 Node/TypeScript。旧 Python Studio 仅作为领域行为和协议参考；Python 可作为某类 Agent 的外部运行时，不是新 Studio 应用的强制启动依赖。

新版 Studio 首期保留三类低代码 Agent 运行目标：DSH Native、DSH-backed Harness 和 Codex Runtime；同时提供一个不绑定 Agent 的 DSH 原生会话入口。DSH Native 首期只承诺无资源的最小执行闭环，资源声明由 Host 明确 fail closed。KsADK 的 ADK、LangGraph 运行时仍可存在于 Host 的通用能力目录，但不进入 Studio 首期 Agent 创建器、运行时选择器或产品导航；只有出现明确场景和完整适配证据时才重新开放。

会话产品合同见 [`session-agent-binding.md`](./session-agent-binding.md)：主会话最多绑定一个 Agent Revision，也可以保持 `agentRef=null`；多个 Agent 通过子运行编排协作。MCP、Skill、知识库和记忆库绑定到 Agent Revision，定时任务绑定 Agent Revision 并在触发时创建新的 Session/Run。

创建器按产品入口收敛为两个动作：Agents 页只做快速创建和一键模板创建；需要描述角色、补充
Prompt、绑定能力或创建定时任务时，回到对话页用自然语言完成。对话编排最终仍调用 Host 的
Agent Revision/Schedule API，并复用同一个 Agent/Revision 事实源；本轮已完成 Agents 页最小
创建闭环，自然语言编排入口列为下一段 P1 工作。

## 已核实的复用边界

| 区域 | 处理方式 | 当前证据与限制 |
| --- | --- | --- |
| 窗口、Profile、插件加载、Host IPC | 复用官方宿主 | Web 已装载；Desktop 完整运行与恢复仍属于 P0 验收 |
| 工作区与会话列表 | 复用官方 UI 和控制器 | 当前页面保留；切换到 KsADK Session provider 后需重验身份、分页和恢复 |
| 输入框、消息、工具、Goal、审批、Dock | 复用官方机制和呈现 | 已用独立 canonical matrix 证明 user、assistant 文本/推理、tool call/result 进入官方 node store；Goal、审批、artifact 等仍保留 opaque carrier，完整 P1 仍未签收 |
| 侧栏、导航、设置容器 | 官方 slot + Studio 内容 | 五个直接导航项和原生设置 section 已验证 |
| DeepSeek Key 自动引导 | Studio profile 关闭官方 credentialOnboarding | 上游提供公开配置，无需改写凭证校验；关闭弹窗不代表模型已配置 |
| 欢迎页 Logo | 官方 conversation.hero.brand.mark | Studio 注册自己的标志 |
| 欢迎标题和预览徽标 | 一个上游窄补丁：conversation.hero.brand.name | 固定版本无此接口，原文案直接写在 HeroShell；补丁保留官方默认行为 |
| Agent 模式菜单/设置 | profile 禁用 ui-agent-preset | 移除 UI 入口；不宣称底层 preset 执行已经移除或改为 Studio Agent |
| 会话内 DSH 模型选择器 | profile 禁用 ui-model-selection | 避免会话页直接暴露 DSH 模型目录；Studio 模型设置完成后再提供 Studio-owned 选择器 |
| 模型管理、首次引导、Agent/Revision 选择 | Studio 产品层负责 | 统一模型设置页和实际执行路由仍未接通，不能将官方模型页换名当成完成 |

## Harness、Codex 与会话回显边界

当前工程的默认宿主确实是固定版本的 DSH/Cordis：Desktop、Desktop Host、Web、Profile、插件装载、Host IPC、Workspace/Session Controller 和官方 Conversation/Dock UI 都由 DSH 提供。这里的“默认”只描述 Studio 的宿主和本地会话承载方式，不代表所有 Agent 都必须使用 DeepSeek 模型，也不代表 Codex 被改造成 DSH Runtime。

Codex 有两条不同的接入路径，不能混用：

| 路径 | 真实 owner | 是否需要本地 npm/CLI | 能力边界 | Studio 处理方式 |
| --- | --- | --- | --- | --- |
| DSH `subagent-codex` | DSH 的 Subagent Provider + Codex App Server | Bundle 会携带固定的 Codex 运行载荷；不是依赖用户手工安装一个 `codex` 命令 | 每次新建隔离 Thread/Turn，返回最终文本；没有持续会话、完整 reasoning/tool 流和回放 | 只能作为可选子 Agent，不作为 Studio 主会话后端 |
| KsADK `CodexRuntimeAdapter` | KsADK Runtime + 官方 Codex App Server transport | 由 `ksadk[codex]` 管理固定 `openai-codex` 依赖/载荷；不安装 DSH CLI，也不复制 Codex 实现 | 可以承载 Studio Agent 的 Thread/Turn/Item、取消、恢复、MCP/Skill/审批等合同，但需要单独跑真实 App Server 验收 | 作为 Studio 的 Codex Runtime Adapter；由 Studio Host 统一模型、权限和 Session 投影 |

当前版本还没有统一：DSH `subagent-codex` 锁定 `@openai/codex@0.153.4`，KsADK 当前工作树的 `codex` extra 锁定 `openai-codex==0.154.0`，部分旧实现说明仍引用 0.147.0。正式接入前必须为 Studio 选定一个经过真实 App Server handshake、Thread/Turn/Item、审批、取消和恢复测试的版本，并把 npm/PyPI 版本、平台载荷、协议 schema 和证据 digest 一起冻结；不能把两个版本当成可互换的“Codex CLI”。

因此当前 P0 的 DSH Native 验证不会被 Codex 替换。正确的组合是“DSH 作为应用宿主，KsADK/Codex 作为一种执行目标”。如果后续要求 Codex 成为默认执行目标，只替换 Runtime/Provider 绑定，不能再复制一套 Desktop、Session Controller 或聊天页面。

DSH 的会话回显插件可以复用渲染能力，但不能直接适配 Codex 原始事件：`ui-conversation` 消费的是 DSH `SessionEventLikeEntry` 和它的 Context/Node assembler；Codex App Server 提供的是 Thread/Turn/Item 事件。Studio 必须维护唯一的 `Codex → ConversationItem/DSH wire event` projector，并明确唯一的持久化 owner。DSH `subagent-codex` 还会主动丢弃子会话的 reasoning、commentary、tool activity 和 workspace diff，所以它不满足完整 Studio 回放，只适合作为 one-shot 子 Agent。

## 评测、观测与 Channel 的可复用范围

固定 DSH 版本自带的可复用能力是“基础设施”，不是完整的产品模块：

| 领域 | 已有可复用能力 | 不能直接声称具备的能力 | 首期归属 |
| --- | --- | --- | --- |
| 会话持久化/回放 | `session-persistence`、`session-projection`、`ui-conversation`、`ui-goal`、`ui-tool`、`ui-workflow-run` | KsADK RuntimeEvent 的完整评测语义、跨 Runtime 统一的历史库 | DSH store + Studio adapter |
| 观测 | `dsh-session-telemetry`、`dsh-session-telemetry-otel`、token meter；可选社区 `@loongsuite/dsh-plugin` GenAI OTLP | Trace Explorer、跨 ADK/LangGraph/Codex 的统一 TraceRef、业务告警和报告 | KsADK canonical events/OTLP；DSH exporter 作为可选 exporter |
| 评测 | DSH 的 `llm-replay`/snapshot 测试支持；社区 `dsh-eval` 可做 benchmark、trace metrics、LLM judge、A/B | 官方 DSH 没有完整 Evaluation 产品页、EvalSet 事实库或云端运行器 | 复用 `ksadk.evaluation`、`TargetRun`、`MetricResult` 和 evaluation API |
| Channel | DSH 官方 schedule 只做 Session-local reminder，明确没有外部 Channel | 官方 DSH 没有可直接安装的飞书/钉钉/企业微信等 Channel 中心 | 复用 KsADK connector/channel 协议；Studio 只做绑定与状态页面 |

社区候选插件必须按固定 DSH commit 重新做 peer 版本、权限、事件映射、失败隔离和卸载回归；它们不能进入默认 Profile，也不能直接写 Studio/Kernel Store。`dsh-eval` 的 Web Dashboard 仍在路线图中，`@loongsuite/dsh-plugin` 解决的是 OTLP GenAI trace 导出，不是 Studio 观测页面。Channel 连接的凭证、签名、outbox、路由和审计也必须由 KsADK Host/Server 持有，不能让一个 DSH UI 插件独占。

## 模型与凭证的唯一来源

1. Studio 模型设置是产品唯一入口，管理 provider、endpoint、model、credentialRef、默认值和连接测试。
2. 凭证存取放在 Node Host 的凭证服务；优先复用 DSH 的 credentials/settings 原语。配置只保存引用，renderer 不保存明文 Key，不复制到第二套配置。
3. 会话创建时解析所选 Agent/Revision 的模型绑定。输入框的模型信息与设置页读取同一份 Host 投影。
4. 只有所选执行目标缺少必需模型配置时才提示，并跳转 Studio 的模型设置。已有可用配置时启动不再弹窗；跳过不等于“已配置”。
5. DSH native、Codex 或 KsADK/云端执行适配器分别声明模型配置能力；已有独立认证的运行时不应被强制要求 DeepSeek Key。
6. 当前验证 profile 仍保留官方 Models 页和 model-selection 服务以保持实验会话的真实状态。它们尚未与 Studio 模型合同统一，发布前必须完成替换/适配和重启验证。

## 全局配置与本地 Agent 状态

Studio Host 现在读取 AgentKit SDK 的共享配置文件 `~/.agentkit/config.yaml`，并保留旧的
KsADK 全局配置作为兼容回退。读取只投影经过 allow-list 的模型、云端控制、评测和 OTLP
字段；明文值不会写入浏览器或复制进 Agent YAML。优先级固定为：本次启动显式覆盖、工作区
`.agentkit/config.yaml`、`~/.agentkit/config.yaml`、进程环境、工作区 `.env`。保存模型凭证时仍
由 Host 凭证服务负责，不能把密钥塞进 Agent 元数据。

Agent 元数据不直接平铺在 `~/.agentkit/agents`。这样会让同一个 Agent ID 在不同工作区冲突，
也会把项目级资源和源代码边界打乱。首选布局是：工作区项目继续保存可提交的 Agent 源文件和
`.agentkit` 运行产物；用户级目录只保存 Studio 注册表、凭证引用、Profile 和无项目的本地
调试 Agent，按工作区稳定 ID 隔离：

```text
~/.agentkit/config.yaml                         # 全局默认值与凭证引用
~/.agentkit/studio/workspaces/<workspace-id>/   # 用户级注册表与本地调试状态
  agents/<agent-id>/                            # 仅无项目/本地调试 Agent
  profiles/<profile-id>/
```

有明确项目工作区时，Agent 的 canonical metadata 仍在该工作区的 `agents/<agent-id>`，全局目录
只做索引和恢复入口；没有项目的临时 Agent 才落到上述全局 workspace state。这样既能做到打开
Studio 自动恢复全局配置，也不会让两个项目的同名 Agent、Session、资源绑定互相污染。把现有
全量 Repository 迁移到全局目录属于后续存储层改造，必须先完成 workspace-scoped registry、
迁移/回滚和并发锁测试，不能仅改一个默认路径。

## 接下来先做的验证

1. 冻结 ModelConfigPort 和 CredentialRef 合同，完成 Studio 模型设置 → Host 保存/测试 → 重启恢复 → 会话实际使用同一模型的闭环。
2. 用 Studio Agent/Revision/Target 创建会话，证明发送、流式接收、取消、刷新恢复走同一 Session owner；不依赖隐藏的 DSH 默认 preset。
3. 先用 DSH Native Harness 完成 P0 真实会话，再接入 `CodexRuntimeAdapter` 的 Thread/Turn/Item 投影；证明两种 Runtime 都能进入同一 ConversationItem/SessionPort 合同，避免先做一套伪统一 UI。ADK/LangGraph 不进入首期验收矩阵。
4. 完成 P1 独立 fixtures、DSH node store 映射和 Desktop/Dock 恢复；随后接入 `studio-evaluation`、`studio-observability` 和 `studio-channel` 的 Host/Server adapter 页面。

若这两条核心闭环要求长期替换 Session Controller、维护第二套状态机或持续修改上游业务内部，则当前复用方案不成立，需重新选择接入边界。一个品牌 slot 补丁尚不足以推翻方案；真实会话和模型闭环才是决定性证据。

## 补丁维护

`patches/dsh-v0.1.7-rc.2/` 保存固定 DSH `0.1.7-rc.2` 的有序补丁集，基线为 commit
`477b4f420553e8a52c2fbccc464d7561b239c443`。补丁只覆盖品牌 fallback、思考态/输入占位文案和动态侧栏生命周期，不改输入框、会话控制器或执行循环。

补丁按版本目录隔离；不同 DSH 版本不得共用或覆盖同一目录。上游提供等价公开扩展点后删除对应补丁，Studio 注册迁移到官方接口；每次升级复跑 fallback、品牌替换、输入框保留和浏览器重启检查。

恢复构建：阅读 `patches/dsh-v0.1.7-rc.2/README.md`，先执行所有补丁的 `git apply --check`，再按数字顺序应用并运行 Web/Desktop 构建。已应用的 checkout 不应重复应用。
