# MCP 调用身份（会话 ID / userId）

MCP 协议本身没有「当前用户」字段：`tools/call` 的 JSON-RPC 参数只有工具名和模型生成的
`arguments`。所以 Agent 调 MCP 时能不能识别用户，取决于 Host 有没有把**可信身份**绑定到这次
调用上，以及通过哪条通道送出去。

本改动分开处理两类身份，不能把它们混成一个 `userId`：

- **平台主体**：谁有权限调用这个已部署 Agent，由托管 Runtime 的可信请求 Header 鉴权得到；它用于会话归属和控制权限。
- **业务主体**：谁在业务系统里使用 Agent，由 `RunAgent` 请求的 `UserId` 传入；它用于 MCP 的业务数据分区和审计。

托管 `RunAgent` 调用例如：

```json
{
  "AgentId": "ar_xxx",
  "SessionId": "order-session-42",
  "UserId": "customer@example.com",
  "InvocationId": "request-1001",
  "ResponsesInput": "查询我的订单",
  "Stream": true,
  "ApiFormat": "responses"
}
```

MCP 收到的调用身份字段含义如下：

身份字段分两类：**关联 ID**（每次调用必定产生，和用户身份无关）与**业务归属**（只有调用方
主动声明时才有）。

| 字段 | 类别 | 含义 | 缺省行为 |
| --- | --- | --- | --- |
| `userId` | 关联 | **平台主体** | 解析到主体时转发；engine 进程内没有平台主体时缺省 |
| `sessionId` | 关联 | **Native DSH 会话 ID** | 必定存在 |
| `invocationId` | 关联 | **平台请求 ID** | 必定存在；未传 `InvocationId` 时是平台生成的 UUID |
| `nativeSessionId` | 关联 | Runtime 内部 DSH 会话 ID | 必定存在 |
| `agentId` | 关联 | 当前托管 Agent | 必定存在 |
| `runId` / `callId` | 关联 | 本轮 Run 与本次 MCP 调用 | Native/DSH 路径两者都在；Codex 路径**只保证 `callId`**——Codex 工具处理器作用域内没有 DSH Run，因此 `runId` 有意不填，见下方「契约决定」 |
| `businessUserId` | 业务归属 | **业务用户 ID** | 未传 `RunAgent.UserId` 则**不出现** |
| `businessSessionId` | 业务归属 | **业务会话 ID** | 未传 `RunAgent.SessionId` 则**不出现**，绝不用平台会话兜底 |
| `businessInvocationId` | 业务归属 | **业务请求 ID** | 未传 `InvocationId` 时等于平台请求 ID |

MCP 端因此可以这样判断：

- 只想要「这次调用是谁、属于哪次请求」→ 用 `userId` / `sessionId` / `invocationId`，它们永远在。
- 想要「业务系统里的哪个用户、哪个业务会话」→ 用 `businessUserId` / `businessSessionId`，**存在即
  调用方声明过**，不存在就表示调用方没有提供业务身份，不要拿平台 ID 反推。

`businessUserId` 和 `businessSessionId` 只存在于 Runtime 当前请求的 `AsyncLocalStorage` 上下文，
不写入 DSH prompt、模型 options 或 transcript。身份**只能**由 Host 绑定：

- 业务私有字段只由 `RunAgent` 动作的 `responsesInput()` 铸造。直连 `/v1/responses` 的调用方即使
  在 body 里写 `__agentkit_business_user_id` 也不会被采纳，其 `session_id` 也不会变成业务会话。
- 模型生成的工具参数里即使出现 `userId`、`businessUserId`、`_meta`，同样不会被采纳。
- 资源侧预配置的 `x-agentkit-*` 请求头一律被清除后重写，不会以 Host 身份送到 MCP Server。

回归证据见 `tests/mcp-invocation-identity.test.mjs`（伪造、并发、Header 清理）与
`tests/native-mcp-dispatch-authority.test.mjs`（真实 Native Kernel + SQLite + 生产 MCP 适配器 +
本地 HTTP peer 的端到端断言）。

