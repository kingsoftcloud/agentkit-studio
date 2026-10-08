# 云端 Agent 的渠道与定时任务

## 产品入口

- 运行中心 → Channels：按名称选择本地 Agent 或其云端部署。仅展示当前凭证范围内、具有 Studio 部署记录的目标。
- 本地渠道需要 Connector 和运行中的设备；云端渠道清空 `ConnectorWorkspaceId`，由独立 Channel Worker 调用 Server `RunAgent`，不经过桌面。
- 运行中心 → 自动化：本地与云端部署分 Tab。云端计划由 Server 保存和执行，支持创建、修改、暂停/恢复、删除、立即运行和执行记录。
- 渠道负责消息收发，定时任务负责触发执行。定时任务结果不会因为绑定了渠道就自动群发；自动推送到指定会话还需要独立的投递目标与授权设计。

## 复用合同与身份

云端计划复用 `CreateAgentSchedule`、`ListAgentSchedules`、`GetAgentSchedule`、
`UpdateAgentSchedule`、`DeleteAgentSchedule`、`RunAgentSchedule` 与
`ListAgentScheduleOccurrences`。Node Host 经 KOP 签名调用，写操作核验子账号；
不让浏览器提供创建者身份。任何任务修改前先核对任务的 Agent 与当前部署归属。
更新带 `ExpectedRevision`，避免覆盖其他窗口的修改。

KOP 必须为 API `2024-06-12` 发布上述七个调度 Action，并配置对应预发后端路由及 IAM 权限。
Server 有 REST 路由不代表 KOP 已开放。返回 `InvalidActionOrVesion` 时明确显示缺少的 Action，
不降级直连 Server，也不改用本地主账号或本地计时器。

Channels 仍使用独立 Channel API 的连接配置和授权，不冒充已接入 KOP。
绑定云端目标时，Host 核对渠道账号与 AK/SK 经 IAM 核验的所属账号一致，
将已核验的子账号 UUID 传入创建者 Header；凭证保留在 Host。
Channel Worker 将稳定事件 ID 转成 `InvocationId`，多轮使用标准 `PreviousResponseId`。
只有收到 `response.completed` 才允许把本轮标记成功；断流、失败、取消均不能发送部分结果冒充成功。

Server 需要包含 `agentkit.responses/v1` 调度适配，并启用 `CLOUD_SCHEDULER_ENABLED`。
旧 Server 即使能保存任务，Studio 也不会把它当作支持新运行时：缺少
`Availability.RuntimeContracts` 声明时拒绝创建和立即运行，保留查询和清理操作。

## 版本、资源与故障

运行时读取已部署冻结包中的 Prompt、模型、MCP、Skill、知识库、记忆库等资源，
渠道和定时任务不自行组装另一套 Agent。计划触发时使用当前部署版本。
已有会话的上一轮响应句柄不能跨冻结版本复用；升级后需要新的渠道会话。
资源凭证、运行时工具和沙箱能力仍受部署版本本身的限制。

Server 在调用 Studio Responses 前持久化执行记录并核对领取租约。
最多等待 300 秒；未确认完成或进程中断时标记结果未知并暂停后续触发，
不会换入口重复执行。需要核对历史后再恢复。此机制不等同于运行中任务跨 Pod 自动恢复。

## 本轮验收边界

- Studio 单元/合同检查：任务归属、子账号签名、旧 Server 能力拦截、编辑版本冲突、云端渠道路由和账号一致性。
- Server：持久化与租约、进程中断不重放、身份传播、失败 SSE，及原有对话回归。
- Channel：Responses 续接、完整终态与失败事件，以及既有渠道回归。
- 真实 DSH 页面：两个自动化 Tab、云端空态、渠道目标选择；使用隔离 Host，未修改日常工作实例。
- 预发 Server：固定镜像更新后，已通过内部 API 创建单次计划，由云端 Worker 自动执行并持久化 `succeeded` 终态、响应 ID 和已核验的子账号 UUID。测试 Host 未启动；该测试不等于 KOP 产品入口通过。
- 预发 Channel：补齐 PostgreSQL 持久化、RESP2 连接及 256 字符续聊 ID；已用合成渠道事件调用真实 Server 和云端模型，验证盲测系统提示词、完整响应、重复事件去重；重启 API/Worker 后仍延续同一会话并找回上一轮暗号，暂停、恢复与删除行为也已通过。真实平台消息收发单独验收。
- 阻塞：当前预发 KOP 对 `ListAgentSchedules` 返回 `InvalidActionOrVesion`，Studio 云端计划入口尚不可用，需发布调度 Action。
- 尚未完成：真实机器人收发、三种运行时完整资源组合，以及定时任务结果投递到指定渠道。代码、页面和合成平台事件不能替代这些验收。
