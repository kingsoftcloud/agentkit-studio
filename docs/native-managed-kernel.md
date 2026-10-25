# Server 命令与 Node Native 执行

本模块将已准入的 Server 命令交给现有 TypeScript `NativeKernel`，由它负责完整模型、
工具、预算、重试、租约和恢复。DSH 不参与这条路径的执行循环。已有的本地 Studio
`runtime.type="harness"` 整轮接入保持独立；本模块尚未完成所有产品入口和部署适配。

正式 Studio binding 也使用现有 `agent/assistant-stream` 的 start/chunk/end 帧显示模型
文本、思考和工具参数预览。普通对话与托管执行共用每个 Agent 的流版本计数，避免切换
入口后被视为旧流；预览 ID 不授予工具执行权限。模型回执与公共 Session 消息落盘后，
end 帧才引用真实的全局事件序号；落盘失败或执行中止时以 abandoned 收尾。历史恢复
使用已提交的流，不重新发布原实时片段。该接线沿用已有帧与所有权契约，无新增 Build
引擎版本；结构化最终提交等不生成普通实时文本的既有约束保持不变。

参考行为版本：`ksadk-python@355059d78e47ed764bbdb3606304cdf34e9838a3`，
重点为 `kernel/contracts.py`、`authorization.py`、`store.py`、`execution_grants.py`、
`worker_controls.py`、`events/canonical.py` 和 `a2a/bootstrap.py`。
参考仓库中的内部 A2A client 不包含平台 Server 的实际 HTTP handler，不能据此假定
已有 Server 支持新增回调地址。

## 显式可信装配

`mountStudioHost(ctx, { nativeManagedKernel, nativeA2aInbound })` 可选启用本模块。
两项均为可信启动代码注入，Agent spec、工作区文件或普通 DSH 请求头不能配置这些权限。
`nativeManagedKernel` 至少包含：

- `target: {tenantId, agentInstanceId}`：绑定的唯一租户和 Agent。
- `permitVerifier`：`createNativeKernelPermitVerifier({verificationKeys, target})`，
  `verificationKeys()` 从可信 Server key provider 返回 key-id→Ed25519 PEM 的对象或 Map。
  没有本地自签 fallback。生产 JWKS 获取、CA、轮换与部署证据仍需实际装配。
- `resolveBinding({command, recovery, stage, runId, signal, store, admission})`：可信 Agent/Build 解析，返回
  `{scope, buildId, configuration, ports, release?}`。配置由现有 `configure()` 固定，包含
  正式输入消息及工具权限；恢复必须重建相同 scope、Build 和完整配置。
  每次调用的资源会在准入结束或该轮 worker 结束后调用可选 `release()`。
  `stage` 为 `admit` 或 `execute`，`recovery` 保留原有布尔含义；`runId` 始终是原命令的
  固定 Run。`signal` 属于 Host 生命周期，HTTP 断开不会撤销它。`store` 是实际执行所用的
  Native 账本，仅可信装配代码可用，解析本身不得调用模型、执行工具或推进状态机。
  首次准入 `admission=null`；执行及冷恢复携带数据库原始
  `{scope, buildId, configuration}` 的独立副本。应从它恢复已准入的消息及恢复胶囊，重新
  校验当前可信资源和权限，不能用当前可变文件、附件或默认模型重新生成原始输入。
  修改这个副本不能改写数据库，返回不同配置会在执行前被拒绝。
  `release({scope, sessionId, runId, stage, signal, reason?, admitted?})` 收到对应的原运行身份。
  `stage='admit'` 正常结束时，`admitted` 表示命令已持久化接收，队列拒绝或准入异常为 false。
  Host
  退役会停止等待未完成的解析；之后返回的资源仅调用释放，`reason='owner_retired'`，
  不再进入准入或执行。迟到清理不得依赖仍打开的账本。第三方忽略信号或清理失败时，
  不承诺其外部资源已经释放；已有 `release()` 的等待仍要求宿主合作。
- `authorizeInteraction({command, authorization, pending})`：可选的可信交互引用校验。
  缺失时拒绝审批回复。必须是只读或按原 command-id 幂等的授权校验，不能靠消耗一次性
  token 代替原子命令准入；它不负责执行工具。
- `assertCurrent()`：同步返回严格 `true` 的宿主权限和生命周期检查。
- `onWorkerError({sessionId, error})`：可选的可信宿主诊断回调，收到原始异常。
  回调抛错或返回拒绝的 Promise 不会覆盖原异常、触发重试或推进执行；公开状态仍仅返回
  原有的脱敏错误码。原始异常可能含私有资源信息，只应写入受保护的宿主诊断。

`nativeA2aInbound` 省略 `events` 时使用该运行时的真实持久 Session 事件源；出站到
平台 Server 的 `SubmitA2AInboundMessage` / `CancelA2AInboundTask` 仍沿用已有控制面。
正式平台 Server 必须将其可信命令转交本接收器，并返回原始 receipt；目前的安装包
证明使用受控 Server peer，不能声明已与部署中的平台 Server 联调。

## 版本化传输

### Studio Session 的完整执行边界

