# 云端 Agent 的渠道与定时任务

## 产品入口

- 运行中心 → Channels：按名称选择本地 Agent 或其云端部署。仅展示当前凭证范围内、具有 Studio 部署记录的目标。
- 本地渠道需要 Connector 和运行中的设备；云端渠道清空 `ConnectorWorkspaceId`，由独立 Channel Worker 调用 Server `RunAgent`，不经过桌面。
- 运行中心 → 自动化：本地与云端部署分 Tab。云端计划由 Server 保存和执行，支持创建、修改、暂停/恢复、删除、立即运行和执行记录。
- 渠道负责消息收发，定时任务负责触发执行。新建/编辑云端计划时，可选择“仅保存执行记录”或“发送到渠道会话”。投递需要明确选择一个已绑定的 WPS/飞书会话，不会因为 Agent 有渠道就自动群发。

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

渠道投递与 Agent 执行状态分开处理。Worker 按租户、渠道和机器人账号选择仍持有租约的连接，
数据库原子领取到期重试；没有连接时保留待重试，不返回假成功。明确未发送的连接失败可退避重试，
发送结果不确定时记为 `unknown`，不自动重复发送。发送后的审计写入失败也不触发重发。
WPS、飞书还校验 HTTP 响应中的业务成功码；企业微信的 WebSocket 请求关联确认仍待补齐。

Server 需要包含 `agentkit.responses/v1` 调度适配，并启用 `CLOUD_SCHEDULER_ENABLED`。
旧 Server 即使能保存任务，Studio 也不会把它当作支持新运行时：缺少
`Availability.RuntimeContracts` 声明时拒绝创建和立即运行，保留查询和清理操作。

## 版本、资源与故障

运行时读取已部署冻结包中的 Prompt、模型、MCP、Skill、知识库、记忆库等资源，
渠道和定时任务不自行组装另一套 Agent。计划触发时使用当前部署版本。
已有会话的上一轮响应句柄不能跨冻结版本复用；升级后需要新的渠道会话。
资源凭证、运行时工具和沙箱能力仍受部署版本本身的限制。

渠道用户可发送 `/reset` 开启新会话。Channel 原子地更换会话 ID、清空上一响应 ID，
保留 peer binding 与人工接管关联；确认新会话后才回复重置成功。旧轮次晚到的结果不能
覆盖新会话的续聊句柄，保存失败也不能当作正常续聊。不自动重跑可能已执行的资源调用。

Channel 的 PostgreSQL 持久化与 Agent 容器的对话状态是两层存储。Studio 新部署默认请求
20 GiB 持久卷，Server 保留 Harness/Codex Container 的显式存储配置；旧环境未声明支持时
在创建前拦截。选择临时存储的实例重建后会丢失历史，渠道保存响应 ID 不能弥补这项缺失。
实际挂载及容器重建后的续聊需要独立验证，不能用 Channel 进程重启结果替代。

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
- Channel 会话管理：324 项自动化检查通过，覆盖跨账号修改/删除拒绝、原子重置、旧轮次回写拦截和重置失败提示；独立预发 API 对真实 PostgreSQL 的重置、续聊句柄清理与账号隔离也已验证。该验证不发送真实平台消息。
- Channel 投递修复：`agentengine-channel` 提交 `674af10`，完整回归 366 项通过；预发 API/Worker 均更新到镜像 `sha256:21b82804266d6e83b144a04816030be8a5d541f68b42364a000001c5a2d86b2d`。真实 PostgreSQL、Redis 与 Channel HTTP API 验证并发领取仅一个成功、租约续期及接替保护、审计失败/确认丢失不重发、缺少适配器不误报成功。发送器为隔离模拟，真实 IM 消息数为 0；测试表、key、outbox 和审计行均清理。这是此前的基础修复；本次计划投递扩展见下文。
- 持久化联调：三种运行时已通过真实容器替换后的原响应重放与历史续聊；Harness 另通过合成渠道事件 → 真实 Channel/Server → 云端模型的重建后续聊和重复事件去重。详见[持久化验收](cloud-storage-acceptance-2026-10-09.md)。
- 资源与版本联调：三种运行时独立知识库盲测通过；Harness 的同一渠道绑定在升级移除知识库、回滚恢复知识库后，新会话均使用对应冻结资源，重复事件只回复一次。详见[资源隔离验收](cloud-resource-isolation-2026-10-09.md)。该渠道入口仍为合成消息。
- 阻塞：当前预发 KOP 对 `ListAgentSchedules` 返回 `InvalidActionOrVesion`，Studio 云端计划入口尚不可用，需发布调度 Action。
- 尚未完成：真实机器人收发、三种运行时完整资源组合，以及计划结果向真实 WPS/飞书会话投递。代码、页面和合成平台事件不能替代这些验收。

