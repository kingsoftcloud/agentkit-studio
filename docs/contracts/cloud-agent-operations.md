# 云端 Agent 的渠道与定时任务

## 最新预发验收（2026-10-09）

KOP 七个调度 Action 已开放并通过真实子账号验收；下文先前记录中的未注册门槛已解除。
在已有 Studio DSH Native 部署上创建禁用的单次测试计划，核对查询与修改，然后立即运行。
云端 Worker 完成知识库原文检索，记录 `succeeded` 与真实 Response ID，最后删除计划并确认
列表不再包含它。七个 Action 均经过公开 KOP，未使用内部 API 代替产品入口。

执行记录 `occ-a1581ed877494f569a6736d0a613de21` 从 04:24:46 UTC 到 04:24:55 UTC 完成。
本次只保存执行记录，没有配置或发送渠道消息；不能用此项覆盖真实 IM 投递验收。

## 产品入口

- 运行中心 → Channels：按名称选择本地 Agent 或其云端部署。仅展示当前凭证范围内、具有 Studio 部署记录的目标。
- 本地渠道需要 Connector 和运行中的设备；云端渠道清空 `ConnectorWorkspaceId`，由独立 Channel Worker 调用 Server `RunAgent`，不经过桌面。
- 运行中心 → 自动化：本地与云端部署分 Tab。云端计划由 Server 保存和执行，支持创建、修改、暂停/恢复、删除、立即运行和执行记录。
- 渠道负责消息收发，定时任务负责触发执行。新建/编辑云端计划时，可选择“仅保存执行记录”或“发送到渠道会话”。投递需要明确选择一个已绑定的 WPS/飞书会话，不会因为 Agent 有渠道就自动群发。
- 执行记录分别显示读取中、读取失败和真正的空记录。任务详情与展开记录按 Agent、任务隔离；切换任务、关闭详情或切换本地/云端后，旧请求不得覆盖当前记录。部分任务读取失败时保留其余记录并提示不完整。
- 页面可见时，到点任务、执行中任务及待投递结果会自动刷新。未到点任务不会每五秒重新查询记录，慢请求不叠加；后台刷新保留编辑草稿，并同步已打开的任务详情。页面刷新只读状态，不承担触发执行。

## 复用合同与身份

云端计划复用 `CreateAgentSchedule`、`ListAgentSchedules`、`GetAgentSchedule`、
`UpdateAgentSchedule`、`DeleteAgentSchedule`、`RunAgentSchedule` 与
`ListAgentScheduleOccurrences`。Node Host 经 KOP 签名调用，写操作核验子账号；
不让浏览器提供创建者身份。任何任务修改前先核对任务的 Agent 与当前部署归属。
更新带 `ExpectedRevision`，避免覆盖其他窗口的修改。

KOP 必须为 API `2024-06-12` 发布上述七个调度 Action，并配置对应预发后端路由及 IAM 权限。
Server 有 REST 路由不代表 KOP 已开放。返回 `InvalidActionOrVesion` 时明确显示缺少的 Action，
不降级直连 Server，也不改用本地主账号或本地计时器。

| KOP Action | Studio 用途 |
| --- | --- |
| `CreateAgentSchedule` | 创建云端定时任务，可指定渠道结果投递 |
| `ListAgentSchedules` | 按 Agent 查询任务目录及调度可用性 |
| `GetAgentSchedule` | 查询任务详情 |
| `UpdateAgentSchedule` | 修改配置、暂停和恢复；携带 `ExpectedRevision` |
| `DeleteAgentSchedule` | 删除任务，保留既有执行记录 |
| `RunAgentSchedule` | 手动立即执行 |
| `ListAgentScheduleOccurrences` | 查询执行状态、最终文本和渠道投递状态 |

Server 后端 Action 路由为 `POST /agentengine/api/v1/<Action>`，请求模型位于
`app/api/v1/actions/schedule_actions.py`。注册时需保留租户和子账号身份，并同时配置 IAM
访问权限；暂停/恢复复用 `UpdateAgentSchedule.Enabled`，无须另加两个接口。预发 Server
还需启用调度 Worker 与 Responses 合同，投递渠道时启用 `ChannelOutbox/v1`。
2026-10-09 注册前的只读复查：`ListAgentSchedules` 返回
`SERVER_ACTION_NOT_REGISTERED`（HTTP 400）；没有发起调度写操作。
云端创建、升级/回滚、查询和删除复用既有部署 Action，上传当前走 Host 私有 KS3 直传，
这七个调度 Action 是当前产品入口的必补项。

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

## 注册前验收记录

以下 KOP 未注册结论为历史记录，已由顶部最新验收替代；其余渠道与资源边界仍按各项记录核对。

