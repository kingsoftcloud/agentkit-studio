# A2A 入站协议、持久任务与恢复边界

实现包含 Gateway 身份验证、Server 接收/取消 Action、私有准入日志、Kernel 事实
归属过滤，以及 AgentCard/JSON-RPC/REST/SSE、持久协议 Task 和 product 事实 outbox。
Studio bootstrap 提供显式可信 `nativeA2aInbound` 组装参数并通过实际 DSH WebServer
挂载协议路径。现已增加[显式可信的 Server 命令接收与 Native 执行](native-managed-kernel.md)，
连接真正的 TS NativeKernel 与私有持久 Session 事实源，并有实际打包 Host 的模型 HTTP、
文件工具和冷重启证据。正式平台 Server 的部署适配、Agent/Build 生产 binding 和完整
控制能力仍未闭环；受控端到端验证不能代替线上认证或完整迁移验收。

行为依据为 Python `feat-ksadk-harness-2` 的
`355059d78e47ed764bbdb3606304cdf34e9838a3`：`a2a/platform.py`、`identity.py`、
`inbound_kernel.py`、`kernel_task_adapter.py` 和 `kernel/contracts.py`。
产品安装和运行不导入或启动 Python。

## 身份与接收边界

`createA2aGatewayIdentityVerifier` 使用可信宿主配置的 RSA 公钥和固定
account/tenant/Agent/Runtime/A2A Agent，校验 RS256、issuer/audience、exp/iat/JTI、
原始 body/query 摘要、method/path 和路由目标。时钟接口返回毫秒。v1 workload
和 v2 product API Key 身份分别保留相应字段；product key 禁止混入 runtime 身份。
返回冻结的身份和 body 摘要，不返回 JWT 或原始请求字节。AgentCard 探针也必须验证
签名、请求内容和固定目标，不能仅凭一个身份请求头放行。

JWT 使用仓库已有的严格 Native JSON 解码器，拒绝重复键和原型字段注入。
畸形 UTF-8、非规范 base64url、非 RSA 公钥、未知 critical JWS 扩展和非字符串
身份请求头均拒绝。错误统一为 `A2A_INGRESS_IDENTITY_INVALID`，不附带输入或 cause。
单 JWT 限 64 KiB，body 限 2 MiB。相对 Python 的宽松 JSON/base64 行为，这些是显式
拒绝的差异；过大整数形式的 JWT 时间也不按舍入后的数字接受。

`createInternalA2AControlPlane` 新增 `submitInboundMessage` 和 `cancelInboundTask`，
均使用新的 `a2a-registry` workload token，并沿用原有请求边界、取消和日志脱敏。
Message 从已验签的原始 body 提取，保留 aliases、未知字段及精确整数，不经过出站
protobuf 摘要归一化。Server 决定 Session、命令、幂等身份和运行；本地不签发执行许可。

Server 回执必须指向 `a2a-kernel-*` Session 和 `ar-*` Agent，外层 CommandId 与
receipt.command_id 相同。accepted/duplicate 必须包含 message UUID 和正的持久接收序号；
其他状态必须包含结构化错误。接收序号不是事件游标，也不代表模型运行完成。

## 持久准入与显式恢复

`createA2aInboundAdmission` 接受可信宿主注入的 verifier/controlPlane/events 和
`assertCurrent`。日志目录必须位于宿主私有状态区，不能指向工作区或被模型导入。
该适配器使用私有原子文件及 SQLite 事务锁，适用于一个本地 Host 的多进程协调；
尚不替代 Python managed composition 使用的共享 PostgreSQL 产品存储。

任务固定调用者、目标、平台 task、version 和 remote task/context。发 Action 前先落盘
原消息、DTO 摘要和 prepared 标记。同 message ID 的不同字节内容、目标或远端地址漂移
均拒绝。已经确认的原回执可从磁盘返回，不再发 Action。

