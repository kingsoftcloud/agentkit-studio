# Native E2B 接入进度

Node SDK 依赖固定为 `e2b@2.58.0`。`src/providers/native-e2b-sdk-transport.mjs` 提供真实 SDK 到后台命令 supervisor 的适配：

- `start` 使用已授予的 sandbox，调用 `commands.run(..., {background:true})`；秒预算转换为 SDK 毫秒预算。
- `reconnect` 只调用原 sandbox、原 PID 的 `commands.connect`，不会因命令不存在而重新启动。
- SDK stdout/stderr callback 转为有界 async iterator；`handle.wait()` 的 `CommandExitError` 保留非零退出码，网络错误不能凭同名字段伪造已完成。
- 输出超出缓冲上限报告未知，即使 SDK 随后提供零退出码也不能覆盖证据缺失。断开连接不会停止远端进程；停止命令或 sandbox 只接受异步 SDK 返回的严格布尔值 `true`。
- API HTTPS origin、domain 和凭据由 Host 明确提供并固定；禁用 SDK 自动请求重试。拒绝环境中的 `E2B_SANDBOX_URL` 覆盖，避免共享 Host 环境改写原 sandbox 的目标地址。绑定摘要不包含明文凭据。

工厂 `createNativeE2BSdkTransport({connection:{apiUrl,domain,apiKey,headers},sandboxId})` 只负责传输。它不会创建 sandbox；缺少 Host 授予的身份就拒绝命令。`createNativeE2BSdkLifecycle` 为可信生命周期拥有者提供真实 SDK 的创建与清理接口，固定 template、sandbox 超时和环境；创建返回后即使已经取消，也先保留已创建的实际身份供拥有者核对。

`createNativeE2BSandboxOwner` 固定 scope、Session、工作区及后端绑定摘要，将创建/关闭意图先 fsync 落盘，再调用生命周期接口。SQLite 进程锁协调并发；创建成功且原调用身份、signal 与同步 authority 仍有效时才进入 ready。创建失败、中断或迟到返回进入 unknown，保留已知 sandbox 身份；新请求不能把未知创建重跑为第二个 sandbox。关闭先进入 closing，只有原拥有者当前 fence 下的严格 `true` 才成为 closed。后端配置变化不能借旧记录切换地址或凭据。

真实 Node 子进程在创建 API 入口直接退出后，重开原目录会把未完成创建标记为 unknown，且不再调用创建接口。另验证并发只创建一次、取消/身份漂移、跨 Session/配置隔离、异步清理和迟到 fence 拒绝。拥有者只接收 Host 的明确同步 authority 回调，不将 Promise 当成授权；回调必须由实际 Native ledger/lease 提供。

Host 的命令工具选择、审批、sandbox 生命周期调用与后台 store 接线仍未完成；未知创建的人工/平台核对入口还需补齐。后台命令状态与恢复模块另行审查。当前不能把这些模块视为 Studio E2B 已完成迁移。

Node 26 与 Node 22.19 的 29 项定向测试已通过：16 项 SDK 适配、13 项拥有者与进程中断。最后调整未知状态错误契约后仅复验拥有者 13 项。SDK 验证包含实际安装包的离线加载与确定性接口替身；未使用云端密钥发起在线请求，也未宣称远端进程或完整 Host E2B 验收通过。