可信 binding 可提供 `withExecution({identity, configuration, signal, execute})`，把 Session
生命周期交给宿主、把唯一执行循环保留在 Native。宿主必须等待 `execute()` 并原样返回其
结果；不能伪造终态、重复调用或保存回调供生命周期结束后调用。没有此端口时仍为独立的
managed worker，不自动取得 Studio Session 的执行权。

`createStudioManagedNativeExecution({ctx})` 使用正式 SessionController 解析准确的 Session，
等待已有回合空闲，再调用维护版 SDK 的 `externalTurns.start/resume`。契约为
`agentkit.native-managed-dsh-turn/v1`：持久 owner 绑定原 Run、scope、Session、Build 和
配置摘要，Session owner 落盘成功后才调用 Native。其他引擎或另一 Run 的 owner 会被拒绝。
SDK 恢复时可能先取得 Session 写句柄、随后才发布 Agent。正式 binding 仅为已准入命令的
`execute` 阶段等待 `session/writer-held`，最长 10 秒，每 50 毫秒通过原 SessionController
重新查询，Host 退出可中止等待。首次准入、其他错误以及持续写锁仍直接失败；等待不
授予 Session 权限，也不允许绕过原 owner 或重新执行未知副作用。
暂停、审批等待保留同一 Session owner，由 Native 消费后续持久命令；另一个本地接收进程
写入的命令也能唤醒等待。Session 取消作用于原 Native Run，Host 退役不会把暂停改成用户取消。

SDK 关闭回合后再落盘，接收器才结算命令。专用 Session projection 在重开时恢复最近的
已关闭 owner：若 Session 终态已经落盘但接收器 ACK 丢失，只允许读取原 Native 终态，
不能另开回合或重新执行。该 projection 仅恢复事实，不授予模型、工具或审批权限。

### 现有 Studio 恢复面板

正式 binding 会注册可信 `studioManagedNativeSessionControl`。既有
`sessions/native-recovery-status` 识别托管 owner，并读取接收器的原账本，核对启动配置
绑定的 tenant、principal、workspace、Agent、Session、Run、Build、命令及配置摘要。
读取不推进 Native、不写事件投影、不消费 Server nonce，也不调用模型或工具。
状态和用量仍使用 `agentkit.studio-native-recovery/v1` 与原用量契约，额外的 `managed`
字段显式使用 `agentkit.studio-managed-native-recovery/v1`，报告原命令状态、SDK owner
及 `controlAuthority: 'server'`。尚未领取 SDK owner 的已接收命令也可查询。
`executionState` 区分本进程已排队、进入原执行边界和空闲。托管重试回包仅确认已安排
原命令；面板刷新状态后才把真正进入执行边界的运行显示为正在继续，排队不代表已接管。
后续普通对话不会被旧的托管 projection 遮盖；指定原 Run 时仍可读取其记录。

本地“恢复原运行”只允许重新推进已经持久化准入的原命令，仍经过原资源重绑、SDK
独占 owner、租约及 Native 恢复语义。重复确认已结算的终态只读原结果，不创建新命令
或替代 Run。暂停、等待审批、待核对以及未知副作用不能由此按钮解除；必须通过原
Server 控制端提交有效的签名命令。本地核对路由对托管运行明确返回
`NATIVE_MANAGED_SERVER_CONTROL_REQUIRED`。面板为暂停、审批和核对显示对应说明。
自定义 `resolveBinding` 不自动注册这个依赖正式 SDK Session 的产品端口。

此接入覆盖状态、用量和原准入重试；托管子任务及远端 A2A 接线见下文。完整的
Server 交互控制产品接线仍需闭环，不能据此认为全部托管产品入口已经迁移完成。
宿主关闭时先等待 managed runtime 退役，再关闭 execution adapter 及其 projection。

正式 Host 先创建接收器，等完整控制面和 `presetRegistryStartup.ready` 完成后才调用
`startRecovery()`。在此之前已持久化的命令保留为 accepted，不能用半恢复的 preset 装配
资源。直接嵌入接收器的宿主可用 `autoStart: false` 配合该方法建立相同的就绪边界；
正式 Host 显式配置 `autoStart: false` 时保留手动驱动方式。

冷启动若碰到被杀进程尚未过期的 Native lease，会按账本中的真实到期时间安排重试，
期间不派发模型或工具，也不依赖新命令或状态查询唤醒。重试仍经过原配置、SDK owner
和 Native fence 校验；权限丢失、绑定变化和 stale fence 不通过这个定时器重试。

此适配器负责 Session 生命周期。未提供自定义 `resolveBinding` 时，显式 managed 配置必须
提供可信 `principal.userId`；宿主从真实 SessionController/preset 获取 Agent revision 或
Frozen Build，复用原 Native Host 的完整模型、工具、Memory、Skills、MCP、Browser、
子任务、Hooks 和上下文装配代码，使用接收器的实际 ledger 与可信 tenant/user/workspace。
命令不能选择其他 Agent；恢复检查原 Build、模型、消息和完整配置，失败时释放资源。
SDK 的真实 prepareInput 用于后续输入，已提交的完成回合使用同一有超时边界的可选消费者。
接收器先退役，再释放 Session adapter 和共用 Host。

