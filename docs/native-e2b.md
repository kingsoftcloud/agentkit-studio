# Native E2B 接入进度

Node SDK 依赖固定为 `e2b@2.58.0`。`src/providers/native-e2b-sdk-transport.mjs` 提供真实 SDK 到后台命令 supervisor 的适配：

- `start` 使用已授予的 sandbox，调用 `commands.run(..., {background:true})`；秒预算转换为 SDK 毫秒预算。
- `reconnect` 只调用原 sandbox、原 PID 的 `commands.connect`，不会因命令不存在而重新启动。
- SDK stdout/stderr callback 转为有界 async iterator；`handle.wait()` 的 `CommandExitError` 保留非零退出码，网络错误不能凭同名字段伪造已完成。
- 输出超出缓冲上限报告未知，即使 SDK 随后提供零退出码也不能覆盖证据缺失。断开连接不会停止远端进程；停止命令或 sandbox 只接受异步 SDK 返回的严格布尔值 `true`。
- API HTTPS origin、domain 和凭据由 Host 明确提供并固定；禁用 SDK 自动请求重试。拒绝环境中的 `E2B_SANDBOX_URL` 覆盖，避免共享 Host 环境改写原 sandbox 的目标地址。绑定摘要不包含明文凭据。

工厂 `createNativeE2BSdkTransport({connection:{apiUrl,domain,apiKey,headers},sandboxId})` 只负责传输。它不会创建 sandbox；缺少 Host 授予的身份就拒绝命令。Host 仍需实现并接入 sandbox 创建的执行意图、持久化归属、审批、命令工具绑定和清理，后台命令状态与恢复模块另行审查。当前不能把此文件视为 Studio E2B 已完成迁移。

Node 26 与 Node 22.19 的 12 项定向测试已通过，包含实际安装 SDK 的离线加载、确定性 SDK 接口替身、输出/退出/重连/取消/目标身份/缓冲上限边界。没有使用云端密钥发起在线请求，也未宣称远端进程或完整 Host E2B 验收通过。
