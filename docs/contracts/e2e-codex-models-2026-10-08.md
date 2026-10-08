# Codex configured models and Chat proxy acceptance — 2026-10-08

Scope: pinned Codex CLI 0.159.2, DSH 0.2.0-rc.2, local Studio Host.
This report does not certify every gateway model, plugin or cloud deployment.

## Implementation and regression evidence

The original failure was Studio rejecting every provider outside its Codex group,
before starting the CLI. The routing regression first reproduced that rejection,
then verified the selected provider/model reaches the actual Codex runtime.
Profiles now explicitly select native Responses or a local Chat Completions proxy.
Credentials are isolated to the exact selected provider and child process.

Coverage includes provider route collisions, disabled profiles, native account
catalog failure, profile protocol persistence, namespaced/custom/search tool
round trips, fragmented SSE arguments, incomplete upstream streams, cancellation,
loopback authentication, credential redaction and native-provider isolation.
A 429 becomes an actionable model-rate-limit error without switching models.
`make release-check` passed all 384 tests, package integrity (223 files) and
`git diff --check` for this phase.

## Real CLI and gateway evidence

`node scripts/verify-codex-configured-model.mjs --execute --model MODEL --api API`
uses a temporary Codex home with no OpenAI login or personal plugins. An ordinary
card question must produce a system-only marker and a randomly generated value
returned by an actually executed dynamic tool. No assistant identity is placed
in the user question.

| Protocol | Model | Result |
| --- | --- | --- |
| Responses | deepseek-v4.1-flash | Passed: system marker, live tool result, incremental text and reasoning |
| Responses | glm-5.3-flash | Passed: system marker, live tool result, incremental text and reasoning |
| Chat Completions proxy | deepseek-v4.1-flash | Passed: 1 tool call, 23 text deltas, 4.7 seconds; no reasoning returned in this small probe |
| Chat Completions proxy | glm-5.3-flash | Passed: 1 tool call, 9 text deltas, 69 reasoning deltas, 4.8 seconds |

A separate temporary workspace probe with GLM and the Chat proxy created a file
through Codex and verified its random contents on disk. Real Metaso search and
reader calls also passed through the proxy (4 calls, 160 text deltas, 15.8 seconds).
These are real model/tool requests, not synthetic model responses.

## Native browser evidence

- A Codex test Agent bound to a configured gateway model opened a workspace-free
  native DSH conversation. Asking only for a two-day trip with a budget returned
  the system-only marker and the requested budget. The model stayed selected.
- The existing resource-bearing Codex Agent was retained without editing its
  system prompt or bindings (1 MCP and 3 Skills). In a separate Web instance,
  selecting GLM-5.3-Flash completed the search request in 38 seconds via the Chat
  proxy, produced two source links and exposed expandable tool and reasoning
  records. The model picker still displayed GLM-5.3-Flash after completion.
- That run included successful bound Metaso search and native Codex connector
  calls; one MCP read failed and the Agent recovered using another available
  reader. A completed answer is not a claim that every tool call succeeded.
- DeepSeek with the full personal plugin/tool set hit a confirmed upstream
  `TPM Ratelimit`, not a protocol failure: requests contained 353 tools and about
  559–590k characters. GLM completed with the same enabled tools. The proxy does
  not remove enabled plugins or bypass the provider's quota to make a test pass.

Local screenshots are retained under ignored `.artifacts/`:
`e2e-codex-kspmas-blind-20261008.png` and
`e2e-codex-chat-proxy-glm-20261008.png`.

## Additional failure found by the full check

Evaluation polling sometimes read an in-place JSON overwrite and returned null.
A concurrent-reader regression reproduced 10 missing reads; atomic publication
made the same test pass. The reader no longer sees a partially published update.

## Remaining boundaries

- Native OpenAI hosted search/image services cannot be synthesized by a Chat
  protocol proxy. Hosted search is disabled only for the Chat path; bound MCP
  search and Codex client tools remain available.
- Upstream models must support the required tool contract. Reasoning is shown
  only when the provider returns it.
- Existing personal plugins increase context and may require separate OAuth.
  Full Codex plugin parity, durable native Codex thread resume and every model
  are not certified by these tests.
- macOS distribution signing/notarization and preproduction deployment remain
  separate gates. The local unsigned ARM DMG is not a signed release.

## 请求开销与观测补全

仅输入“你好”的真实 CLI 探测仍携带 347 个工具：请求约 534k 字符，
其中工具定义约 480k；模型上报输入 133047 tokens。新会话没有 Studio
Agent 绑定，说明个人 Codex 插件的全量工具装载本身已带来主要开销。
原有资源 Agent 的原生页面再次发送“你好”，请求 559849 字符、353 个工具，
工具定义 482572 字符，系统提示词 73801 字符，对话 3238 字符；实际用量
140219 tokens，原生会话及观测页均已显示。以上是不同请求，不能混为同一个样本。

修复前 App Server 的 `thread/tokenUsage/updated` 被桥接层忽略；修复后先将
累计值转换为增量供 Trace 归集，再按 DSH 的累计、缓存分桶约定投影原生用量，
避免重复计数。Chat 代理额外记录每次出站请求的数字统计。请求大小不是 Token
估算；没有上报用量的历史记录继续保留为空，不反填或伪造数字。

三项新增回归先失败再通过（累计用量、失败前 Trace 保留、脱敏请求统计）。
补全后的 `make release-check` 通过 387 项测试和包完整性检查。
浏览器截图：`.artifacts/e2e-codex-request-metrics-20261008.png`。

只开启 Codex 工具搜索开关未降低当前自定义模型的工具数。工具按需加载及
Agent 插件范围隔离尚未完成，不把用量可见性修复当作上下文体积已优化。
