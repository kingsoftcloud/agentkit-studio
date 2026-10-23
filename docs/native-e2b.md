# Native E2B 接入进度

Node SDK 依赖固定为 `e2b@2.58.0`。`src/providers/native-e2b-sdk-transport.mjs` 提供真实 SDK 到后台命令 supervisor 的适配：

- `start` 使用已授予的 sandbox，调用 `commands.run(..., {background:true})`；秒预算转换为 SDK 毫秒预算。
- `reconnect` 只调用原 sandbox、原 PID 的 `commands.connect`，不会因命令不存在而重新启动。
- SDK stdout/stderr callback 转为有界 async iterator；`handle.wait()` 的 `CommandExitError` 保留非零退出码，网络错误不能凭同名字段伪造已完成。
- 输出超出缓冲上限报告未知，即使 SDK 随后提供零退出码也不能覆盖证据缺失。断开连接不会停止远端进程；停止命令或 sandbox 只接受异步 SDK 返回的严格布尔值 `true`。
- API HTTPS origin、domain 和凭据由 Host 明确提供并固定；禁用 SDK 自动请求重试。拒绝环境中的 `E2B_SANDBOX_URL` 覆盖，避免共享 Host 环境改写原 sandbox 的目标地址。绑定摘要不包含明文凭据。

工厂 `createNativeE2BSdkTransport({connection:{apiUrl,domain,apiKey,headers},sandboxId})` 只负责传输。它不会创建 sandbox；缺少 Host 授予的身份就拒绝命令。`createNativeE2BSdkLifecycle` 为可信生命周期拥有者提供真实 SDK 的创建、只读查询与清理接口，固定 template、sandbox 超时、环境和 `allowInternetAccess` 策略；策略进入绑定摘要。创建返回后即使已经取消，也先保留已创建的实际身份供拥有者核对。

`createNativeE2BSandboxOwner` 固定 scope、Session、工作区及后端绑定摘要，将创建/关闭意图先 fsync 落盘，再调用生命周期接口。SQLite 进程锁协调并发；创建成功且原调用身份、signal 与同步 authority 仍有效时才进入 ready。创建失败、中断或迟到返回进入 unknown，保留已知 sandbox 身份；新请求不能把未知创建重跑为第二个 sandbox。关闭先进入 closing，只有原拥有者当前 fence 下的严格 `true` 才成为 closed。后端配置变化不能借旧记录切换地址或凭据。

真实 Node 子进程在创建 API 入口直接退出后，重开原目录会把未完成创建标记为 unknown，且不再调用创建接口。另验证并发只创建一次、取消/身份漂移、跨 Session/配置隔离、异步清理和迟到 fence 拒绝。拥有者只接收 Host 的明确同步 authority 回调，不将 Promise 当成授权；回调必须由实际 Native ledger/lease 提供。

拥有者提供显式 Host 核对接口：`inspectReconciliation()` 返回原记录及其摘要；`reconcileAdoption(request, {sandboxId, expectedRecordDigest})` 需要独立的同步 `assertReconciliationAuthority(request, decision) === true`。普通命令授权不能代替核对授权。Host 注入生命周期的 `inspectSandbox`，经原控制平面 `Sandbox.getInfo` 只读验证原 sandbox ID、运行状态、`nativeOwner` 与原 `nativeCreateOperation`，再将同一创建接管为 ready；审核期间记录、身份、signal、decision 或权限变化都会拒绝。未知关闭不能借此重新激活；已知 ID 不允许替换。核对审计保留原状态/记录摘要和当前操作身份。该接口不证明任何后台命令完成，也不重放未知命令。无法确认创建不存在时，仍保留 unknown，不自动创建替代实例。

`src/providers/native-e2b-host.mjs` 提供 Host 组装工厂，将显式配置、SDK 生命周期和持久 sandbox 拥有者绑定到 scope 与 Session。配置在异步 SDK 加载前快照，保留 KsADK 的 template/timeout/internet/type/traffic-source 配置与 Skill Runtime 的回退字段。只把显式 `sandboxEnvironment` 送进 sandbox，不复制 Host 环境。公开 binding 仅含策略与不透明摘要；凭据只通过可信的 supervisor 构造端口传递，不能归档到 Build 或工具结果。地址、凭据、模板、策略或 sandbox 环境变化后，原 sandbox 记录拒绝借用。

Studio 的 Native Harness 命令后端默认仍为 `local_process`，显式 `KSADK_SANDBOX_BACKEND=e2b` 需要 `E2B_API_URL`（HTTPS origin）、`E2B_DOMAIN`、`E2B_API_KEY` 和 `KSADK_SANDBOX_TEMPLATE_ID`（或 `KSADK_SKILL_RUNTIME_TEMPLATE_ID`）。后端选择器拒绝不支持的值，不回退本地；E2B 工厂也不探测或改写 API 地址。生产 Native gateway 已组装命令选择、正式工具、原 DSH 权限管线及持久后台 store；配置摘要参与 Build 与恢复绑定。DSH Native/Codex 的交互命令现也接入独立 DSH Node 适配器，见下节。

上述核对接口的 Studio 人工操作入口还需补齐；线上执行、远端进程恢复、`run_code` 和 Frozen 配置导出仍未闭环。当前不能把这些模块视为 Studio E2B 已完成迁移。

