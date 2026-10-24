# Server 命令与 Node Native 执行

本模块将已准入的 Server 命令交给现有 TypeScript `NativeKernel`，由它负责完整模型、
工具、预算、重试、租约和恢复。DSH 不参与这条路径的执行循环。已有的本地 Studio
`runtime.type="harness"` 整轮接入保持独立；本模块尚未完成所有产品入口和部署适配。

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
暂停、审批等待保留同一 Session owner，由 Native 消费后续持久命令；另一个本地接收进程
写入的命令也能唤醒等待。Session 取消作用于原 Native Run，Host 退役不会把暂停改成用户取消。

SDK 关闭回合后再落盘，接收器才结算命令。专用 Session projection 在重开时恢复最近的
已关闭 owner：若 Session 终态已经落盘但接收器 ACK 丢失，只允许读取原 Native 终态，
不能另开回合或重新执行。该 projection 仅恢复事实，不授予模型、工具或审批权限。
宿主关闭时先等待 managed runtime 退役，再关闭 execution adapter 及其 projection。

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

这是单机器 SQLite 适配器。共享 managed SQL、跨 Pod 存储、产品级恢复扫描和安全 GC
仍待实现；不能将此目录用于多机器共享部署。

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

`capabilities.enqueueContentFormats` 暴露这个输入版本；原 `structuredInput: false` 保留，
表示下述结构化交互/恢复输入回复仍不支持，不应解释为拒绝此版本的 enqueue。
未知格式仍返回 `NATIVE_MANAGED_STUDIO_INPUT_UNSUPPORTED`，不使用 JSON 字符串化降级。
inject、scoped interrupt、checkpoint/continuation resume、结构化输入回复、
execution-grants/Teams 扩展及 legacy-history 导入会明确拒绝，尚未迁移完成。

事实源从已提交 Native 事件生成 runtime/v2、control/v1 和 interaction/v1；包含文本、
终态、每次模型用量增量、已提交的工具调用/结果、已提交 thinking 捕获以及暂停/恢复。
未知工具结果投影为失败条目，保留 interrupted 终态，不能伪造成功结果；A2A Task 消费者
等待匹配的 control 终态后关闭任务。运行态原始 token 流、完整 reasoning/media、公共工具
活动和所有诊断投影尚未闭环。共用 Agent/Build binding 的全部资源组合与并发边界、
审批资源的产品流程、部署中的 Server 传输适配与线上认证仍需补齐。此模块不能替代这些验收。

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
```

实际打包 Host 已证明：带签名的 Server HTTP 回调驱动 NativeKernel，经真实模型 HTTP
协议调用和文件工具生成持久 Session 事实，再投影为完成的 A2A Task；Host 换 PID 后
原请求查询/重试不增加模型或文件调用。Server peer、模型响应和可信 binding 均为
明确受控夹具；不代表真实云端、正式 Server 互操作、全新安装或全部产品入口完成。
原有 DSH 挂载、Native 整轮出站 A2A 及历史恢复在同一 Host 验证中回归。
