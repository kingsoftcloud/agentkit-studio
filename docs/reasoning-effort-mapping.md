# 跨厂商模型思考深度（reasoning effort）映射

> 分支：`feat/reasoning-effort-mapping-20261109`，基线 `upstream/main` @ `f74562bd`。
> 范围：`src/model-reasoning.mjs`（能力表单一数据源）、模型设置页的「思考等级」呈现、
> 模型代理与本地运行时对 `400 reasoning_effort` 的一次性兜底。
> 不改 Host RPC、不改 profile 存储形状（仍是 `reasoningEfforts: true` + `defaultReasoningEffort`）、
> 不改版本号。

## 1. 问题

重做前的实现把所有提供商都映射成同一张表：

```
low → low, high → high, max → max
```

但 OpenAI 的合法枚举是 `minimal/low/medium/high`，`max` 不是合法值；一旦网关严格校验就会
直接 400。Codex 侧虽然已经有 `max → high` 的降级，但只覆盖 Codex 自己的
`model_reasoning_effort`，OpenAI 兼容网关仍会收到 `max`。同时 Studio 没有 `medium` 档，
也无法区分「这个提供商能不能收 `max`」。

## 2. 能力表（单一数据源）

`src/model-reasoning.mjs` 导出 `REASONING_PROFILES`：

| provider | levels（选择器） | wire（发送值） | default |
| --- | --- | --- | --- |
| `ksyun`（金山云） | `low/high/max` | `low→low, high→high, max→max` | `high` |
| `deepseek` | `low/high/max` | 同名 | `high` |
| `openai` | `low/medium/high` | 同名 | `medium` |
| `codex` | `low/high/max` | `low→low, high→high, max→high` | `high` |
| 未知 provider | `low/high` | 同名 | `high` |

未知 provider（`custom`、`openai-compatible`、空值等）落到 `REASONING_FALLBACK_PROFILE`：
只发 `low/high` 两个同名值，不发送 `max`，避免上游拒绝非法枚举。

`codex` 行的 `wire` 额外保留 `medium → medium`（`levels` 不暴露 `medium`），用于
OpenAI 档位经由 Codex App Server 执行时仍能翻译；选择器顺序仍由 `levels` 决定。
`studioReasoning` 的 `true` 标记严格按 `levels` 产出 map，显式对象覆盖则按
`low/medium/high/max` 的规范顺序过滤后原样生效。

## 3. 对外契约

`studioReasoning(profile)` 的返回形状保持不变：

```js
{ efforts: { low: 'low', high: 'high', max: 'max' }, defaultEffort: 'high' }
```

`efforts` + `defaultEffort` 仍是 `src/client/dsh/model-bridge.mjs`、
`src/portable-model-bridge.mjs`、`src/model-service.mjs`、
`src/providers/codex-configured-models.mjs` 消费的唯一形状；portable import 与 DSH
路由声明不需要跟着改。

兼容性导出 `STUDIO_REASONING_WIRE`、`STUDIO_CODEX_REASONING_WIRE`、
`STUDIO_REASONING_DEFAULT` 仍指向能力表中的对应行，供既有 importer 使用。

## 4. 模型设置页

- 「思考等级」回到「③ 模型」分区（与模型名称同一行两列）。下拉只列出该提供商
  `levels` 中的档位。
- 每个选项直接显示实际发送值，例如 `最高 → high`；控件下方再写一行
  `实际发送 reasoning_effort=…`，Codex 的降级不再需要用户猜测。
- 切换提供商时，如果当前档位不在新提供商的 `levels` 里（例如 `max` → OpenAI），
  自动落到新提供商的 `default`（OpenAI 为 `medium`），并在页脚给一条非阻塞
  `role=status` 提示；不把它当成错误、不阻止保存。
- 默认值保持「不启用」。只有用户明确选择档位时才写入
  `reasoningEfforts: true` + `defaultReasoningEffort`；不支持 `reasoning_effort`
  的模型因此不会被写入任何档位。
- 读取配置时 `src/global-config.mjs` 用能力表校验 `defaultReasoningEffort`：
  OpenAI 的 `medium` 不会再被旧的三档白名单改写成 `high`。

## 5. 400 兜底

模型代理（`src/model-proxy-handler.mjs`，Native Harness 的正式路径）与本地运行时
（`src/local-runtime.mjs`）在以下条件同时成立时重试一次：

1. 上游返回 `400`；
2. 错误文本包含 `reasoning_effort` / `reasoning.effort`；
3. 请求里确实带了不同的值，且该 provider 的最高合法值与当前值不同。

重试把 Chat Completions 的 `reasoning_effort` 或 Responses 的 `reasoning.effort`
改成该 provider 的最高合法值（未知 provider 为 `high`），并记录一条可观测日志：

```
[agentkit-studio] reasoning_effort fallback: {"provider":"openai","model":"gpt-5","from":"max","to":"high","status":400}
```

日志只含 provider、model、前后两个 wire 值和状态码，不含 API Key 或请求体。
若当前值已经是最高合法值，或错误与该参数无关，则只请求一次并照常失败。

## 6. 用户可见变化

| 提供商 | 变化 |
| --- | --- |
| 金山云 / DeepSeek | 档位不变（低/高/最高），默认仍为「高」，发送值不变 |
| OpenAI | **隐藏「最高 → max」**，新增「中 → medium」，默认改为「中」 |
| Codex | 档位仍是低/高/最高，但「最高」明确显示为 **→ high** |
| 自定义/未知提供商 | **只剩「低 → low」「高 → high」**（隐藏「最高」）；默认「高」 |
| 不支持 reasoning 的模型 | 默认「不启用」，profile 里不写任何档位 |
| 旧配置中的非法档位 | 读取时按提供商默认档归一（例如 OpenAI 的 `max` → `medium`） |

## 7. 测试

- `tests/model-reasoning.test.mjs`：能力表逐行断言、OpenAI 不发 `max`、Codex
  `max→high`、未知 provider 兜底、显式 `reasoningEfforts` 覆盖、输出形状契约、
  400 识别与 body 改写、client/portable bridge 声明。
- `tests/model-settings-discovery.test.mjs`：下拉只出现该提供商档位、显示实际发送值、
  切换提供商回落到默认并提示、不启用时不写入 profile。
- `tests/global-config.test.mjs`：OpenAI `medium` 与未知 provider 的 `max` 归一。
- `tests/codex-model-proxy.test.mjs` / `tests/local-runtime-stream.test.mjs`：
  400 兜底只重试一次、无更低合法值时不重试、日志不含 key。
