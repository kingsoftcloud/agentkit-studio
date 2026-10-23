# Native 原工具回执核对

独立 TS 核心新增显式策略 `ToolDefinition.recoveryPolicy = "receipt-observation/v1"`，
用于可能已产生副作用、但执行结果尚未确认的单次工具调用。它与 `safe-read/v1`
不同：原调用永远不重发。Studio 的 Native A2A 工具已接入此策略、认证核对操作和
原运行等待界面；其他工具与后端仍需分别验收，不能据此宣称全部恢复产品能力完成。

## 账本契约

工具返回 `uncertain`、异常、超时，或运行进程丢失已领取的调用后，核心保存原回执，
进入非终态 `awaiting_reconciliation`。原工具调用、规范调用 ID、待处理工具队列和
模型协议配对保留；原尝试只记一次工具用量。已有 `interrupted` 等终态不会重开。
未启用该策略的历史配置仍保持原行为，不自动升级配置或改写配置摘要。

调用 `kernel.reconcileTool(scope, runId, originalOperationKey, commandId)` 只提交命令，
不接受客户端提供的结果。下一次驱动原运行时，核心先持久化独立的 `tool_receipt`
意图并消费命令，然后以新的 lease/fence 调用 `tools.observeReceipt(request)`。
契约为 `agentkit.tool-receipt-observation/v1`，请求包含原操作键、原 claim fence、
完整原工具调用、定义及原运行身份。新的操作键仅授权只读核对；原 fence 不被复用。

宿主必须从实际持久化服务或外部系统核对原调用，固定原归属、服务绑定及远端任务，
不能重新发现替代目标、发起原工具或将界面显示当作成功回执。响应必须绑定原操作键
和规范调用 ID，只可包含 `ok` / `error` 的实际结果；`null` 表示仍未确认。
子任务、Browser 和后台命令等独立所有权能力不通过这个契约生成。

确认结果以新查询回执、`tool.receipt_reconciled`、原工具完成事件及模型工具消息在
同一事务追加。原未知回执保留不变，后续工具、PostToolUse 和模型继续沿用原运行。
`result.resourceUsage` 是相对原未知回执的**新增用量增量**，不是包含已上报用量的
累计值；适配器必须明确换算。已知用量、用量事件和不完整诊断不会因核对而清零。

未知、无端口、错误身份、无效结果、查询超时和查询进程丢失均回到显式等待；同一
命令不会自动重查，新的人工核对使用新命令 ID。取消和权限撤销可终止原运行；
迟到回执与过期执行者不能继续它。暂停不会隐式发起查询，steer/guide 不能绕过等待。
外部任务的输入、审批及绝对 deadline 仍由宿主的原任务控制契约负责。

## 当前验证范围

确定性 Memory/SQLite 用例覆盖重复命令、数据库重开、身份拒绝、UTF-8 大小约束、
无端口、原用量与新增用量、PostToolUse、取消与租约丢失后的迟到结果。
真实本地 HTTP 与 SQLite 子进程在三处执行 SIGKILL：原效果请求后、等待提交后、
回执查询途中；新 PID 核对后继续同一运行，原效果始终只有一次。

Studio 定向测试使用实际 Native Host 服务、SQLite、Kernel、工具网关和 HTTP 模型/
A2A 协议，覆盖远端补充输入后继续同一 Run、响应丢失后的同命令确认、非终态等待、
错误操作和修改后的 preset/revision 拒绝，以及取消后迟到回执不能恢复运行。
SessionController、工具注册与审批使用明确的窄替身；不代表完整挂载 Host/Electron。
实际 SIGKILL 后的独立新进程还验证生产 A2A 网关：已知远端 task 才能 GetTask 并继续；
发送已发生但 task 未知时继续等待，既不重新发现也不重发 Send。

完整挂载 Host 的专项验证现在也覆盖真实 SessionController、预设恢复、认证 HTTP
接口与持久会话。等待时 SIGKILL 后，新进程只恢复历史和读取状态，不改动原 Native
账本；明确核对才查询原远端任务并继续同一 Run/turn。查询途中再次 SIGKILL 后，
显式恢复将丢失的读取归为等待；确认同一命令不会再查，新命令才重新 GetTask。
每条流程仅有一个原 Send、一次发现、两个模型请求；原工具意图和未知回执保留，
原产品回合最终只结束一次。Node 22/26 均已执行这两条流程。

```sh
node scripts/verify-studio-native-a2a.mjs --source <维护版DSH目录> --archive <Studio.tgz> --reconcile-cold --keep
node scripts/verify-studio-native-a2a.mjs --source <维护版DSH目录> --archive <Studio.tgz> --reconcile-cold --receipt-crash --keep
```

验证进程使用只有 Node 的 PATH 及无效 Python 路径。模型和 A2A 是真实本地 HTTP
确定性服务，依赖链接到已有安装；夹具从当前源码覆盖到提取包并记录摘要，不能把
它当作全新安装、线上模型、Electron 或真实人机审批验收。该场景由独立远端服务
完成原任务，未模拟人工批准补充输入。证据输出在控制台标明的私有临时目录，
包括原账本、进程 PID/退出信号、HTTP 计数与 `mounted-a2a-recovery-evidence.json`。

这些不代表真实模型、其他远程后端或 Electron 已验收。整体状态见
[native-migration-status.md](native-migration-status.md)。

## Studio 操作与配置

新建 Native A2A 配置的 `call_a2a_agent` 正式定义启用该策略。DSH Native/Codex
继续使用各自的原调用控制契约。已冻结的旧配置不自动补策略或改摘要，旧 `interrupted`
终态不会重开；变更绑定导致恢复配置摘要不一致时明确拒绝。

在“运行与子任务”查看原远端任务，通过现有审批补充输入或取消远端任务。远端终态
封存后点击“核对结果并继续原运行”。该操作不接受结果、远端 URL、权限或替代运行；
认证路由 `sessions/native-recovery-reconcile` 只接受 `agentId/sessionId/runId/operationKey/commandId`。
它复核原会话归属、持久配置和可信 preset，持久化命令后唤醒原执行者，或通过现有
可信恢复入口接管原运行。接收命令不等于核对完成，界面需继续读取状态。

新 `tool_receipt` 的 lease/fence 只授权 GetTask。适配器固定原完整调用、原 fence、
原服务绑定、route/task/context，不复用旧执行权。核对成功追加新回执，原意图和未知
回执保留。远端尚未完成、task ID 未知或核对失败时仍等待，不自动重复查询。
请求响应丢失时，界面保留同一 commandId 用于确认；已消费命令不会再次查询。
再次主动核对使用新 commandId。查询不追加未知远端用量为零的断言。

仍待闭环：真实人机审批与完整浏览器消费、在线 A2A 服务、并发远端取消投递、内部
控制面和编排、文件/data 输出的完整对照，以及所有其他未知副作用的清理/继续流程。