定向验证覆盖 SDK 适配与拥有者，并包含真实 Node 进程在创建或核对查询过程中退出后重开、未知状态禁止重新创建、精确核对授权、元数据不匹配、已审核记录变化、迟到权限撤销和清理未知禁止接管。

实际打包验证：`node scripts/verify-studio-native-e2b.mjs --source <已构建维护 SDK> --archive <Studio.tgz> --keep`。Node 26.5 与 22.19.0 下通过真实 Host、DSH SDK 和 E2B JS SDK（无传输替身），使用合成凭据和不可用的 HTTPS 地址，验证组件/沙箱状态、创建结果未知、绝对路径本地回退标记未写入，以及原进程退出后新 Host 读取同一历史。精确核对两次模型、三次真实工具准入、持久 unknown owner/原意图/回执；新进程恢复后公开未知结果和定位信息、整个账本及 owner 字节不变，没有新 prompt 或派发。失败或超时不被包装成成功恢复；只将测试 fixture 放入解包目录，生产代码来自记录了 SHA 的归档。

该验证也复现并修复了 unknown 工具回执在会话中被错误显示为 `not_dispatched` 的问题。中断轮次保留原所有权以供显式恢复。此验证使用已安装的固定依赖图，不能作为全新安装、线上 E2B 成功执行或远端进程恢复证明；没有使用云端密钥发起在线请求。


## DSH Native / Codex 的交互式 Node 命令

正式 builtin 工厂现按 `KSADK_SANDBOX_BACKEND` 选择本地或 E2B，四个工具
`sandbox_status`、`run_command`、`read_command_output`、`stop_command` 均经过原 DSH
ToolRegistry、sandboxPolicy、一次审批和后置策略。显式 E2B 配置不完整会拒绝准入，
不会改用 Host 本地执行。当前命令监督器支持 macOS/Linux；其他 Host 平台会在 SDK
进入前明确拒绝。Skill 工作流后端仍可独立配置。

`agentkit.dsh-node-e2b-command-tools/v1` 使用真实 Agent/Session/call，复用原生 Node
SDK 生命周期、命令监督器与外置 DSH 持久账本。共享底层命令契约为
`agentkit.dsh-e2b-command-tools/v1`。DSH 后台引用使用 Agent/Session/sourceCallId/
operationKey/taskId，不制造 Native sourceRunId 或 fence；原 Native 的引用与定位
算法保持兼容。Agent revision、Frozen Build 和后端连接进入不可变绑定，旧 call 或
旧任务不能在改变绑定后被借用。

调用审批后、SDK 进入前先 fsync 意图和确定的 taskId。创建/执行结果未知及真实
SIGKILL 留下的未完成意图在重开时只返回原定位，不再导入 SDK 或重发命令。外部
副作用不宣称 exactly-once。任务索引只是定位，读取和停止必须同时核对原启动账本、
Agent/Session、完整绑定、taskId 和 operationKey；外来任务在 SDK 进入前拒绝。
取消/Host 关闭后不发布新的已完成效果；独立后台进程保留自己的超时和监督生命周期。

`timeout` 限制前台进程，`background_timeout` 独立限制后台进程，读取等待不会延长
进程期限。停止请求与终态分开；只有观察到确认终止才能报告取消，证据不全保持未知。
前台结果现在显式包含进程 `status`。SDK 只接收调用方显式 env，不继承 Host 环境或
凭据。前台输出按 UTF-8 字节游标收齐保留内容后，再生成有界展示和完整附件，修复了
原先附件只包含首个 64 KiB 窗口的问题；保留内容收集上限为 16 MiB，超过时保留原
任务并报告证据未完整交付，不能伪称完整输出。

受影响 11 个模块在 Node 26.5.0 / 22.19.0 各通过 152 项；随后对变化的新适配器模块
单独复验，各 16 项通过。覆盖实际 Bash、副作用计数、非零退出、120 KB 精确输出、
UTF-8 游标、前台超时、后台确认取消、未知创建晚返回、并发、绑定漂移、权限变更、
Host 关闭、真实 SIGKILL 和真正新 Node PID 重开。这里的 SDK 控制面是明确替身，
不能证明线上 E2B 或远程 OS 隔离。

生产安装包验证可指定两个后端：

```sh
node scripts/verify-studio-node-builtins.mjs --source <已构建维护 SDK> --archive <Studio.tgz> --command-backend e2b --skill-backend e2b --keep
```

E2B 模式使用实际安装 SDK 和明确拒绝连接的 HTTPS 地址，检验两个 runtime 的正式
Host/preset/SessionController/ToolRegistry、持久未知创建、重复抑制、审批、后置策略
及跨会话拒绝。旧 Host PID 实际退出后，新 PID 重开原 call 和会话，原账本/owner
字节不变，不增加目录请求、下载或命令。本地模式保留原实际脚本、完整输出、取消、
文件和 Web 断言。Host PATH 仅含 Node/bash，Python 配置不可用；复用固定依赖图，
不是全新安装、线上 E2B 成功执行、模型对话或 Codex CLI 验收。

尚未闭环：线上创建/执行/重连/清理、显式人工核对/接管/清理产品入口、`run_code`、
参考实现的空闲回收/会话容量控制及相关时间状态字段、Frozen 配置导出和全产品入口。
其他 builtin 的 Python fallback 仍在，不能据此宣称整体迁移完成。