资源发现和本地 Native 回合共用每 Session 的装配租约。执行阶段先释放预览资源，取得
SDK 独占回合后再重建完整 binding 并核对原配置；只有这时端口才能执行，避免等待 Session
时占住 Memory/vision 资源或覆盖普通回合的 owner。失败和取消均释放对应资源。
最终候选之后仍检查真实排队输入；只有 SDK 自动生成的 clock/runtime 快照时，不另开模型
轮次。上述快照在正常模型步仍保留，真实用户/后台输入不会因此被过滤。

该入口仍属显式接入。完整资源组合、更多混合回合并发故障边界、审批/未知结果产品流程
和全部 SDK 崩溃边界尚需验收，不能仅凭复用装配器声明这些能力全部贯通。

执行适配契约为 `agentkit.managed-native-kernel/v1`。仅显式装配时注册：

| POST 地址 | 请求 |
| --- | --- |
| `/_agentkit/native-kernel/v1/commands` | `{command: AgentControlCommand, permit: AgentControlPermit}` |
| `/_agentkit/native-kernel/v1/status` | `{query: AgentStatusQuery, permit: AgentControlPermit}` |
| `/_agentkit/native-kernel/v1/events` | `{subscription: SessionEventSubscription, permit: AgentControlPermit}` |

命令和 permit 沿用参考 v1 字段，读取也需要独立许可。命令 accepted/duplicate 分别返回
202/200；SSE `id` 是唯一持久 Session seq。断开事件读取不会发送 interrupt。
此地址是新增的显式 Node 宿主适配契约，不冒充参考仓库中已有的 Server callback 路由。

签名使用 Ed25519、UTC 秒归一化、排序紧凑 UTF-8 JSON；有效期及最多 300 秒 TTL
按原微秒精度检查。固定目标、session、operation 和 authorization_ref 必须匹配。
含额外浮点字段的 permit 跨语言数字编码尚未完成完整对照，不能视为全部扩展格式无差异。

## 存储与恢复

状态位于 `<Studio store>/native-harness/managed-kernel/`，使用两个私有 SQLite 文件。
`commands.sqlite` 在同一事务提交命令、nonce、receipt、Run 绑定及准入事实；
`runs.sqlite` 使用现有 Native 事务账本提交执行意图、回执和状态。
两库之间通过固定 Run/command 身份和可重放投影衔接，不声称跨库原子事务。

- 准入落盘后才允许 Native 启动；同一 Session FIFO，取消等控制可作用于原 Run。
- 幂等摘要排除许可引用、提交时间、Server 请求引用与交互授权引用，保留业务内容。
  新许可下重试仍解析为原回执，复用 nonce 到其他命令会被拒绝。
- Native 原有 lease/fence 阻止两个执行者同时驱动同一 Run。控制投递和事实投影均可
  重放；Session fact 与投影游标在同一事务提交，事件 UUID 固定。
- 已写文件但丢失工具回执的真实 SIGKILL 后，原 Run 进入 interrupted，保留未知结果；
  不自动再次写文件。原命令完成但尚未投影时，冷启动只补投已提交事实。
- Host 退役中止异步端口等待，不伪造用户 cancel；非合作端口可能仍有外部副作用，
  其结果保持未知，不承诺外部副作用 exactly-once。

这是单机器 SQLite 适配器。本地 accepted 命令自动恢复不代表共享 managed SQL、跨 Pod
存储、全部产品资源的恢复扫描或安全 GC 已完成；不能将此目录用于多机器共享部署。

实际 SDK 故障验证使用同一正式 preset、SQLite、Node 文件工具和公开 Session 方法，
在以下边界暂停整个 Host 事件循环，再由父进程 SIGKILL。冷进程启动早于原租约到期，
不补发命令、不调用 drain 或恢复 RPC。检查原 Run/receipt、SDK owner、用户/工具/用量
历史及文件派发次数；完成后重试原命令只返回原回执。

| `--inbound-crash-boundary` | 验证行为 |
| --- | --- |
| `before-owner` | turn/start 已落盘但尚未 claim；SDK 关闭无 owner 的孤立回合，原 Native Run 在下一 SDK 位置执行一次 |
| `after-owner-flush` | SDK owner 已落盘、Native Run 尚未创建；恢复同一 owner |
| `after-input-flush` | 用户消息已落盘、Native 消费游标尚未确认；租约到期后恢复，不重复用户消息 |
| `after-tool-effect` | 文件实际已写、工具回执尚未提交；进入 interrupted，保留未知结果，不再次写文件 |
| `before-turn-end` | Native 已完成、SDK 尚未追加 turn/end；原 owner 补齐结束 |
| `after-terminal-flush` | SDK 结束已落盘、接收器尚未结算；只读原 Native 终态，不创建替代回合 |

```sh
node scripts/verify-studio-native-a2a.mjs --source <维护版 SDK> --archive <正常打包的 tgz> \
  --internal-control-plane --inbound-protocol --inbound-execution --inbound-formal-binding \
  --inbound-crash-boundary after-tool-effect --keep
```

