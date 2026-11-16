# magpie 网关 `400 Invalid assistant message: content or tool_calls must be set` 排查

> **状态**：结论已用本地 magpie 网关真实探活验证；修复在 `src/model-reasoning.mjs` / `src/model-proxy-handler.mjs`。
> **分析基线**：`agentkit-studio @ 22fbd255`（2026-11-16，工作树含本次未提交修复）。
> **环境**：本地 magpie 网关（`127.0.0.1:3425`，DSH provider `magpie-responses`，`api: openai-responses`，模型 `imported/* · 星流`）。
> **证据等级**：`【实测】`= 对真实网关发出的请求得到的响应；`【代码】`= 可直接核对的源码事实；`【推断】`= 与代码/现象一致但缺运行时证据。

---

## 0. TL;DR

| 问题 | 结论 |
|---|---|
| 报错本身 | 网关（magpie → 星流 prefill）校验 Responses 请求里的 **assistant 轮次**：一个轮次必须带「非 null 文本的 assistant 消息」或「工具调用」，否则 400 `Invalid assistant message: content or tool_calls must be set`。【实测】 |
| 上报的分诊 | **不成立**：不是「上下文压缩把 tool_calls 裁掉」。DSH 压缩是整节点替换并强制工具/结果配对，派生历史还会丢弃无内容的 assistant 事件（`surface.js:87-99`、`dsh-messages.mjs:54`）。【代码】 |
| 「重试往往能过」 | **不成立**：400 在 native port 里是 `provider_terminal_error`，零重试（`model-port.mjs:256-272` → `machine.mjs:511`）；`#150` 的「去掉 `content: null` 再重试」重试体同样被拒，是**无效修复**。【代码+实测】 |
| 真实触发 | 历史里出现**只有 `reasoning` 项、没有文本也没有工具调用的轮次**（模型上一轮只产出思考、或该轮文本为空），Codex/DSH 把这条 reasoning 重放出来。【实测】 |
| 为什么只有 magpie 复现 | 直连星流不校验轮次形状；magpie 转发到星流 prefill 时做严格校验。【实测】 |
| 修复 | 代理在网关拒绝后重试一次：**丢弃「无载体轮次」里的 reasoning 项**（有文本/工具调用的轮次原样保留），并顺手丢弃既无文本也无工具调用的空 assistant 消息。实测 L1–L8 全部 200。【实测】 |
| 附带 | 历史里「只有工具回执、没有对应调用」时网关回另一条 400（`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）；代理现在按 `call_id` 顺序配对，发送前丢弃孤立回执。实测 L9 → 200。【实测】 |

---

## 1. 网关的真实校验规则（实测）

对 `POST /v1/responses` 逐条构造 `input` 得到（同一 `input` 在 `/v1/chat/completions` 上不报错）：

| input | 结果 |
|---|---|
| `[user, assistant(content: [])]` | 200 |
| `[user, assistant(content: '')]` | 200 |
| `[user, assistant(content: []), tool_calls: []]` | 200 |
| `[user, assistant(content: null)]` | **400** assistant-message |
| `[user, assistant(content 缺失)]` | **400** assistant-message |
| `[user, reasoning]`（content 为 `null`/缺失/`[]`/带文本，或位于 user 消息之前） | **400** assistant-message |
| `[user, reasoning, function_call, function_call_output]` | 200 |
| `[user, assistant(null), function_call, output]` | 200 |
| `[user, reasoning, assistant('pong')]` | 200 |
| `[user, function_call, function_call_output]`（无 reasoning） | 200 |
| 孤立 `function_call_output`（无对应 call） | **400**（另一条 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`） |

规则一句话：**轮次 = 一段 reasoning 项 + assistant 消息项，遇到 user/system 消息、tool 回执或输入结尾即结束；轮次合法当且仅当它带非 null 文本的 assistant 消息，或带 `function_call`。**

---

## 2. 生产链路

```
Codex App Server / DSH 原生历史
        │  Responses input[]（含重放 reasoning 项）
        ▼
src/model-proxy-handler.mjs           ← 本次修复点
        │  nativeResponses ? 原样转发 : responsesToChat 转 Chat Completions
        ▼
magpie 网关 127.0.0.1:3425/v1  →  星流 prefill 校验
```

- **原生 Responses 路由**：`body === input`，只改 `model`（`model-proxy-handler.mjs:57,74`），不做任何轮次校验。【代码】
- **转换路由**：`inputToMessages` 会把 `content: []` 归一化成 `''` 并原样保留空轮次（`model-proxy.mjs:30-49,81-86`）。【代码】
- **本地 gatewayHistory 路径**：`dsh-messages.mjs:54` 已经丢弃空壳，所以只有代理两条路由会漏。【代码】

`#150` 加的 `isReasoningReplayRejection` 匹配器能命中这条 400，但 `normalizeReasoningContent` 只处理 `type:'reasoning'` 且 `content === null` 的项，重试体仍是被拒形状（实测重试体与「无兜底时被拒的 body」逐字节相同）。【代码+实测】

---

## 3. 修复

`src/model-reasoning.mjs`

- 新增 `dropCarrierlessReasoningTurns(body)`：按上面的轮次定义扫描 `input[]`，轮次若既无文本 assistant 消息也无工具调用，则丢弃该轮次的 reasoning 项；有载体的轮次保持原样（推理连续性不变）。
- 新增 `normalizeEmptyAssistantTurns(body)`：先丢弃既无文本也无工具调用的空 assistant 消息（`null`/缺失/`[]`/`''` 四种形状），两种线都处理。

`src/model-proxy-handler.mjs`

- 请求发出前先做 `normalizeEmptyAssistantTurns`（这类轮次没有任何信息量）。
- 400 且命中 assistant-message 规则时，`normalizeReasoningContent(body) + dropCarrierlessReasoningTurns(body) > 0` 才重试一次——仍然只在网关真的拒绝后修复，不改变宽容网关的行为。

### 验证

| 用例 | 修复前 | 修复后 |
|---|---|---|
| L1–L5 空 assistant 消息（`null`/缺失/`[]`/`''`/`[]+tool_calls:[]`） | 1 次尝试，400 | 1 次，200（发送前丢弃） |
| L6 尾部 reasoning `content: null` | 2 次，两次都 400 | 2 次，第二次 200 |
| L7 尾部 reasoning `content` 缺失 | 1 次，400（兜底不触发） | 2 次，第二次 200 |
| L8 工具轮次（`content:null` + `function_call` + 输出） | 1 次，200 | 1 次，200（reasoning 原样保留） |
| L9 孤立 `function_call_output` | 400（另一条错误） | 1 次，200（回执在发送前被丢弃） |

复跑脚本：`.scratch/repro-empty-assistant/magpie-live.mjs`（需本地网关 + `~/.dsh/.env` 的 key，只读探活）。
单测：`node --test tests/codex-model-proxy.test.mjs tests/model-reasoning.test.mjs`（30 + 17 全绿）。

---

## 4. 未覆盖 / 后续

1. **原生 harness 直连路由**（profile `protocol: openai-responses` 时 Studio 代理不在链路上）不会产生 reasoning 项（`buildResponsesRequest` 根本不发 reasoning 项，assistant 消息的 `content` 永远是数组），因此本错误只可能来自 Codex 协议侧的历史重放；若日后 harness 也要重放 reasoning，需要同样按轮次清理。
2. `#150` 的兜底注释（"retry once with the field removed"）与实际网关语义不符，已在本次注释中更新；发布说明里也补了一条。