丢失回执、进程中断和 `persistence_uncertain` 保留未知状态；冷启动只读检查不自动发
请求，另一条消息不能绕过未知发送或取消。显式重提同一个接收 DTO 只向 Server 核对
原平台 Task/Message 的准入，不重发远端 Message、不直接调用模型。这个恢复依赖真实
Server 的幂等准入契约，不承诺外部副作用 exactly-once，也没有内置无限重试。

取消必须来自验签后的 cancel_task 请求，并匹配已接收 Run；取消回执只证明 Server
接收了命令。继续输入必须匹配已观察的持久 interaction、revision、kind 和 WAITING，
新命令继承原事件游标。取消流越过旧 WAITING，继续读取原 Run 的持久边界。

观察先持久记录 Run/interaction 与 observedCursor，再 yield；消费者再次推进 iterator
才确认交付 cursor。崩溃或提前停止允许重放最后一条事实，消费者必须按 event UUID
幂等提交自己的投影。并发旧观察不会回退较新的问题或交付游标。每条任务日志限 8 MiB；
超限显式失败，引用感知的日志整理仍待产品组装时补齐。

## 事件归属与验证范围

`streamA2aInboundKernelFacts` 从 Server 接收回执选择 Session，通过原 command 的
durable transition 绑定 Run，或核对回执/持久状态中已知 Run。拒绝另一 Session、
冲突 Run、错误 family version 或拒绝命令；无关 Run 的事实不产生结果。
waiting/completed/failed/cancelled/interrupted 是读取边界，EOF 不是成功。
协议 Task 的成功还必须依据 canonical runtime 完成事实，不能只凭读取边界生成。
订阅 next/return 不响应 AbortSignal 时，调用者仍可取消，不会发布晚到数据。

专项测试使用真实 Node RSA 签名、实际本地 HTTP Action、真实私有文件/SQLite 和独立
Node 进程。SIGKILL 覆盖 Server 接收前与已接收但回执丢失，检查新 PID 不发接收请求、
原日志不变，并验证显式原命令核对仍只保留一个测试 Server 命令。Server、Gateway
密钥签发者和事件源是声明的受控测试端，不能据此声称真实线上认证、产品端到端或
完整 Native 生命周期已验收。

## 协议服务与宿主组装

`createA2aInboundServer` 组合上述准入层与 `createA2aInboundTaskStore`，提供 Node HTTP
handler。路径为 `/.well-known/agent-card.json`、`/a2a/jsonrpc` 和 `/a2a/v1`。
支持 wire 1.0 的 SendMessage、SendStreamingMessage、GetTask、CancelTask、SubscribeToTask，
也接受已有 message/send、message/stream、tasks/get、tasks/cancel、tasks/resubscribe 名称。
REST 使用 `/message:send`、`/message:stream`、`/tasks/{id}` 和 POST `:cancel`/`:subscribe`。
不支持的操作明确返回协议错误，不回退到 Send；关闭 streaming 时在准入前拒绝流式请求。

每个 HTTP 请求重新校验 Gateway 签名、原始 path/query/body 与精确 operation。
AgentCard 探针同样验签。普通 DSH Cookie 和身份请求头不能替代 Gateway 签名。
JSON-RPC、REST 和 SSE 共用持久 owner/platformTask/version 绑定；错误仅输出固定协议
分类，不回显请求、JWT、Server 原错误或未知结果的细节。HTTP body 限 2 MiB。

Host 的 `mountStudioHost(ctx, { nativeA2aInbound })` 是可信代码组装接口，参数包含
`card`、真实 `verifier`、workload-authenticated `controlPlane`、持久 `events.subscribe`
和同步 `assertCurrent`。宿主强制把两类日志放入自己的私有状态区，记录
`agentkit.a2a-inbound-server/v1` 与 `agentkit.a2a-inbound-task-store/v1` 契约。
不从工作区、消息 metadata 或出站 A2A binding 建立入站权限；未传参数时不注册入站路由。
注册和请求受 Host fiber 生命周期约束，卸载后终止观察和 outbox 发送。