## 支持范围与明确缺口

现有接收器支持 enqueue、普通 Run interrupt、pause、Run resume、文本 steer，
以及经过可信引用校验的 approval 回复。`capabilities` 明确暴露支持集。
共用 Studio binding 接受文本 enqueue，以及显式版本的 Session prompt 多部分输入：

```json
{"format":"agentkit.managed-studio-input/v1","parts":[
  {"type":"text","text":"检查附件"},
  {"type":"file","receiptId":"当前接收会话的上传凭据 UUID"},
  {"type":"image","mediaType":"image/png","data":"图片的 canonical base64","name":"input.png"}
]}
```

以上对象放在 `payload.content`。文件凭据通过公开的 `fileUploads.resolve(agent, receiptId)`
按接收 Agent 的确切会话解析，图片通过 `attachments.admitPromptContent` 验证并持久化。
不接受调用方提供的 Host attachment 引用、本地路径、远程图片 URL 或消息角色。
上限为 64 部分、八个附件，结构化内容不超过 2 MiB；图片还受 Host 解码及模型能力检查。
解析后的模型输入字节和展示引用分别固定在 Native configuration 与恢复 capsule 中；
恢复从原准入记录读取，不依赖已经失效的上传凭据或再次读取附件文件。
文件凭据仅在首次准入期间经公开的 `bindPrompt` 暂时绑定；接收事务成功后提交绑定并
调用 `retirePrompt`，让已固定到 Native 的附件不再占用 staged receipt。接收失败则撤销
临时绑定，保留凭据供用户重试；冷恢复不再绑定或消费原凭据。

正式 SDK owner 把真实 numeric turn 和 `agentkit.native-managed-dsh-turn/v1` ownership
传给共用 binding。后者使用既有 `createNativeSessionDelivery` 投递已提交 Native 检查点，
把原始用户消息（含附件展示引用和 command-id/rpcId）、助手、工具结果及模型用量写入
公开 Session 事件。投递会对照原 Run 身份、配置摘要及恢复 capsule，不能用新输入替换
原消息。Session 持久化 flush 成功后才确认 Native 消费游标；消息已追加但确认丢失时，
按既有事件投影中的稳定 atom 身份去重。完整执行循环仍由 Native 驱动。后续托管 Run 的
owner 固定真实 Native parent，SDK numeric turn 与 Server command-id 始终分别保存。

`capabilities.enqueueContentFormats` 暴露这个输入版本。`structuredInput` 在安装可信
`authorizeInteraction` 时为 true，表示下述托管 A2A 交互回复；它与 enqueue 的多部分输入
以及 resume.input 是分别校验的能力。
未知格式仍返回 `NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED`，不使用 JSON 字符串化降级。
inject、checkpoint/continuation resume、resume.input、Teams execution-policy/context 扩展
及 legacy-history 导入会明确拒绝。这里需要区分参考引擎：原 `NativeRuntimeAdapter`
本身声明 inject 和 checkpoint 不可用，Native resume 只支持原 invocation 的暂停或审批恢复；
Teams execution-policy resolver 由 `ManagedHarnessRuntimeAdapter` / ManagedLangGraph 消费。
这些不能直接列作原 Native 已支持而 TS 丢失的能力。无 Python 历史存量也不要求导入旧库。
来源与边界见[原能力清单](native-reference-capabilities.md)。

### 执行授权：独立于运行与工具权限

可信 Host 可通过 `runtime.executionGrants` 使用
`agentkit.managed-native-execution-grants/v1`：`ensure/get/require/lookup/renew/setState/setAdmission`。
这些方法不通过 HTTP 暴露；公共签名 enqueue 只能引用已存在的
`execution_grant_id` 和可选 `execution_grant_attempt_epoch`。签名不创建授权，授权也不代替工具审批。
授权绑定 tenant、AgentInstance、session、owner 和不可变 attempt epoch。`capabilities.executionGrants`
为 true；`teamsContext`、`executionPolicy` 仍为 false，不能据此宣称 Teams 已迁移。

授权、幂等操作回执和命令资格记录保存在同一个 `commands.sqlite`。执行资格取得与授权撤销
共享 `BEGIN IMMEDIATE` 事务，发生在异步执行 binding 解析之前。保留原命令、message ID 和
稳定 Run ID；资格不表示模型已运行，不替代 Native fence，也不允许重跑未知副作用。
撤销只原子丢弃尚未取得资格的 enqueue；已经取得资格的旧式无期限任务继续完成。
跨进程接管仍使用原 Run 和 Native 意图/回执，不能新建替代 Run。排队暂停只递增
`admission_revision`，授权状态/续期递增独立的 `revision`；同 session 不同授权仍遵守 FIFO。
暂停或撤销队首不会屏蔽已存在 Run 的签名控制命令。

`get` 返回 queued/in_flight/discarded/settled message ID 及原命令明细；资格已提交但 Native 尚未
初始化时属于 in_flight，不能谎报正在调用模型。操作回执与状态变更一同提交，重复操作返回
当时的原始 barrier；参数不同拒绝。已撤销授权不能恢复。

