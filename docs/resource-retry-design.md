# 资源绑定重试与 MCP 调用恢复（方案）

> 状态：**提案（未实现）**。本文定义目标语义和验收边界；实现完成并通过测试后，才可把它作为运行时契约。
>
> 审计基线：`10ce599a46d4614b12fc50bf3398214165394be2`。该 SHA 只固定 Studio 源码；安装的 Native Harness、MCP SDK 和桌面 Profile 仍需在验收记录中分别记录版本和 provenance。
>
> 相关文档：[资源降级](resource-degradation.md)、[托管资源绑定](managed-resource-bindings.md)、[架构](architecture.md)、[生命周期](refactor-lifecycle.md)。

## 1. 先固定当前事实

本方案把“连接恢复”和“业务效果重放”分开。当前代码并没有一套统一的 MCP supervisor，且不同 runtime 的模型循环也不同。

| 面 | 当前行为 | 本方案范围 |
| --- | --- | --- |
| 托管资源 RPC（Knowledge / Memory / Skill Space / `GetMCP`） | `managed-resource-client.mjs` 对所有 action 共用 3 次重试；当前也会重试 `CreateMemorySdk`，与 `managed-resource-identity.md` 的“写入不自动重试”相冲突 | P0 先修正写入策略；读/查询的重试单独保留 |
| 本地 MCP 建连、工具目录、`tools/call` | `local-resource-adapters.mjs` 无 single-flight、无统一 attempt 计数；传输异常会关闭当前缓存连接；工具结果 `isError` 与传输异常走不同路径 | P0/P1 实现连接状态和失败分类 |
| Native Harness | Native kernel 负责 Run、receipt 和 `uncertain`；MCP 工具定义当前固定为 `readOnly:false`、未知副作用 | 只把可证明未派发的错误转换为 `error(executed:false)`；未知效果继续对账 |
| DSH-native / Codex | 使用不同的模型/工具循环；不能直接套用 Native kernel 的 safe-read 或 recovery policy | 适配器错误契约可共用；模型循环和 UI 必须分别验收 |
| MCP 探测 | `listMcpTools` 建连失败直接失败，无工具调用重试 | 保持手动重新探测；不把探测结果当作工具调用成功证明 |

### 1.1 必须先解决的托管 Memory 写入矛盾

`src/managed-resource-client.mjs` 的 `call()` 对 `RetrieveKnowledge`、`QueryMemorySdk` 和 `CreateMemorySdk` 使用同一个重试循环；`bindMemoryWriter()` 还会把相同策略传给持久写入端口。普通 `writeMemory()` 没有稳定 request id，因此网络失败后重放可能重复提交。

落地前必须二选一：

1. 将 `CreateMemorySdk` 从自动重试集合中排除，并保留现有“写入不自动重试”文档；或
2. 先让服务端提供可验证的幂等写入契约，再把同一个外部幂等键用于重试，并同步更新文档。

本方案默认选择第 1 项。默认 3 次托管资源读请求实际只使用两段间隔：`200ms`、`600ms`；`1500ms` 只在调用者把 `maxAttempts` 提高到至少 4 时才有意义。

## 2. 目标与非目标

### 目标

- 瞬态的**建连或准入失败**不再要求用户手动重新发送整条消息。
- 未能证明请求已经进入 `tools/call` 的错误可以在同一逻辑调用中恢复。
- 已进入外部工具、但结果未知的调用继续保持 `uncertain`，不能盲目重放。
- 失败详情和 `studio/resource-check` 能记录 `phase`、`attempts`、`retryClass`、`sessionState` 和安全的 request identity。
- Native Harness、DSH-native、Codex 的边界分别验收，不把一个 runtime 的状态机推断成另一个 runtime 的行为。

### 非目标