AgentCard 使用 `supportedInterfaces`、`defaultInputModes` 等 camelCase wire 字段；
支持字符串 Skill 以及保留完整 JSON 字段的对象 Skill。可信 Host 可传
`publicToolPolicy: { tools: { private_name: { name: "public_label", arguments: ["query"], results: ["answer"] } } }`。
只披露对应工具的顶层白名单字段，并递归清理凭证、堆栈和内部 URL；未知工具和无原调用
关联的结果不产生公开活动。producer 从持久 runtime v2 的 tool_call/tool_result 事实生成
已有 tool-activity extension，保持 opaque call/item/event 身份，并随 Task/游标同事务提交。
冷恢复继续使用原调用关联和预算；披露规则摘要漂移拒绝读取原 Task。AgentCard 根据实际
规则自动声明 extension，显式 `publicToolNames` 必须与规则的公共 label 一致。
配置中的凭证 URL、query/hash、非法 JSON 值、循环引用与访问器被明确拒绝。
接口 URL 由可信外部 baseUrl 构造，不从 HTTP Host 请求头推导。

公开观察仍受 4096 字符、128 集合成员、16 KiB 单事件及 1 MiB 单调用的原策略约束。
单事件超限使用明确省略说明；累计预算预留一个截断观察后停止披露。原 Kernel 事实和
执行回执不变；公开活动不授予远端工具调用、审批或结果确认权限。

## 协议 Task、事件提交与产品事实

生成的 remote Task/context 在 Server 准入前原子持久化。相同 Message ID 的重复输入
保持原地址、原回执和单份历史；不同正文拒绝。继续输入从私有持久 pending interaction
取得原 Run/revision/kind，而不是从远端 metadata 获取恢复权限。该 continuation 随消息
意图固定，丢失响应后再次提交不会取错下一道问题。

Task、event UUID 摘要、文本快照、投影游标和 product 生命周期 outbox 在同一次私有
文件提交中更新，随后才 ACK 准入层的事实游标。崩溃允许重放；UUID 相同而内容不同、
序号倒退、Session/Run 漂移和终态冲突拒绝。runtime 完成事实与 canonical control
完成边界必须同时存在，才能标记 TASK_STATE_COMPLETED。EOF 或订阅异常保留已有状态，
返回结果未确认；接收取消回执也不能直接标为 CANCELED。

文本支持 append/replace、完整有序多 part 快照和 output_refs 的选择顺序。默认不公开
reasoning；可信 Host 可显式开启。input-required 只发布 schema/公共 presentation，
保留 ADK v2 集成、输出快照和 thought Part 标记；空 output_refs 按参考行为回退到
按创建顺序收集的消息文本。终态前关闭尚未结束的 artifact chunk。
私有 interaction/revision/permit 不写进公开 Task。SSE event ID 基于持久事实 UUID；
断开 SSE 只停止观察，不发取消或新消息。新订阅先返回当前 Task，再读取原 Run 事实。
终态订阅按参考实现返回 unsupported；等待输入是当前流的边界。

`returnImmediately` 会启动该 Host 生命周期内的原事实观察。可信事件端口提供
`read(sessionId, afterSeq, limit, { signal })` 时，GetTask 和 SubscribeToTask 在返回或
检查终态前同步读取原 Run 的有序持久日志。每页最多 100 条、单次最多 100 页；复用
订阅的身份/Run/事实校验及原 Task 同事务投影，原消息和命令不重新准入。空页只代表
当前日志末尾，不代表任务完成；中断、取消等状态必须来自真实 control 事实，completed
仍须对应 runtime 完成事实。读取失败或超过限额明确失败，不回退为伪造完成。
只有 subscribe 的旧可信端口仍返回持久缓存并启动原观察；它不具备同步冷查询保证。
跨 Host 的永久订阅消费者仍未组装，不能用单 Host 冷恢复证明该能力。

Managed Native Kernel 的可信 `events` 端口现已提供上述 `read`：直接读取当前实例的
SQLite canonical journal，先投影已提交的 Native 事实，再按 LIMIT 返回；不启动接受的
命令，不创建新 Run，也不从 HTTP 暴露无 permit 的查询。现有 bootstrap 已将这个端口
自动提供给未覆盖 events 的 `nativeA2aInbound`，无需调用者另行实现。真实 Managed
Kernel 的准入前读取、两条分页、取消、冷重开及原 Run 完成投影通过两个定向用例，
没有新增模型调用；记录见 `.artifacts/native-migration/a2a-managed-finite.log`。

