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

Studio 的命令后端默认仍为 `local_process`，显式 `KSADK_SANDBOX_BACKEND=e2b` 需要 `E2B_API_URL`（HTTPS origin）、`E2B_DOMAIN`、`E2B_API_KEY` 和 `KSADK_SANDBOX_TEMPLATE_ID`（或 `KSADK_SKILL_RUNTIME_TEMPLATE_ID`）。后端选择器拒绝不支持的值，不回退本地；E2B 工厂也不探测或改写 API 地址。配置与生命周期的组装已有定向验证，工厂尚未挂到生产 gateway 的命令选择入口，因此设置这些变量还不能启用 Studio E2B 命令。

Host 的命令工具选择、审批与后台 store 接线仍未完成；上述核对接口的 Studio 人工操作入口还需补齐。后台命令状态与恢复模块另行审查。当前不能把这些模块视为 Studio E2B 已完成迁移。

定向验证覆盖 SDK 适配与拥有者，并包含真实 Node 进程在创建或核对查询过程中退出后重开、未知状态禁止重新创建、精确核对授权、元数据不匹配、已审核记录变化、迟到权限撤销和清理未知禁止接管。SDK 验证包含实际安装包的离线加载与确定性接口替身；未使用云端密钥发起在线请求，也未宣称远端进程或完整 Host E2B 验收通过。