带期限的授权必须同时指定正整数 attempt epoch 和绝对时区时间 `expires_at`。
新建/成功续期建立当前进程的单调时钟锚，且可用可信 Host 的 `remaining_ttl_seconds`
缩短期限；事务锁等待消耗此预算。时钟回拨不能恢复已经耗尽的期限。进程重启会丢失锚：
读记录、ensure 已有记录、查询或重放旧续期回执均不能恢复资格，必须由可信 Host 重新授权一次
新的续期。另一个连接续期也不会偷偷给当前进程重建锚。期限精度为 JavaScript 毫秒。

### Teams 原上下文与回调授权

`runtime.teamsContexts` 提供可信 Host 专用的
`agentkit.managed-native-teams-context/v1` 记录端口。上下文、原命令、会话 owner 摘要、
数据库 incarnation、扩展身份、nonce 归属和分 revision 的短期 callback 均保存在原
`commands.sqlite`。`put/get` 等方法必须传入原 `expectedIncarnation`；重开同一个库保留身份，
替换数据库不能解释为上下文不存在。会话 owner 与上下文唯一约束在同一个事务提交，
冲突或中断会一同回滚。已接收普通托管命令的会话不能改为 Teams 会话，Teams 已预留会话
也不能通过普通 Server 命令接管；异步 admission binding 返回后会在提交事务内再次检查。

记录校验完整原 enqueue、执行目标、grant/attempt、context/policy 引用与摘要。
Teams 使用独立 RFC8785 JSON 编码；不复用 Native 日志对 BigInt、负零和大整数的编码。
callback 记录只验证形状和原上下文归属，不验证签名，不创建 grant，也不构成执行许可。
同一 grant revision 仅较晚到期的 callback 能替换旧值，其他 revision 分开保存。

可信 Host 可配置 `teamsCallbackVerifier`，由固定 issuer 与可信公钥源创建
`createNativeTeamsCallbackPermitVerifier`，再使用 `runtime.teamsCallbacks.authorize(contextRef, operation)`。
每次使用都检查原 grant 的当前有效期、attempt 和 revision，验证 Ed25519 服务端签名、
原命令/会话/策略/leader/成员声明及具体操作。取公钥期间发生的撤销、暂停、续期或数据库
身份变化会使本次授权失败。重启后的 callback 和上下文记录不会恢复 grant 的单调时钟锚。
callback 最长 30 秒且不能超出 grant 期限；recovery evidence permit 不能用于执行。
这里不生成生产签名密钥，也不接受请求携带公钥。

这两个端口不通过公共 HTTP 暴露。`teamsContextRegistry: true` 表示记录端口已安装，
`teamsCallbackAuthorization` 仅在配置上述验证器时为 true。
正式 Studio 尚未组装 Teams execution-policy、专用 ingress、材料、工具和模型调用链路；
因此 `teamsContext` 与 `executionPolicy` 仍为 false，普通入口继续明确拒绝不支持的
`teams_context_ref` / `execution_policy_ref`，不会接收后忽略它们。SQLite 的
`sharedAcrossHosts: false` 也不代表已支持原共享 Postgres/cloud bootstrap。

本层负责接收和取得执行资格；`require` 是供可信执行策略在每次模型/工具使用前检查的端口。
Teams 的实时策略、物料与回调授权仍需单独接入，不能把本层队列授权当成完整的 Teams 能力。
现有 `sessions/native-recovery-status` 和运行面板保留原控制端权限，显示等待授权或已丢弃状态；
已丢弃命令不会被显示为可恢复运行。公开状态不包含可信 owner_ref，也不创建本地授权操作。

定向验证：`node --test tests/native-managed-execution-grants.test.mjs tests/native-managed-grant-process.test.mjs`。
实际 Studio/SDK 对照在普通包上运行：

```sh
node scripts/verify-studio-native-managed-children.mjs --source <维护版 SDK> --archive <普通 tgz> --execution-grants --mixed-history --keep
```

它通过可信测试 Host 创建按 occurrence 分隔的授权，公共 HTTP 只提交签名原命令；
验证未放行时无执行、排队撤销、取得资格后撤销/暂停、原子任务控制、普通与托管交替以及独立进程冷恢复。

## 托管子任务的现有产品入口

正式 binding 沿用现有 `sessions/native-child-history`、`native-child-result`、
`native-child-tasks`、`native-child-send`、`native-child-cancel` 与 `native-child-promote`。
历史和结果从该托管 Run 的真实 SQLite scope 读取，不能退回 local-user 账本。
活跃控制句柄引用接收器已经启动的原 Kernel，在整个 SDK owner 内注册，结束或失败时
先注销句柄再释放绑定资源；不会为产品查询创建新 Kernel、Run 或租约。
每次实时操作检查当前 SDK owner、会话、配置摘要和运行身份，切换后的旧句柄不能继续操作。

