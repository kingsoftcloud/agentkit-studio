# A2A 入站签名与持久准入基础层

这批实现包含 Gateway 身份验证、Server 接收/取消 Action、私有准入日志和 Kernel
事实归属过滤。**尚未把完整 A2A 协议服务挂载到 Studio，也没有把 Server 的命令
接收和 Session 事件存储接到当前 Node Native 执行器。** 模块通过不代表入站已经可用，
更不代表完整迁移已经完成。

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

还需实现并贯通：AgentCard/JSON-RPC/REST/SSE 协议挂载；owner/context-scoped
TaskStore 与协议投影；Server 命令接收及 Node Session 事实存储；产品 Kernel fact
outbox；共享 managed 存储与全新部署。现有出站调用和显式订阅的验收见
[内部 A2A](native-a2a-internal.md)；完整迁移门槛见[迁移状态](native-migration-status.md)。