## 传递通道

同一次 `tools/call` 同时走两条通道，服务端按自己的接入方式任选其一：

1. **JSON-RPC `_meta`（所有 transport 都支持，含 stdio）**

   ```json
   {
     "jsonrpc": "2.0",
     "id": 7,
     "method": "tools/call",
     "params": {
       "name": "search",
       "arguments": { "query": "..." },
       "_meta": {
         "io.agentkit.studio/invocation": {
           "v": 1,
           "source": "run-agent",
           "sessionId": "runtime-…",
           "userId": "aeu-or-local-user",
           "businessUserId": "customer@example.com",
           "businessSessionId": "order-session-42",
           "businessInvocationId": "request-1001",
           "nativeSessionId": "runtime-…",
           "agentId": "ar_…",
           "runId": "run_…",
           "callId": "ak-native-…"
         }
       }
     }
   }
   ```

   `_meta` 是 MCP 规范里给应用层预留的扩展位，键名按反向域名命名。**符合 MCP 扩展约定**
   （忽略未知 `_meta` 键）的 Server 不受影响；自写严格请求校验、拒绝未知键的 Server 需要按
   下面的兼容开关关闭该通道——身份通道默认开启，这一点必须由接入方确认。

2. **HTTP Header（HTTP / SSE 网关可以在 MCP 应用层之前做鉴权与审计）**

   | Header | 值 |
   | --- | --- |
   | `x-agentkit-invocation-source` | `run-agent` / `dsh-native` / `codex` |
   | `x-agentkit-session-id` | Native/平台会话 ID |
   | `x-agentkit-user-id` | Native/平台主体 |
   | `x-agentkit-business-user-id` | RunAgent 业务用户 ID |
   | `x-agentkit-business-session-id` | RunAgent 业务会话 ID |
   | `x-agentkit-invocation-id` / `x-agentkit-business-invocation-id` | RunAgent 请求 ID |
   | `x-agentkit-native-session-id` | Runtime 内部 DSH 会话 ID（存在时） |
   | `x-agentkit-tenant-id` / `x-agentkit-workspace-id` | Host scope（存在时） |
   | `x-agentkit-agent-id` | Agent ID |
   | `x-agentkit-run-id` / `x-agentkit-call-id` | 本轮 Run / 本次调用 |

   Header 由 `local-resource-adapters.mjs` 里的 `mcpFetch` 挂在**每一次** HTTP 请求上（
   `initialize`、`tools/list`、`tools/call` 都带），而不是只在建连时写死；MCP 凭证
   （`Authorization` 等）保持原样，不会被覆盖。

## 服务端怎么读

TypeScript（官方 SDK）：

```js
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const invocation = request.params._meta?.['io.agentkit.studio/invocation'];
  const nativeSessionId = invocation?.sessionId;
  const businessUserId = invocation?.businessUserId;
  const businessSessionId = invocation?.businessSessionId;
  const headerUser = extra.requestInfo?.headers['x-agentkit-business-user-id'];
  // 用 businessUserId 做业务数据分区；businessSessionId 做会话级缓存与审计
});
```

Python（官方 SDK）：

```python
@server.call_tool()
async def call_tool(name: str, arguments: dict):
    ctx = server.request_context
    invocation = (ctx.meta or {}).get("io.agentkit.studio/invocation", {})
    user_id = invocation.get("businessUserId")
    session_id = invocation.get("businessSessionId")
```

## 安全约束

- **模型参数不能选身份**：`RunAgent.UserId` 在入口校验后进入 Host 私有上下文，工具
  `arguments` 只作为业务入参原样透传；模型不能通过参数伪造另一个用户。
- **平台主体与业务主体分离**：平台 Header 决定谁能调用/控制该 Runtime，`RunAgent.UserId`
  只作为 MCP 业务分区键，不替代平台鉴权，也不参与 DSH 权限判断。
- **不进入模型和历史**：业务 `UserId` / `SessionId` 不写入 DSH prompt、模型 options 或
  transcript；MCP 请求结束后 AsyncLocalStorage 上下文即失效。