指导、取消和转后台属于现有已认证会话所有者的子任务命令，权限边界与 SDK 用户取消
一致。它们不能授权 Server pause/resume/approval，也不能解除未知副作用的恢复状态。
在原控制句柄已释放或 Host 重启后，只允许确认一个逐字段相同且已持久化的 commandId；
该确认只读、返回 duplicate，新的控制命令仍需原活跃 owner。已完成的历史和分页结果
不会重新绑定工具或唤醒任务，且不显示可执行操作。普通和托管 Run 混用时，默认目录
合并两份原账本，当前 owner 的祖先链在前、另一 owner 的祖先链在后；
各链内部保持原有顺序，不使用不同数据库的时间戳推断全局先后。显式 runId 仍读取对应
原账本的祖先链。此处是只读目录合并，不合并执行、权限、用量归属或数据库。

事实源从已提交 Native 事件生成 runtime/v2、control/v1 和 interaction/v1；包含文本、
终态、每次模型用量增量、已提交的工具调用/结果、已提交 thinking 捕获以及暂停/恢复。
未知工具结果投影为失败条目，保留 interrupted 终态，不能伪造成功结果；A2A Task 消费者
等待匹配的 control 终态后关闭任务。标准 Studio 公共实时流已接线并验证；Server 的
runtime/v2 事实投影与完整 reasoning/media、公共工具活动和所有诊断尚未全部闭环。
共用 Agent/Build binding 的全部资源组合与并发边界、
审批资源的产品流程、部署中的 Server 传输适配与线上认证仍需补齐。此模块不能替代这些验收。

## 托管 A2A 问答、审批与原回执

现有 `sessions/native-a2a-control` 对托管 Run 通过可信 Session binding 读取接收器的
原 scope 和账本，普通 Run 保留本地读取。控制请求不能选择 tenant/user 或替换绑定。
远程继续、拒绝和取消仍各自经过原 Host 的操作审批；控制确认不会制造 Native 工具
结果、重新获得原执行租约或自行恢复根任务。等待审批时变更 preset、版本或可信
托管 binding，原操作会失去权限。

正式 SDK owner 内的托管根任务在 `awaiting_reconciliation` 时接入现有 A2A 本地
回执等待器。只有原始 fenced `call_a2a_agent` 且声明 `receipt-observation/v1` 的记录
可用；未知文件写入等操作不进入此路径。输入问答使用现有 userQuestions 服务，远程
操作审批使用真实 ApprovalService 的持久审计。问答回答本身不能替代操作审批。
等待器只观察本地 A2A journal；它返回稳定身份的 `reconcile_tool`，由原 Native Kernel
另行持久化 `tool_receipt` 意图、取得执行 fence 并核对原结果，不能再次发送原始工具。

每次等待绑定原检查点、执行 fence、SDK owner 和配置。新命令、检查点推进、fence
变化或 Host 退役会撤销等待；迟到回答不能提交回执命令。另一个 SQLite 接收器的
持久命令通过队列和轮询唤醒，原 Server 已准入但尚未投递的控制也会撤销根任务问答
权限。托管子任务沿用原父任务的 managed ownership，检查完整父身份、预算和原意图。
取消终态撤回仍待回答的远程问题，不把本地取消伪装成远端 CancelTask 成功。

此路径只允许核对同一原操作的回执。Native 工具 `awaiting_interaction` 仍需原 Server
签名与可信 token 校验，Host 的 A2A 回调不能返回 approval/resume 或新增用户输入。
Server 的 managed-A2A 结构化交互回复见下节；其他交互生产者和
附加 Teams execution-policy/context 接入尚未实现，边界仍按上节明确报告；
它不表示原 Python Native 已支持这些策略。

## Server 定向取消原 A2A 调用

正式 Studio binding 提供 `capabilities.scopedInterrupt = true`。签名 `interrupt`
的 `payload.scope_id` 指向原 `execution.scope/v1` 中的 A2A scope，`run_id` 是其
Native 根任务；省略 `run_id` 时选择该会话最早的已准入活跃根任务，不选择后续排队任务。
它同时支持根任务的直接调用及原 frozen role/ancestry 校验通过的前台、后台子任务调用。
该 ID 不是 Native childRunId；不存在、其他会话或其他父任务的 scope 不会降级为根取消。
未安装可信 scoped control 的独立接收器仍明确返回 unsupported。

Host 从原 Native tool intent、完整运行身份、配置摘要及原私有 A2A journal 解析 locator。
Server 不能传入 store、scope、工具定义、URL、角色或审批凭据。原请求摘要、工具调用、
definition、claimed fence 和 frozen ownership 在接收及实际执行前分别核对。
控制解析通过原 SessionController 和恢复 preset，允许原 SDK turn 持续运行，不能等待
`whenIdle`，也不借用原工具已经过期的执行租约。

Server 命令、接收回执、accepted fact 和独立 `managed_scoped_controls` 队列同一事务提交。
队列采用跨接收器租约，投递保持原 commandId，永不提交 Native 根 `cancel`。
只有原 A2A journal 中的取消已持久化后才唤醒回执等待，避免先撤销并重复展示未回答问题。
前台子任务另以原本地 journal 撤销等待中的问题，迟到回答不能生成 continuation 权限。
Host 退役和租约失效撤销执行权限；回复迟到不能确认投递。原 Native 根任务继续运行，
其后续模型由原 owner 在独立、有 fence 的 `tool_receipt` 核对后推进。

