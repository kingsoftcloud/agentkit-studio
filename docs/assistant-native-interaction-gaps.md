# 云端原生输入：实现与能力边界

本文件描述当前源码，而不是生产部署回执。固定 DSH 基线为 `687f282e8625c6b8d11ff58211a90524be2e4317`，另有仓库维护的实例隔离和工具定义绑定补丁。DSH 仍拥有 Agent、Session、队列、工具执行和审批审计；Studio 没有另造运行时。

## 已接通的链路

1. Studio Host 根据部署回执、版本和当前 conversation 验证云端身份，再打开仅绑定该 Session 的非 owner carrier。浏览器不获得部署令牌，Build token 不升级为 Host owner。
2. 浏览器通过 DSH 公开模块加载接口创建独立 Connection、Gateway、Typert、Remote、Controller 和 UI graph。真正的 `SessionReference` 来自这个 graph；同名 Session ID、显示 home 或 generation 不能跨 Host 冒充绑定。
3. 原生 `conversation.content` 工厂呈现输入部分，工具/图片/文件历史保留现有安全原生组装器。没有导入私有 InputBar，也没有把云 Session 塞进本地 Controller。
4. 原生 prompt 转为既有 `assistant/submit`：附件先取得当前云 Session 的 receipt，指纹覆盖完整有序内容和语义字段，重复请求复用 requestId，DSH flush 成功后才确认。读连接中断不取消已接收任务。
5. 上传适配仅注册在独立 graph。实例配置为 `hostPathPolicy: upload-only`、`draftPersistence: memory-only`、`submissionActions: queue-only`；不会读取全局本机路径 hook，不会以云 ID 读写本地 DSH 草稿。原生 Stop 复用输入框发送按钮，carrier 只转发当前会话的运行状态并放行绑定会话的 `session/cancel`；steer 仍被关闭。自定义输入框与旧镜像继续使用精确回合停止接口。
6. 原生发送未知 ACK 时输入会恢复失败草稿。确认使用原 journal/requestId，成功后只按原内容指纹、草稿版本和附件身份清理对应恢复稿；后来编辑的草稿保留，不能把已确认内容当新任务再次发送。

## carrier 白名单与生命周期

原生 Peer 仅允许当前 Session 的 page、projections、follow，以及结果经过过滤的 list/control。prompt 和 file upload 是外层有界适配，不直接授予 Peer 原生写能力。commands、模型/权限设置、任意 Remote、审批 waterfall 回答和本机文件路径均不可经此 carrier 调用。

`native-open/call/stream-open/stream-poll/stream-cancel/close` 具有数量、并发、字节和超时上限。最多 4 个 carrier、每个 8 个流、12 个同时调用；单帧最多 256 KiB。读取消释放读资源，durable submit 不继承视图 AbortSignal。关闭 graph 释放引用、上传任务、流与远端 Peer。较大的文件上传仍走已有专用上限入口，而非提高普通控制 RPC 限制。

在线事实必须来自实际消费到的原生 ready 与后续事件轮询，期限为 35 秒；普通 RPC 或快照不续期。一个 Session 的多个已连接页面按实际在线 carrier 合并。最后连接失效时撤销未完成审批，但不停止后台常规任务。此在线事实不是人类批准，也不是持久权限。

## 隐私投影不是原始日志

`assistant-public-projection/v1` 是展示协议。每个源记录保留 seq/time，私有非 surface 事件变为明确 ignorable 占位；surface 节点以合法空内容保留位置及经过 schema 白名单校验的替换引用。不会为凑序号伪造工具调用、审批或用户操作，不改写原始日志，也不允许将展示投影用作执行或重新导入的上下文。

只开放 inbox、turnBoundary、sessionListMetadata 等必要投影。私有请求上下文、推理、provider 配置、原始工具参数/诊断不进入客户端。逐 chunk 文本不能安全识别跨 chunk 凭据，因此 live 流正文清空，落盘后的完整消息才经展示脱敏。超过预算的正文显示明确截断/省略说明；极长连续 token 整段隐藏，避免脱敏正则耗时放大。compact stream 展示数组可以省略，真实 attempt/revision/index 仍保留并经原生验证。

历史请求默认限制为 16 条可见消息，并按真实 JSON 字节选取连续尾页；分页游标、hasMore、源序号及 surface 引用保持一致。inbox 超限先省略正文但保留所有位置/id/rpcId，不能伪造空队列。若仅必要身份结构本身仍超过硬上限则明确失败；要支持无限大的单次队列 baseline，仍需上游分页 inbox 或独立回显摘要契约。

## 审批与权限

新助理明确选择 `workspace-managed/v1`，使用真实持久 workspace-write/ask 策略。既有助理不自动迁移；不存在“先写 ask，完成后写回 never”的临时授权。详见[权限模型](assistant-permission-model.md)。

专属工作区内官方读、写、编辑及固定搜索模板可自主执行。当前默认敏感操作是单个普通文件删除：具体路径、大小、摘要和文件身份绑定到本次调用，提出请求及接收原生 allowed-once 决策时必须有在线连接；已通过本次决定的执行不因后续断线被追溯撤销。任意 Shell/未知 MCP、外部发送、支付、账号权限变更及越界操作没有默认可信实现，保持明确不支持，不因自然语言分类而放行。

启动先安装只拒绝的 Agent 守卫，之后才恢复 preset 和验证目录回执；缺失摘要、失败初始化、异步关闭或错误恢复都不能留下裸露的持久可写会话。已验证 model 的串行 agent/created 初始化完成后才释放正常恢复工作。最终工具派发同步核对最初定义及 execute 回调，不能在审批/guard 之后换实现，也不会二次消费一次性批准。