- 不对所有 MCP `tools/call` 做无差别自动重试。
- 不因为 MCP `annotations.readOnlyHint` 就授予 safe replay；这是远端提示，不是 Host 授权事实。
- 不复用 Native 的原始 `callId` 作为用户手动重试的操作身份。
- 不把 DSH 上游或桌面 `app.asar` 内部实现当作本仓库的未锁定依赖。
- 不改变模型请求自身的 provider retry policy。

## 3. 失败分类契约

分类必须按**请求阶段和 Host 观测到的 dispatch state** 判断，不能只看错误字符串。

| `retryClass` | 适用阶段 | Host 能证明的事实 | 默认动作 |
| --- | --- | --- | --- |
| `pre_dispatch` | connect / credential / local validation | `tools/call` 请求尚未开始发送 | 可有界恢复建连；不重放业务效果 |
| `session_expired` | 已有 session 的 HTTP 404/400 | 只能证明 session 不可用，不能自动证明工具未执行 | 关闭并删除缓存，返回 typed error；默认不立即重放 |
| `rate_limited` | connect/list 或明确拒绝的请求 | 服务端返回拒绝；是否进入工具执行取决于 phase | connect/list 可按 `Retry-After` 重试；`tools/call` 默认不重放 |
| `connect_rejected` | `initialize` | 初始化请求没有业务工具副作用 | 可有界重试；端点不存在、鉴权和 TLS 错误终态化 |
| `transport_ambiguous` | `tools/call` 已开始后，断连、超时、5xx、SSE 中断 | 可能已执行，也可能未执行 | 保持 `uncertain`；除非有 Host 冻结的 safe-read + 服务端幂等契约 |
| `tool_error` | `result.isError === true` 或明确 JSON-RPC 工具错误 | 工具返回了明确失败结果 | 不自动重放，交由模型/用户处理 |
| `output_invalid` | 结果 schema 或投影校验失败 | 工具已经返回结果，不能证明无副作用 | 不自动重放 |
| `cancelled` | 调用者或 Host scope 取消 | 调用是否停止由远端协作确认 | 不重试；保留取消语义 |

### 3.1 session 过期不等于安全重放

带 `mcp-session-id` 的 404 能帮助区分“端点不存在”和“当前 session 不存在”，但它本身不是效果收据。除非服务端明确承诺“未知 session 的 `tools/call` 在执行前拒绝”，并且该承诺进入冻结的资源契约，否则本地只做：

1. 关闭当前 client；
2. 从缓存删除；
3. 返回 `MCP_SESSION_EXPIRED`、`sessionState:'expired'`、`executed:'unknown'`；
4. 由下一次新的逻辑调用建立新 session。

若未来增加服务端幂等能力，自动重放必须使用独立的外部 idempotency key，并限制为一次；这不改变 Native 原始 `callId`。

### 3.2 Native 状态转换

只有适配器明确返回 `details.dispatchState:'not_started'` 时，Native 才能把失败转换为：

```js
{ status: 'error', content: { code, executed: false } }
```

`Not connected`、`ECONNRESET`、请求超时和 session 过期在没有传输层证据时都不能自动填 `executed:false`。这类情况继续走 `uncertain` / reconciliation。

## 4. 连接生命周期设计

### 4.1 single-flight 与 generation

`mcpClients` 为每个 `cacheKey` 保存 `{ generation, promise, entry }`：

- 同一个 fingerprint 的并发调用共享一次 `initialize`；
- 旧连接收尾时必须检查 generation，不能关闭后来接管缓存的新连接；
- 凭证或 endpoint fingerprint 变化时，旧连接先进入 retiring，再建立新 generation；
- map 中的 rejected promise 必须清理，不能让失败 promise 永久占位。

连接建立使用独立的 owner `AbortController`。每个调用者只取消自己的等待；不能用 `AbortSignal.any([...callers])` 合并所有调用者，否则一个调用取消会中断其他等待者。调用者取消后，新调用可以继续等待同一个连接或建立新的 generation，具体由 owner 状态决定。

### 4.2 超时使用一个绝对 deadline