- **只转发传输安全的字符串**：值必须是可打印 ASCII、长度 ≤ 200，否则请求被拒绝或身份降级为
  「无身份」，不会把不可信字节送上 wire。
- **业务身份是通用能力，默认不强制**：调用方传了 `RunAgent.UserId` 就把业务用户透传给绑定的 MCP
  Server，传了 `SessionId` 才附带业务会话；都没传就不加任何业务字段。只有确实要按业务用户做数据分区或审计的部署，
  才设置 `AGENTKIT_MCP_BUSINESS_IDENTITY=require` 把业务身份变成必填（缺失返回
  `RUNTIME_BUSINESS_ID_REQUIRED`，同一平台会话换业务用户返回
  `RUNTIME_BUSINESS_SESSION_CONFLICT`）。这样已有的 MCP Agent 不会被破坏性升级影响。
- **严格 MCP Server 兼容开关**：若某个 MCP Server 用自写的严格请求校验拒绝未知 `_meta`，
  可设置 `AGENTKIT_MCP_INVOCATION_IDENTITY=0`（或在构造资源适配器时传
  `invocationIdentity: false`）整体关闭该通道。
- **连接的共享不泄露身份**：MCP 连接仍按资源缓存（一个资源一条连接），身份通过
  `AsyncLocalStorage` 按请求注入，两个并发会话不会读到对方的身份。
- **不覆盖 MCP 凭证**：`x-agentkit-*` 与 `Authorization` 是不同 Header；资源里配置的凭证
  Header 保持不变。

## 代码位置

| 位置 | 作用 |
| --- | --- |
| `src/providers/business-invocation-context.mjs` | 托管 RunAgent 的业务 `UserId` / `SessionId` 私有上下文 |
| `src/managed-runtime-actions.mjs` | 接收并校验 RunAgent `UserId`，把它从公开 Responses payload 中剥离 |
| `src/build-runtime-http.mjs` | 在 Runtime 执行期间建立业务身份上下文，不进入 DSH prompt |
| `src/providers/mcp-invocation-identity.mjs` | 身份规范化、`_meta` 构造、Header 注入、MCP 请求作用域 |
| `src/local-resource-adapters.mjs` | `mcpFetch` 每请求注入 Header；`callMcpTool` 注入 `_meta` |
| `src/host/services/resource-tools.mjs` | Host 资源工具执行器原样转发 `invocation` |
| `src/providers/native-dsh-tools.mjs` / `src/providers/native-mcp-invocation.mjs` | Native MCP 调用读取并组合 RunAgent 业务上下文 |
| `src/providers/codex-resource-context.mjs` | Codex 路径绑定 MCP 调用身份 |

## 已知边界

- **admission 阶段的工具目录（`tools/list`）不带业务身份**：MCP 工具目录在 Agent admission/turn
  组装阶段按资源快照发现，没有 per-user 主体。若连接是在 `tools/call` 中首次懒初始化，HTTP
  `initialize`/`tools/list` 会继承该次请求的业务 Header，但 JSON-RPC 业务 `_meta` 仍只在
  `tools/call` 上发送。需要按用户过滤工具列表的 Server 应把过滤放在 `tools/call`。
- **不要在 initialize 上绑定业务用户**：MCP 连接按资源共享，业务身份按请求注入；如果 Server
  在 `initialize` 时把用户状态写进连接级 Session，就必须改成按业务用户隔离连接，或把身份
  绑定延后到 `tools/call`。当前实现不为每个业务用户复制连接。
- **stdio 传输只有 `_meta`**：stdio 没有 HTTP 头，服务端若要读身份需解析 `_meta`；也可以按
  连接注入 env（需要 per-user 连接，本改动未做）。
- **平台 IAM 操作人与业务 UserId 是两套身份**：本方案把 `RunAgent.UserId` 作为业务主体
  转发；托管 Runtime 的平台主体仍只在可信 Header 中用于鉴权。若 MCP Server 还需要 KOP
  子账号的 `userUuid` / `accountId`，那是另一项平台身份透传需求，不能用业务 `UserId` 代替。