此批对照参考 `355059d` 的 `a2a/tool_activity.py`、`presentation.py` 和
`kernel_task_adapter.py` / `protocol_errors.py`。只运行直接受影响的
`native-a2a-inbound-{kernel,task-store,server}.test.mjs`、`native-a2a-tool-activity.test.mjs`，
共 165 个用例初次通过 164 个；新增 emoji fixture 因实际单事件省略策略修正后，仅重跑
6 个新增用例，全部通过。检查覆盖真实鉴权 HTTP、冷重开、有限分页、白名单脱敏、
旧 consumer 及累计截断。日志位于 `.artifacts/native-migration/a2a-ingress-{final,targeted}.log`。
未重复全仓回归、Node 双版本、打包安装或线上部署。

product 调用者的 running/waiting/completed/failed/interrupted/cancelled control facts 与
Task 同事务入 outbox。已有共享 dispatcher 使用新的 `a2a-task-sink` workload token
调用 `AppendA2AProductKernelFacts`，保留平台 Task/version 和 remote Task/context。
丢失 ACK 仅重送相同事实 UUID；冷启动重送已有 outbox，不重新调用模型或准入。
Server 端事实幂等是必要前提。共享 PostgreSQL、Server-owned recovery cursor 扫描和
已确认 outbox 的安全整理尚未实现；每个私有 Task/准入日志仍限 8 MiB。

验证包含实际本地 HTTP 的两种协议、SSE、继续/取消、签名探针、owner 隔离、product
丢失 ACK，以及实际独立进程在投影前和投影后/ACK 前被 SIGKILL 后的重放。完整打包、
Node 22 和真实 maintained DSH WebServer 挂载证据记录于对应 checkpoint。受控事实源
不代替 Server-command-to-Node 执行验收。

新增接收器已有真实 Native 执行和事实存储的单机器证明，详见[命令执行接线](native-managed-kernel.md)。
还需贯通：正式 Server 互操作与 Agent/Build 生产 binding、完整控制能力；
永久订阅；共享 managed 存储、产品 recovery scanner 与全新部署。
公共 tool activity producer 已由 `native-a2a-public-tool-producer.mjs` 接入实际 Task
投影和协议服务；对应可信字段白名单、持久重开及认证 wire 用例已存在，不再列为缺失实现。

入站消息 artifact 仅发布文本，以及显式启用的推理文本。这与固定参考提交的
`ksadk/a2a/executor.py` 中 `ItemUpdated` / `ItemCompleted` / `ItemSnapshotReplaced`
分支一致：仅处理 `TextContent`，不把其他内容转换为出站附件。不能把另一方向的
`events/adapters/_a2a_snapshot.py`（远端文件到本地 canonical 内容）误算为此入口的
媒体发布要求。Node 的远端文件消费仍属于独立出站调用路径。

GetTask/SubscribeToTask 的即时持久事实核对已经接入：`execute` 在返回非终态 Task 前
调用 `admission.reconcile`，沿原接收回执、Session、Run 和已确认游标分页读取，不提交
新 Server 命令，不重新执行 Native。核对与 Task 投影提交之后才推进原接收游标。
`tests/native-a2a-inbound-server.test.mjs` 的 cold GetTask 用例覆盖 Host 重启后的
原 interrupted→failed、重复读取保持原 Task、接收命令仍为一个；历史专项日志
`.artifacts/native-migration/a2a-ingress-targeted.log` 记录该用例通过（6 项专项均通过）。
本次依据现有代码及原始日志纠正清单，没有重新执行测试，也不将历史证据写成当前全量通过。
现有出站调用和显式订阅的验收见
[内部 A2A](native-a2a-internal.md)；完整迁移门槛见[迁移状态](native-migration-status.md)。