签名只授权 Server 控制投递。远端取消沿用原 invocation 的执行许可：原私有 journal
必须对应原已准入工具调用；当前 Host policy 必须有效。`read-only` 或
`policy://a2a/strict` 必须找到同一个 SDK callId 的真实 `approval/asked` 与后续
`allowed-once` 审计，不能用新 Server 签名或其他调用的许可替代。strict 绑定的首次
调用即使在 workspace-write 下也必须经过真实审批。人工产品 A2A 控制仍保留其独立
exact-command consent；Server 定向取消不会伪造人工回答或远端 approve。

授权的撤销记录使用独立 `agentkit.native-a2a-scope-cancellation/v1`，与原取消 effect intent
原子发布。runtime/v2 沿用合法的 `interaction.resolved` canceled/null 响应，metadata
明确标记 scope_cancellation，不填写 host_decision；managed interaction/v1 的关闭仍由
原根任务终态完成。接受取消不等于远端已取消：CancelTask 后必须 GetTask 确认。
远端副作用后断连或 SIGKILL 保留 sending/unknown，重新投递同一 commandId 不再
CancelTask。经过授权的 GetTask 可确认原远端任务，再供原 Native 回执核对消费。
这不承诺全局 exactly-once，也不把未确认的远端结果改写为成功。

## 已执行的验证与复验入口

定向测试验证签名与微秒有效期、nonce、幂等、FIFO、并发执行者、暂停/继续/审批、
主动取消、Host 退役、事务回滚及三个真实 SIGKILL 边界。没有运行全仓测试。
runtime/v2 负载使用参考仓库原始 JSON Schema 验证，测试快照位于
`tests/fixtures/native-managed-runtime-v2.schema.json`，SHA256 为
`04d15e3cf0f8c5465c8ae68691b2c2bacd90f4585ae4d5ed11187d4a9084034f`。

```sh
node --test tests/native-kernel-permit.test.mjs tests/native-managed-kernel*.test.mjs
node scripts/verify-studio-native-a2a.mjs --source .artifacts/dsh-native-idle \
  --archive <正常打包的 tgz> --internal-control-plane --inbound-protocol \
  --inbound-execution --keep
node scripts/verify-studio-native-managed-children.mjs --source .artifacts/dsh-native-idle \
  --archive <正常打包的 tgz> --keep
node scripts/verify-studio-native-managed-a2a.mjs --source .artifacts/dsh-native-idle \
  --archive <正常打包的 tgz> --keep
# 可分别添加 --child、--approval，或 --interrupt 验证未回答时的签名取消。
# --answer-crash 在回答落盘、远端继续操作的补充授权尚未决定时 SIGKILL 实际 SDK Host。
# 可与 --child、--approval 组合；不与 --interrupt 组合。
# --effect-crash 验证主任务的远端继续操作已生效、回复尚未收到时强杀。
# 可添加 --child、--approval；不与 --answer-crash、--interrupt 组合。
```

实际打包 Host 已证明：带签名的 Server HTTP 回调驱动 NativeKernel，经真实模型 HTTP
协议调用和文件工具生成持久 Session 事实，再投影为完成的 A2A Task；Host 换 PID 后
原请求查询/重试不增加模型或文件调用。Server peer、模型响应和可信 binding 均为
明确受控夹具；不代表真实云端、正式 Server 互操作、全新安装或全部产品入口完成。
原有 DSH 挂载、Native 整轮出站 A2A 及历史恢复在同一 Host 验证中回归。

`--answer-crash` 额外验证换 PID 后由原持久命令自动恢复，不提交新 Native 命令或恢复
RPC，不重复提问、模型调用或远端发送。尚未完成的补充操作授权会重新请求，只有新
宿主的真实授权通过后才继续。最终再换 PID，验证终态历史、账本和回执无新增副作用。
此边界不等同于远端副作用已经发生、回执尚未落盘时的未知结果恢复。

`--effect-crash` 将远端继续操作的回复停在受控 HTTP peer 上，再强杀真实 SDK Host。
替换进程恢复原 owner 后保持原 uncertain 回执，不自动查询、重发或重新提问。
经已认证的 `sessions/native-a2a-control` 对同一个 Run/operation/call 执行 `get`，
确认原远端任务后，原 Native Kernel 才取得独立 fence 并读取回执，原 Run 随后完成。
此路径只增加一次 GetTask（人工查询）；独立 fence 下的 Native 回执核对读取这份已持久化
的终态确认，不再访问远端。SendMessage 总数保持
初始发送和原继续操作各一次；第三个进程恢复终态不增加副作用。

子任务人工控制使用父 Studio `agentId/sessionId/runId` 加 `childRunId`，由可信宿主从
原账本及冻结角色授权解析子任务 scope、合成 Session 和操作定位。当前父 Run 的查询
不能选择祖先 Run 的子任务；历史父 Run 必须显式选择原 runId。已提交启动凭证，或
原活跃 Kernel 认证的尚未落盘启动回执，证明归属后才允许读取子任务记录。
记录是独立只读副本，不授予执行租约。每次远端控制继续核对父配置、子任务身份、
原预设及权限；原未知继续操作不能重发。子任务历史中的远端操作描述显示在既有
“运行与子任务”面板，查询和控制沿用同一已认证入口。普通主任务字段及 DSH 控制不变。
`agentkit.studio-native-child-history/v1` 的可选 `a2aTasks` 描述以 additive 字段公布这个
入口；旧响应省略该字段时不显示子任务远端控制。描述中的子 Agent/Session 只用于
核对回执，RPC 仅传父身份及 `childRunId`，不接受调用方指定 scope、角色或权限。