## 契约决定

这些是**有意**的取舍，改动前请先确认不是缺陷：

- **Codex 路径没有 `runId`**：Codex 工具处理器作用域内只有 `sessionId` / `userId` / `agentId` /
  `callId`，没有 DSH Run 标识。为了让「关联 ID 不得伪造」成立，`runId` 有意留空，而不是用
  `invocationId` 冒充。需要 Codex 侧也有 `runId` 的接入方，应先在 Codex 运行时补出真实 Run。
- **`businessSessionId` 不做兜底**：调用方不传 `RunAgent.SessionId` 时，该字段不出现。平台会话
  不会被改写成业务会话，MCP 端因此能区分「调用方声明过」和「没有提供」。
- **身份通道默认开启**：符合 MCP 扩展约定（忽略未知 `_meta`）的 Server 直接受益；自写严格校验
  的 Server 需要显式关闭（见「安全约束」）。
- **业务身份默认不强制**：只有设置 `AGENTKIT_MCP_BUSINESS_IDENTITY=require` 的部署才把
  `UserId` + `SessionId` 变成必填，避免破坏已有 MCP Agent。

## 验证边界

| 层次 | 覆盖 | 证据 |
| --- | --- | --- |
| 单元 | 身份规范化、Header 清理、`_meta` 构造 | `tests/mcp-invocation-identity.test.mjs` |
| 适配器 | 共享连接下的按请求注入、并发隔离 | `tests/local-resource-adapters.test.mjs` |
| 托管入口 | 私有 sidecar 只能由 RunAgent 铸造、require 模式、审批恢复 | `tests/managed-runtime-approval.test.mjs` |
| Native 集成 | 实际 `NativeKernel` + SQLite + 生产 MCP 适配器 + 本地 HTTP peer | `tests/native-mcp-dispatch-authority.test.mjs` |
| 真实 DSH Host | 隔离 `DSH_HOME` 的真实 Host 进程、RunAgent 到 MCP 的完整链路 | `scripts/verify-managed-mcp-identity.mjs`，由 `managed-mcp-business-identity` CI 门禁运行 |

Native 集成用例里模型与 ToolRegistry 策略层是受控替身；真实 Host 门禁再验证
「RunAgent 经 engine 进程到达 MCP Server」的完整部署路径。

## 门禁结果

本机 Node.js 26.3.0 低于 `.node-version` 基线（24.22.1；26.x 需 ≥ 26.12.1），`make check` 与
真实 Host 门禁在本地不执行；完整门禁在 GitHub Actions 上跑：

| 门禁 | 环境 | 结果 |
| --- | --- | --- |
| `public-gate`（`make check` 全量套件） | ubuntu-24.04 / Node 24.22.1 / Playwright Chromium | **通过**：5431 项，5430 pass，0 fail，1 skipped |
| `patched-dsh-host` | 真实 DSH Host，`DSH_HOME` 指向 runner 临时目录 | **通过**：真实 Node 退出 + JSONL 重开 + 进程恢复，5 个场景全 PASS |
| `native-engine-integration` | ubuntu-24.04 | **通过** |
| `managed-mcp-business-identity` | 真实 DSH Host + 隔离 `DSH_HOME` + 本地 MCP loopback | **通过**：业务字段、关联 ID、Header 与 MCP 凭证均断言 |

`patched-dsh-host` 继续验证 Host 归属、审批与进程恢复；`managed-mcp-business-identity` 专门断言
「`RunAgent` 一轮经真实 DSH Host 进程到达 MCP Server 并观察到业务身份」。

## 回归

```sh
node --test tests/mcp-invocation-identity.test.mjs
node --test tests/native-mcp-dispatch-authority.test.mjs tests/local-resource-adapters.test.mjs
node --test tests/managed-runtime-approval.test.mjs
AGENTKIT_DSH_INSTALLATION=/path/to/pinned/built-dsh \
  node scripts/verify-managed-mcp-identity.mjs --report .artifacts/managed-mcp-identity.json
```