连接和工具调用都从同一个逻辑 deadline 计算剩余时间：

```text
deadline = min(parent deadline, configured total budget)
connectTimeout = min(connect limit, deadline - now)
callTimeout = min(call limit, deadline - now)
```

不能同时宣称“总预算 ≤30s”和“单次工具 timeout 55s”。测试必须验证连接、调用、退避都不会越过 parent/Host 的总预算。

### 4.3 适配器内部重试的边界

适配器内部可以重建连接，但“重建连接”不等于“重放 `tools/call`”。每次业务调用应保存：

```text
phase: connect | list | call
dispatchState: not_started | sent | unknown
attempts: number
retryClass: string
sessionState: none | active | expired
```

`dispatchState` 只有在 Host 拥有明确 transport hook 或 SDK 证明时才能从 `not_started` 推进到 `sent`；不能在进入适配器函数时提前标记为已派发。

## 5. 观测契约

### 5.1 `LocalResourceError.details`

新增字段只能增加，不改变现有 `code`/`message` 语义：

```text
{ resourceId, name, phase, dispatchState, attempts, retryClass,
  status, causeCode, sessionState, elapsedMs, aborted, willRetry }
```

`requestId` 只有在外部服务提供了安全、非凭证的 request identity 时才记录；Native `callId`、内部 scope 和用户凭证不直接写入公开错误文案。

### 5.2 资源检查事件

当前 `checkedResource()` 在 catch 分支只写 `status/code`，所以仅修改 `sanitizeResourceCheck` 白名单不能恢复 `attempts`。实现必须同时完成：

1. `checkedResource()` 从 `error.attempts` 或 `error.details.attempts` 提取安全整数；
2. `sanitizeResourceCheck()` 增加 `attempts`、`retryClass`、`phase` 等白名单字段；
3. 为 MCP 工具增加明确的 `kind:'mcp-tool'`、`action:'call'`（或独立 `mcp-call` 事件），并更新所有投影/校验；
4. 资源检查、trace 和错误详情使用同一字段名，避免只在 console 中记录。

## 6. 手动重试与幂等身份

用户点击“重试该调用”时：

- 创建新的 Native `operationKey` 和 `callId`；
- 保存 `retryOf` 指向原调用；
- 保留原调用的结果状态和 `uncertain` 事实；
- 只有 `error(executed:false)` 或 Host 冻结的 safe-read 能力才显示重试动作；
- `uncertain` 只显示“核对结果/重新探测”，不能直接重复可能产生副作用的调用。

如果外部 MCP 服务支持幂等键，可以在 `params._meta` 中携带独立的 opaque idempotency key。该键是否生效必须由服务端契约和测试证明，不能因为字段进入请求就假定去重成功。

## 7. Runtime 边界

第一阶段先实现共享适配器的连接状态、错误详情和事件契约；然后分别验收：

| runtime | 必须验证 |
| --- | --- |
| Native Harness | `error(executed:false)`、`uncertain`、receipt 和 Run 终态一致 |
| DSH-native | 动态 MCP 工具名称、DSH 工具卡和模型继续执行行为 |
| Codex | dynamic tool handler 的错误投影、Codex tool event 和手动重试身份 |
| 托管资源 RPC | Memory 写入不自动重试；读请求的 attempts/分类保持独立 |

不能用 `src/client/dsh/native-tool-view.mjs` 的固定工具名映射证明动态 MCP 工具的 live UI 行为；必须补真实 Session/renderer 或等价的组件测试。

## 8. 实施顺序

### P0：先修正确性和安全边界

1. 为 `CreateMemorySdk` 增加“写入不自动重试”的回归测试；明确 managed client 的 action policy。
2. 为 MCP adapter 增加 single-flight、generation、独立连接 owner 和缓存清理。
3. 引入 `phase/dispatchState/retryClass`，只对 `not_started` 赋 `executed:false`。
4. 对 session 404 做关闭、缓存删除和 typed error；默认不自动重放 `tools/call`。
5. 用绝对 deadline 接入 connect/call timeout，并覆盖 response body 中途断开。
6. 完成 `studio/resource-check` 的 MCP 事件和 attempts 传播。