## 计划结果投递扩展（2026-10-09）

- Server 在同一事务保存执行成功与最终文本，另一个 Worker 将结果送入 Channel；重启后从数据库恢复待投递项。发送失败不重新运行 Agent。
- 任务保存渠道配置与会话引用，触发时冻结目标。旧任务编辑时省略投递字段保留配置，显式清除只影响之后的触发。暂停/删除任务只停止未来触发，已触发执行和投递继续。
- Channel 校验同租户、同 Agent、同机器人和实际会话；在入队及领取发送时检查。更换机器人 App ID、会话、换绑 Agent 或删除渠道都会拦截待发结果。WPS 老绑定需收到一次新消息以记录实际 chat ID。
- 同 occurrence 并发/超时重试只生成一个 outbox；发送后确认不明记为“送达结果待确认”，不自动重复发送。执行状态、渠道投递状态和已保存结果分别展示。
- 新 Server 通过 `Availability.DeliveryContracts: ["ChannelOutbox/v1"]` 声明能力。需配置私有 Channel 地址和共享内部令牌；旧服务不会被 UI 当成已支持投递。企业微信目前不开放此选择。
- 验证：Studio 502 项检查通过；Server 调度、对话与创建产品相关测试 89 项通过；Channel 380 项通过。真实 PostgreSQL 上 20 次并发结果交接只有一个 outbox，20 个领取者只有一个成功，测试 schema/key 已清理，未发送真实 IM 消息。
- 真实浏览器已确认云端任务页准确提示 KOP 缺少 `ListAgentSchedules`，无法创建时禁用按钮；没有使用本地计时器或直连 Server 掩盖产品入口的缺口。

预发内部链路验证已通过：独立子账号经 KOP 部署测试 Agent 后，使用受控内部 API 创建单次计划，关闭隔离 Host。Server 自动执行普通算术问题；最终文本含仅写在冻结 system prompt 中的标记并给出正确答案。独立 Channel Worker 将完全相同的已保存结果发送到模拟会话；同轮只有一个 occurrence、一个 outbox、一个 outbound audit。重复交接返回同一已送达记录，其他租户查询返回 404。**模拟适配器，真实 IM 消息为 0**；这不等于 KOP 调度入口或真实 WPS/飞书通过。

过程中还验证了实际故障恢复：Worker 的旧专用节点约束使该节点无法访问 Redis，结果停在 `queued`。按仓库现行 `deploy/pre/channel-worker.yaml` 清除残留的节点选择与 toleration 后，Worker 在可达节点恢复租约并补发原结果一次，Agent 未重跑。Redis 校验、持有者续租和内部鉴权均保留。后续若重新启用专用节点池，需要先验证到 Redis 的路由。

最终预发镜像：Server `sha256:4b1a5dceea445a87725857b55c4e4e2f91bc93b7d2694d4b3f88a06fbd88e985`；Channel API/Worker `sha256:2bc855bd555420586f4292e071adb8f5b85ef689d04c3c343801b7da0e30136f`。已核对线上 Server 两副本各 8 个文件、Channel 各 14 个文件的 SHA-256。首次镜像叠加未带入改动的尝试已排除并清理，不能用其 rollout 成功充当功能验收。

验收后已停用并软删除测试计划，清理隔离渠道配置、凭证、绑定及测试投递记录；独立测试 Agent 已确认 `DELETED`。持久卷及计费清理仍需单独核对。