- 自动化页面状态修复（2026-10-09）：8 个新增回归覆盖到点刷新、草稿保留、慢请求不叠加、任务切换/关闭/跨执行位置、详情同步终态及失败后恢复；完整 `make release-check` 519 项通过，插件完整性及 18 个补丁格式检查通过。隔离的真实 DSH Web 页面使用受控 RPC 响应验证失败提示、晚到结果隔离、自动刷新保留草稿和部分记录失败；没有创建计划或发送消息，该项只是页面行为验收。同期使用已核验子账号真实复查 KOP，`ListAgentSchedules` 仍返回 `SERVER_ACTION_NOT_REGISTERED`。
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
- 后续真实 WPS 验收已补齐，见下文；真实飞书收发、三种运行时完整资源组合及 KOP 调度入口仍未通过。代码、页面和合成平台事件不能替代这些验收。

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

## WPS 真实收发与定时投递（2026-10-09）

真实平台联调发现预发节点的网络分区：普通节点能访问 Redis，但 WPS 公网 HTTPS/WS 连接超时；
专用渠道节点能访问 WPS 和内部 Channel API，却不能直连 Redis。Worker 现通过经过内部令牌鉴权的
Channel API 管理租约，Redis 保留原子持有者校验。专用节点上的真实 WPS 握手和持续续租均已通过，
没有取消锁或跳过 TLS。连接状态也不再把重连误报为已连接。

真实消息进一步暴露并修复了两处问题：

- WPS 主动发送应调用 `/v7/messages/create` 并显式提供 receiver；原路径返回 404。
  主动发送及引用回复均按实际请求字节添加 KSO-1 签名，保留 OAuth 和业务成功码校验。
- 配对到期时间使用带时区对象写入 PostgreSQL 的无时区字段，导致真实入站请求返回 500。
  已与审批时间统一为 UTC 无时区存储；新增在 flush 前检查时间兼容性的回归，避免 SQLite 隐式转换掩盖问题。

最终 Channel 完整回归 **396 项通过**。预发 API/Worker 镜像为
`sha256:35fa910bcafe643e295cdf9e74ca087d6748390cefc06db53deb2d9281e294d5`，
两端各十个改动源码的 SHA-256 均与测试 checkout 一致。

验收使用独立、经 KOP 子账号创建的 Harness 冻结 Agent 和用户授权的测试机器人单聊；
隔离 Studio Host 全程停止，日常 Host 未改动：

1. 用户侧通过 WPS 官方 deeplink 发出普通算术消息，消息历史确认发送者和内容；云端 WebSocket 收到事件后创建真实配对请求。
2. 核对实际单聊收到的配对码与数据库哈希一致，再以已核验子账号批准。WPS 事件中的用户 ID 是应用标识，不等同于用户侧内部 ID，不以猜测的 ID 批准。
3. 删除早期定时发送测试的预置 binding，确认列表为空后继续真实消息测试；配对批准后的新消息自动建立 binding，调用云端 Agent 并回复一次。
4. `35 + 16` 回复 51；下一轮仅要求把上题答案乘以 2，回复 102。两轮均带回只写在冻结 system prompt 中的标记，用户输入不包含角色、标记或答案。
5. 选择这条真实入站建立的 binding 创建单次计划，普通算术任务回复 55。Server 记录 `succeeded` 与 `delivered`；WPS 历史中只有一条与保存结果完全一致的消息。没有模拟发送器，也没有由桌面代跑。

早期 404 用例只重试了已确认未发送的原 outbox，没有重跑 Agent；原执行记录仍保留失败投递状态，
不将人工补发宣称为 UI 自动恢复。之后的独立计划验证了全自动送达，最终用例使用真实入站绑定。

边界仍需明确：**计划经受控内部 API 创建，KOP 七个调度 Action 尚未发布**。
本轮复查仍返回 `SERVER_ACTION_NOT_REGISTERED`，Studio 产品入口不能创建云端计划，未绕过此限制。
上述批次只覆盖 Harness；随后补齐 DSH Native 和 Codex 的真实 WPS 知识库、续聊及定时投递，
详见[三运行时渠道验收](wps-runtime-acceptance-2026-10-09.md)。飞书、企业微信确认机制及完整资源组合仍需分别验收。

验收后已停用并软删除三个测试计划，删除隔离 Channel 配置、凭证、绑定及测试数据库行；独立测试 Agent 经 KOP 删除，Namespace、PVC 和 PV 已确认回收。WPS 应用与实际单聊消息保留供用户核对，日常 Studio Host 未改动；最终账单结算不在本次证明范围。Channel 修复已提交 `630c9dd`（配对/发送）与 `d521f7f`（专用节点/API 租约）。