live approval 桥仅处理当前真实 waterfall，绑定 Host、Session、精确 Agent、回合起点、请求代次和期限。历史 audit 不可批准，失去在线连接、取消、结束、过期或重启都不能复活旧批准。上游没有非持久 per-turn policy API；本产品当前采用明确新助理配置，不声称实现该接口。

## 仍然有限制的能力

- 原生输入可用，通用原生会话管理、任意命令、权限/模型切换与 steer 不在云 graph 的支持范围。
- 可下载文件必须是当前 Session 可见的原生不可变附件引用；path-only present 仍仅元数据，见[产物边界](assistant-deliverable-download-safety.md)。
- 本机交接只有绑定/确认/拒绝协议和纯模拟执行器，生产能力为不可用。真实本机执行需要单独授权、已验证执行器和匹配权限，当前代码不会连接或读取用户电脑。
- 工作区控制基于私有运行目录及官方文件工具，不能抵御同 OS 身份恶意并发改路径的进程；不是完整内核隔离或任意程序沙箱。
- 既有助理原地权限升级及跨 Build 数据迁移未提供自动按钮；不能静默改存量配置。
- 浏览器 E2E、真实云账号/模型、镜像发布和生产部署验收必须分别记录，组件或受控 Host 测试不替代它们。

## 验证入口

- `node --test tests/assistant-native-{carrier,projection,transport}.test.mjs`
- `scripts/verify-assistant-native-carrier.mjs`：真实非 owner Gateway 与 Journal 生命周期。
- `scripts/verification/verify-assistant-native-projection.mjs`：原生 schema、surface、替换引用与 Controller。
- `scripts/verification/verify-assistant-native-size.mjs`：有界分页、超长消息/流、重连和队列身份。
- `scripts/verification/verify-assistant-native-graph.mjs`：真实双 Host Client graph、原生输入、上传与释放。
- `scripts/verification/verify-assistant-native-ui.mjs`：React/原生组件验收。
- `scripts/verification/verify-assistant-permission-model.mjs`：原生权限、文件工具、一次审批、恢复及关闭。
- `scripts/verify-personal-assistant-host.mjs`：正式安装包、受控模型的完整 Host 验收。

这些脚本使用固定 DSH checkout 与隔离目录；报告必须说明是组件、原生服务还是正式安装 Host。生产能力以实际镜像、部署和会话声明为准。


## 字节预算与分页细节

原生 Client 默认历史窗口可达 maxMessages=500、turnWindow.minMessages=50；它不是传输字节限额。产品 carrier 将 page/follow 的消息数上限收紧至 16，去除 turnWindow 最低消息/回合要求，保留精确 address、throughSeq、beforeSeq 和 assistantStream。投影后再次按真实 JSON 字节取连续尾窗，并为 256 KiB 响应封装保留 1 KiB。尾记录仍是原 cursor；被省略前缀只通过 hasMore=true 和原始序号继续分页，不重新编号。部分窗口的 replacement 引用可位于尚未加载的前缀；加载完整前缀后原生 surface fold 必须与源位置一致，不能擅自删改引用来让局部 fold 看似完整。

单条可见 message.content 的序列化上限为 32 KiB。可处理正文经过整条凭据过滤后才截取展示前缀，末尾附“展示预览已截断：源消息未改动，勿作执行输入”。源 content 超过 128 KiB，或拼接文本中含至少 16,384 字符的连续 ASCII token 时，正文整段隐藏并仅保留该说明，避免不受限的凭据正则处理和先截断再脱敏。多 block、Unicode、JSON 转义和附件元数据均计入预算；原始 Session 和模型输入不变。

compact/durable assistant replay 的公开结构超过 32 KiB 时展示为 stream=[]。baseline 的真实 attemptId、revision、nextIndex 仍保留，新 live frame 不改 index；该数组仅用于可选的历史流动画重放，不是新的模型轨迹。每个 inbox target/inserted 列表超过 32 KiB 时，保留全部 id、source.rpcId、角色、顺序和 splice 索引，仅将 content 清空；如果这些必要身份本身仍超过预算，返回安全错误，不能假装队列为空。原生协议没有分页 inbox baseline，因此不宣称可以在固定帧内完整表达任意多的身份；此极端情形需要上游分页或专用 echo 摘要协议。

capabilities.history 明确给出 maxMessages、maxBytes、messagePreviewBytes、boundedReplay、boundedInbox 和 completeSourceLog=false。该传输始终是公开展示投影，不能作为原始日志导出或执行输入。

新增真实验证：

```sh
AGENTKIT_DSH_ROOT=/path/to/pinned-dsh node scripts/verification/verify-assistant-native-size.mjs
AGENTKIT_DSH_ROOT=/path/to/pinned-dsh node scripts/verification/verify-assistant-native-projection.mjs
node --test tests/assistant-native-carrier.test.mjs tests/assistant-native-projection.test.mjs
```

大小验证使用真实 Session、原生 SessionQuery/History 实现、生产 carrier/projector 和官方独立 Client Controller；外部 RPC 路由受控，不启动模型或调用账号。覆盖 50 条各约 8 KiB 消息的首屏/完整分页/同 binding 重连、超过字节限额的 16 条窗口、单条超大正文、60,001 个真实 active chunks 的 baseline 省略及后续一次 settlement、独立 inbox baseline 与保留身份的实时 echo。源码日志不变，所有公开响应保持 256 KiB 硬上限；这不是对任意结构无限容量的承诺。
