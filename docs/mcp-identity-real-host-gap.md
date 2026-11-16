# 真实 DSH Host 下的 MCP 业务身份缺口

> 状态：**已修复并接入 CI**。`scripts/verify-managed-mcp-identity.mjs` 通过真实 DSH Host 门禁。
> 本文件保留修复前失败时的证据与根因，供回归参考。

## 结论

以下失败现象均为修复前的现场；修复后的真实 Host 结果见「修复」与「门禁」章节。

在**真实 DSH Host 进程**（`@deepseek-ai/dsh` 0.2.2-rc.1 + 本仓库 patch 系列）里跑一轮
`RunAgent`，MCP Server 确实收到了 `tools/call`，但：

```
params = { name: "save_crm", arguments: { note: "business" } }
headers = { authorization: "Bearer <mcp-credential>", ... }
```

**没有 `_meta['io.agentkit.studio/invocation']`，也没有任何 `x-agentkit-*` 请求头。**

也就是说：Native 集成层（`NativeKernel` + 生产 MCP 适配器）验证通过的身份透传，
在真实 Host 里**没有发生**。

## 为什么单元测试没发现

`tests/native-mcp-dispatch-authority.test.mjs` 直接调用
`resourceAdapter.callMcpTool(binding, name, args, { invocation })`，把 `invocation`
显式传了进去。

真实 Host 里 MCP 工具由 **DSH core 的 MCP 执行器**调用，它调用
`resourceAdapter.callMcpTool(...)` 时**不带 `invocation`**。适配器于是：

```js
const identity = invocationIdentity ? normalizeMcpInvocationIdentity(invocation) : null;
// invocation === undefined → identity === null → 不加 _meta、不加头
```

诊断证据（临时插桩，已还原）：

```
mcpFetch 调用: 5
DEBUG-MCPFETCH] http://127.0.0.1:62476/mcp null    ← invocationScope.current() 为 null
```

## 影响面

| 路径 | 业务身份是否透传 |
| --- | --- |
| 我们的 `native-dsh-tools` MCP 分支（`executor: 'mcp'` 工具合约） | ✅ 透传 |
| **DSH core 直接执行 `resources.mcp_servers` 绑定** | ❌ **不透传** |

托管 `RunAgent` 的 manifest 声明 `resources.mcp_servers` 时，走的是后者，所以**修复前的
部署路径不受益于本特性**。

## 根因（已确认）

MCP 工具由 **DSH core 的 ToolExecutionPipeline** 派发，链路是：

```
DSH core ToolExecutionPipeline
  → src/providers/dsh-runtime-plugin.mjs    execute(args, exec)
  → src/host/runtime-bridge.mjs             executeResourceTool
  → src/host/services/resource-tools.mjs    createBoundResourceToolExecutor
  → src/local-resource-adapters.mjs         callMcpTool(..., { invocation })
```

`dsh-runtime-plugin.mjs` 调 `executeDshResourceTool` 时**没有传 `invocation`**，
适配器于是拿到 `undefined`，`normalizeMcpInvocationIdentity(undefined)` 返回 `null`，
身份通道被静默跳过。

同时确认：这个插件执行在 **engine 进程**里，`RunAgent` 那轮的 `AsyncLocalStorage`
已经不在了（`exec` 里只有 `token / callId / rootCallId / name / signal / agent /
toolSet / deferContext / concludeTurn / arguments`，没有 `scope`）。

## 修复

1. `business-invocation-context.mjs` 增加**按原生 Session 绑定的身份注册表**：
   `bindBusinessInvocation(sessionId, context)` / `businessInvocationFor(sessionId)`。
   一个 Session 同时只允许一个活跃 Run，所以 Session id 是无歧义的键。
2. `build-runtime-http.mjs` 在 RunAgent 执行期间注册，执行结束后释放。
3. `dsh-runtime-plugin.mjs` 在派发 MCP 工具时用 `businessInvocationFor(exec.agent.session.id)`
   取回身份，交给 `nativeMcpInvocation({ ..., business })` 组装。
4. `normalizeMcpInvocationIdentity` 的**平台 `userId` 改为可选**：engine 进程内没有平台
   主体时，仍然转发 `source` + `sessionId` + 业务字段，而不是把整个通道丢掉。

修复后的实际线上内容：

```json
{
  "v": 1, "source": "run-agent",
  "sessionId": "runtime-e1b9446e…", "nativeSessionId": "runtime-e1b9446e…",
  "businessUserId": "customer@example.com",
  "businessSessionId": "order-session-42",
  "businessInvocationId": "request-1001",
  "invocationId": "request-1001"
}
```

`authorization` 保持 `Bearer <mcp-credential>` 未被覆盖。

## 复现方式

```sh
# 1. 构建打过补丁的 DSH（约 5 分钟）
git clone --depth 1 --branch dsh-v0.2.2-rc.1 \
  https://github.com/deepseek-ai/deepseek-harness.git .ci-dsh
git -C .ci-dsh checkout "$(node -p "require('./dsh-pin.json').commit")"
cd .ci-dsh
for f in ../patches/dsh-v0.2.2-rc.1/*.patch; do git apply --whitespace=nowarn "$f"; done
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:official
cd ..

# 2. 跑门禁
AGENTKIT_DSH_INSTALLATION="$PWD/.ci-dsh" node scripts/verify-managed-mcp-identity.mjs
```

期望（修好后）：`{"gate":"managed-mcp-business-identity","passed":true,...}`

修复前实际：`{"failure":{"code":"MCP_IDENTITY_NOT_FORWARDED"},...}`

## CI 接入

这条门禁已接进 GitHub Actions。为避免 Studio 包的 digest 遍历到 DSH 工作区，作业按以下顺序运行：

1. DSH 先检出到仓库内的 `.ci-dsh`，并校验 `dsh-pin.json` 的精确 commit。
2. 构建完成后把完整 DSH checkout 复制到 `$RUNNER_TEMP/ci-dsh`。
3. 删除仓库内的 `.ci-dsh`，再用 `$RUNNER_TEMP/ci-dsh` 启动真实 Host；Studio 依赖仍从当前 checkout 解析。

脚本也会拒绝未检出到仓库固定 commit 的 DSH，避免门禁误测其他 Host 版本。

## 门禁价值

这条用例证明：**Native 集成层的通过不能替代真实 Host 验收**。它先抓到了一个单元测试
结构性看不见的缺口，修复后又作为 CI 回归门禁持续验证真实部署路径。
