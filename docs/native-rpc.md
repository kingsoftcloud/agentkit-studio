# Native 外部进程接口

`@kingsoftcloud/agentkit-harness-node` 提供 `agentkit-native-rpc`，通过标准输入输出上的 JSON-RPC 2.0 / NDJSON 调用同一套 TypeScript NativeKernel、SQLite 存储和模型适配器。Node >= 22.19。无需启动 Studio 或 DSH。

当前包保持 private，通过本地 tarball 安装；本轮未发布 npm，也未实现 Python SDK。Python 或其他语言可按下面的协议启动子进程并交换 JSON；不能直接 import npm 包或传递任意 Python 回调。

## 启动

先设置 `NATIVE_MODEL_PROTOCOL`（openai-chat、openai-responses 或 anthropic-messages）、`NATIVE_MODEL_BASE_URL`、`NATIVE_MODEL_NAME`、`NATIVE_MODEL_API_KEY`。密钥仅保留在进程内用于模型请求头，不写入任务账本。

```sh
agentkit-native-rpc --db ./state/runs.sqlite --ledger ./state/requests.sqlite \
  --workspace ./workspace --permissions workspace:read,workspace:write
```

工作区须已存在。默认不授予文件权限；`--permissions workspace:read` 仅开放 read，显式加入 workspace:write 才开放 write。协议请求不能改变模型、租户、工作区或权限。内置文件工具限制单文件 1 MiB，拒绝越界及符号链接路径；假设没有不受信任的进程并发替换工作区目录，操作系统级隔离由宿主提供。

配置在启动时冻结。重启时若工作区、权限、模型绑定（包括凭证指纹）或运行限制变化，恢复及重复提交返回 `-32004`，不会拿新配置执行旧任务。需要显式迁移策略才能跨配置恢复。每套存储由一个宿主进程持有；scope 固定在启动参数中，不是公开网络多租户服务。

可选参数：`--owner`、`--scope-tenant`、`--scope-workspace`、`--scope-user`、`--scope-agent`、`--max-model-calls`（默认 8）、`--lease-ms`（8000）、`--effect-timeout-ms`（60000）、`--request-timeout-ms`（45000 或环境中的 NATIVE_MODEL_REQUEST_TIMEOUT_MS）、`--exec-log`。请求超时及工具超时须小于 effect 超时。

## 协议

每行一个 JSON 对象；stdout 只输出协议，诊断写 stderr。响应可乱序，用 JSON-RPC `id` 对应请求。无 id 的通知没有响应。不支持 JSON-RPC 批量数组。客户端应保持 stdin 打开。

| 方法 | params | 结果 |
| --- | --- | --- |
| initialize | 可省略 | protocolVersion: agentkit.native-rpc/v1、工具、权限和限制 |
| task/submit | requestId、objective | runId、accepted/pending/completed、可选最终结果 |
| task/status | runId | phase、outcome、reason、finalText、usage、eventSeq、terminal、driving |
| task/subscribe | runId、cursor（默认 0）、waitMs（默认 25000，最大 60000） | seq 大于 cursor 的事件、新 cursor、terminal |
| task/cancel | runId、commandId | accepted/duplicate/rejected 及 reason；查询 status 确认实际状态 |
| task/resume | runId | driving，或 closed + driving:false + 最终结果 |

```json
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"task/submit","params":{"requestId":"research-001","objective":"Read note.txt and summarize it."}}
```

收到 runId 后，通过 task/status 查询或 task/subscribe 从事件游标继续读取。completed 只表示执行结束；未装配验证器时 outcome 为 unverified，不能当作业务验收通过。

业务 requestId 与 JSON-RPC id 分开：同一 scope 内，同一 requestId + objective 返回原 run；不同 objective 返回冲突。requestId 最长 256 字符，objective 最长 262144 字符。请求先校验，再记录持久化准入；runId 使用 requestId 的完整 SHA-256。请求账本与运行账本都必须保留，不能只删其中一个以“重试”。两次提交之间的崩溃通过确定性 runId 找回原准入，不启动第二份任务。

SIGTERM、SIGINT 或 stdin EOF 会取消当前驱动，等待其退出并关闭存储。硬崩溃后需重新启动同一配置并调用 task/resume 或重交原 requestId。恢复仍受内核重放策略与预算约束；当前入口恢复重试预算为 0，未知模型调用会中断，执行结果未知的写操作不会自动重放。取消不撤销已经发生的副作用。

## 错误与验收

以下构建和验证命令在独立的 `ksadk-harness` 仓库中执行。

标准错误：-32700 解析失败，-32600 请求格式错误，-32601 方法不存在，-32602 参数错误，-32603 内部错误。业务错误：-32001 requestId 冲突，-32002 run 不存在，-32003 暂不能驱动，-32004 原配置变化，-32005 正在关闭。

```sh
npm ci --ignore-scripts
npm run build
npm run test:node
npm run verify:rpc
```

协议和进程测试使用真实 NativeKernel 与 HTTP 模型适配器，对端是明确标注的本地受控响应服务。包括取消并发、事件游标、SIGKILL 后恢复、写入后崩溃不重复执行。安装验收将两个包打包并安装到全新目录，执行已安装 bin，检查独立依赖边界、文件读写、幂等和冲突；不代表真实模型任务质量已经通过。