## Server 结构化交互回复

正式托管 owner 的 A2A 输入/远端审批现在通过独立的
`agentkit.managed-native-a2a-interaction/v1` 通道发布和恢复。它沿用已签名的
`submit_interaction` Server 入口及现有 interaction/v1 事件，Native 核心的工具审批仍是
二元决策；结构化答案不进入该审批命令。主任务、前台子任务和后台子任务由可信宿主
从原账本、冻结角色和实际 SDK Session owner 解析，公有命令不能指定子任务 scope。

宿主登记原 Native 检查点及原远端问题摘要，持久化 `interaction.requested`，再发布
`waiting`。Server 使用事件中的稳定 interaction_id、父 Studio session/run、revision=1
及独立 token_ref 答复；原始 JSON response 完整保存，structured_input 允许 submit/reject，
远端 approval 允许 approve/reject。Server 签名与 `authorizeInteraction` 都必须通过。
schema 在进入原 A2A 问题日志前校验；非 object schema 的单字段 result 包装仅用于
校验和原续执行层解包，Server 审计保留原始值。该提前校验比 Python Kernel 更早拒绝
无效输入，保持原 A2A 续执行的数据约束，避免已确认却无法消费的答案。

答案、接收命令、接收回执、resolved 及 running 事件在同一个 SQLite 事务中提交后才
ACK；命令准入事件先于 resolved。版本 CAS 和首个答案决定胜者。Studio 本地问题界面
与 Server 共用同一答案记录；迟到或取消的界面答复不能覆盖它。已投递命令的重复确认
不再唤醒 owner，从而不会撤销后续的独立操作审批。答案持久化后、原问题日志消费前
重启，原 owner 从相同记录恢复完整答案，不再询问或执行原工具。

活跃登记每 100ms 续期、有效期 2s，独立本地接收进程只能对仍有效且与原检查点一致的
登记准入；过期或撤销不能借事件记录恢复权限。暂停撤销活跃登记，恢复后复用原交互；
普通宿主关闭只撤销活跃登记，不伪造交互取消。原 Native 终态投影在同一事务中关闭尚未
回答的交互，产生 cancelled/expired。此租约是单机持久化边界，不承诺跨数据库瞬时取消。
回答远端问题始终不等于允许远端副作用：原工具仍需独立的确切操作授权和回执核对。

复验既有正常安装包 SDK 脚本可添加 `--server-input`，并组合 `--child`、`--approval`。
该模式挂起本地答案，通过真实签名 HTTP 命令答复，同时核验错误 token/版本/身份/类型
无效、原问题和远端操作不重复、原账本及不同 PID 的终态冷恢复。独立进程故障测试另行
验证签名答案提交后、原交互消费前 SIGKILL；该测试不替代实际 SDK 集成证明。

## 普通与托管子任务的混合历史

既有 `agentkit.studio-native-child-history/v1` 响应保留 `runId` 作为当前目录 head、
`task.parentRunId` 作为该子任务的原父 Run。宿主从安装时绑定的 Server principal 和
本地工作区分别读取原目录，合并后才进行统一的有界翻页。调用方不能选择 tenant、
principal、账本或提供目录。两个来源的父/子 ID 冲突会拒绝查询，不猜测归属。

合并目录的 opaque `inventoryDigest` 使用 `agentkit.native-child-inventory-merge/v1`
摘要域，绑定两个来源的 head、原目录摘要及来源顺序。任一来源增添子任务、变化 head
或切换当前 owner，旧分页游标失效并要求刷新。只有一个来源有历史时保持原游标。
后台任务状态/用量变化保持既有目录身份；每页仍读取当前状态。

历史记录不能取得当前控制权。结果面板使用选中记录的 `parentRunId` 读取和翻页，
核对回复的父/子身份；不能将当前目录 head 套给另一账本的历史任务。显式历史读取
直接核验原准入、冻结角色和祖先链，即使另一个 SDK turn 正在运行也不进入恢复接口、
申请租约、唤醒 Kernel 或执行模型/工具。默认无 runId 的结果查询在两个受信目录中
唯一定位原子任务，返回当前目录 head 和原任务身份。

`scripts/verify-studio-native-managed-children.mjs --mixed-history` 在原签名 Server
send/cancel/promote 验证之间穿插三个普通 SDK 对话，共六轮真实 owner 生命周期，
检查活跃期间的跨账本历史结果、合并翻页、原结果及不同 PID 冷恢复。仍须传入
`--source` 和 `--archive`。模型 HTTP 响应和 Server 签名方是受控测试端，不代表线上
云服务、完整浏览器交互或所有平台验收。
