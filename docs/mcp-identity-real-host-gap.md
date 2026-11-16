# 真实 DSH Host 下的 MCP 业务身份缺口

> 状态：**已复现，待修**。本文件记录 `scripts/verify-managed-mcp-identity.mjs` 在真实
> DSH Host 上的失败结论。

## 结论

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

托管 `RunAgent` 的 manifest 声明 `resources.mcp_servers` 时，走的是后者，所以**当前实际
部署路径不受益于本特性**。

## 修复方向（未实施）

有两个可选方案，需要先定架构：

1. **适配器兜底**：`callMcpTool` 在 `invocation` 缺省时回退到
   `currentBusinessInvocation()`，用业务上下文补出 `businessUserId` /
   `businessSessionId` / `businessInvocationId`。
   - 优点：改动小，一处覆盖所有调用方。
   - 代价：平台 `userId` / `sessionId` 在适配器里拿不到，需要一并设计来源；且
     `AsyncLocalStorage` 在这个调用点是否仍然有效需要再验证（本次观测到的是空上下文，
     说明要么调用方没传，要么 ALS 已跨出作用域——两者要先区分）。
2. **DSH core 透传**：让 DSH core 的 MCP 执行器把 `invocation` 传给适配器。
   - 优点：语义正确，适配器不猜。
   - 代价：要改 DSH patch 系列，跨仓库协调。

**建议先做 1 的可行性验证**：如果 ALS 在这个调用点确实为空，说明还有一层异步上下文丢失，
需要先把「谁在什么上下文里发出 MCP 请求」查清楚，再决定补哪里。

## 复现方式

```sh
# 1. 构建打过补丁的 DSH（约 5 分钟）
git clone --depth 1 --branch dsh-v0.2.2-rc.1 \
  https://github.com/deepseek-ai/deepseek-harness.git .ci-dsh
cd .ci-dsh
for f in ../patches/dsh-v0.2.2-rc.1/*.patch; do git apply --whitespace=nowarn "$f"; done
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:official
cd ..

# 2. 跑门禁
AGENTKIT_DSH_INSTALLATION="$PWD/.ci-dsh" node scripts/verify-managed-mcp-identity.mjs
```

期望（修好后）：`{"gate":"managed-mcp-business-identity","passed":true,...}`

当前实际：`{"failure":{"code":"MCP_IDENTITY_NOT_FORWARDED"},...}`

## 门禁价值

这条用例证明：**Native 集成层的通过不能替代真实 Host 验收**。它抓到了一个单元测试
结构性看不见的缺口——这正是 review 里「缺少真实 DSH Host 验证」的实质。