### P1：受控的可选恢复

1. 只对 connect/list 和明确未派发的请求做有界退避；工具调用默认不重放。
2. 若引入 safe-read，必须使用 Host 冻结、可审计的 capability，而不是直接信任 `readOnlyHint`。
3. 若引入服务端幂等键，增加“服务端去重”的 loopback/HTTP 测试；单纯断言 `_meta` 存在不算通过。

### P2：产品面

1. UI 为新的 retry operation 提供重试动作；`uncertain` 只提供核对路径。
2. 补资源重试矩阵、降级后台重探测和文档索引。
3. runtime-specific E2E 通过后，再评估是否需要更完整的 supervisor 能力（listChanged、close barrier 等）。

## 9. 测试计划

已有证据：

- `.scratch/retry-audit/repro-mcp-retry.mjs`：并发首调会产生两次 initialize；session 404 会被误诊为 `MCP_ENDPOINT_NOT_FOUND`。
- `tests/native-dsh-tools.test.mjs`：已知 MCP 工具错误与传输失败分别得到 `error` 和 `uncertain`。
- `tests/local-resource-adapters.test.mjs`：协议工具错误、凭证轮换、authority guard 已有覆盖。
- `tests/managed-resource-retry.test.mjs`：托管资源读重试和取消已有覆盖。

新增回归至少包括：

1. `CreateMemorySdk` 的 503、网络失败和 response body reset 都只发送一次；
2. response body 中途断开和 timeout 的分类/attempts；
3. 同 cacheKey 并发调用只 initialize 一次；单个调用取消不会取消其他等待者；
4. session 404 关闭缓存并返回 `MCP_SESSION_EXPIRED`，不自动重放业务调用；
5. 真正 `pre_dispatch` 的失败返回 `executed:false`；`transport_ambiguous` 保持 `uncertain`；
6. cancel、authority stale、credential rotation 不产生额外 `tools/call`；
7. `checkedResource()` 将 top-level/nested attempts 投影到 `studio/resource-check`；
8. 手动重试使用新的 `operationKey/callId`，并保留 `retryOf`；
9. 各 runtime 的 live tool card、Codex tool event 和 Native receipt 分别验证。

建议命令：

```sh
node .scratch/retry-audit/repro-mcp-retry.mjs
node --test tests/local-resource-adapters.test.mjs tests/managed-resource-retry.test.mjs \
  tests/native-dsh-tools.test.mjs tests/mcp-transports.test.mjs tests/mcp-cancellation.test.mjs
pnpm test
```

## 10. 验收与回滚

验收必须同时满足：

- 未派发失败可恢复，但未知效果不自动重放；
- Memory 写入没有隐式重试；
- 并发建连只产生一次 initialize；
- session 过期能清理缓存并给出可操作的 typed error；
- `attempts/retryClass/phase/dispatchState` 在错误详情和资源事件中一致；
- Native、DSH-native、Codex 各自的 E2E 通过。

`AGENTKIT_MCP_RETRY=off` 只关闭未来增加的可选自动重试；single-flight、缓存清理、session 失效标记和观测仍保留。任何配置开关都只从 Host 环境读取，并在文档中说明上限和默认值。

## 11. 证据与复现

- 审计报告：`.scratch/retry-audit/mcp-path.md`、`.scratch/retry-audit/binding-inventory.md`、`.scratch/retry-audit/contracts-observability.md`。
- 复现脚本：`.scratch/retry-audit/repro-mcp-retry.mjs`。
- 相关历史：`48a75056`（托管资源重试和后台重探测）、`8a30b42d`（资源降级和严格模式）、`2c3b573b`（Native guarded retry）。
