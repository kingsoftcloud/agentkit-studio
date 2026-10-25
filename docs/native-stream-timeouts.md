# Native 流式等待与 thinking 显示

参考为 `ksadk-python` / `355059d78e47ed764bbdb3606304cdf34e9838a3`：
`harness/native/effect_control.py` 的 `idle/v1`、正式 Studio Native model port
及 `provider_thinking_display`。本页记录实际实现和定向证据。

## 执行行为

新 Host 准入的流式模型固定 `profile.streamTimeoutPolicy = idle/v1`。
HTTP 响应头等待仍受 request timeout 约束；收到 SSE 后，request timeout 约束
有效帧之间的空闲时间，核心的 effect timeout 也随有效模型活动续期。
整个 Run 的 wall budget 不续期，取消、已过期的 deadline 和关闭后的回调也不能
被后续帧恢复。非流式响应仍使用请求总时限。

适配器在验证有效模型帧后发出内部 `activity`。注释、空心跳和错误帧不能作为活动。
`activity` 只用于等待期限，不进入 Session、公有 stream、持久 display 前缀或
工具执行。压缩及 review 的模型调用同样可以续期，摘要输出不进入对话展示。

新 Run 的 `profile.providerThinkingDisplay` 默认 false。模型 profile 的参数
`provider_thinking_display: true` 显式开启显示；该字段不发送给模型服务。
OpenAI Chat、Responses 和 Anthropic 均将显示与私有协议回放分开：关显示仍保留
后续工具回合需要的原始推理/签名；开启显示也不要求开启回放。

`controllerReasoningPolicy = disclosed-delegate/v1` 只对实际披露 `delegate_task`
的 GLM 5.3、Z.AI/KSPMAS controller 请求提供 low 默认值。显式 effort 优先，
严格端点不套该默认。它也作为独立策略写入 Run。

这些策略及显示设置进入配置和兼容指纹。恢复旧 TS Run 时不新增缺失的策略；子任务
和视觉模型按各自绑定参数投影，不能携带父模型的显示或推理设置。

## 实际验证

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness-core/test/model-stream.test.mjs
node --test --test-name-pattern 'idle policy HTTP:|thinking display HTTP:|signed thinking captured' packages/agentkit-harness/test/native-model.test.mjs
node --test --test-name-pattern 'indexed reasoning summary does not require' packages/agentkit-harness/test/native-model-responses.test.mjs
node --test --test-name-pattern 'managed binding reuses real Studio assembly' tests/studio-native-harness.test.mjs
node --test --test-name-pattern 'idle policy: compaction' packages/agentkit-harness-core/test/context-planning.test.mjs
node --test --test-name-pattern 'oracle: delegate-' packages/agentkit-harness/test/native-provider-compat.test.mjs
```

- 编译通过；核心 stream 文件 12 项通过，包含过期、取消、晚到帧、总时间预算及
  旧模型总超时行为；新增压缩用途检查 1 项通过。
- 实际本地 HTTP 模型检查 9 项：长流由 14 个隐藏推理帧维持，持续约 0.9 秒，超过
  250ms request timeout 和 600ms effect timeout 后仍以一次模型调用完成。
  注释心跳不能续期。三协议的显示/回放独立，签名不进入显示事件。
- Responses 另有 1 项检查覆盖 6 组显式/旧默认和回放配置；Host 恢复 2 项通过。
- 参考 Python fixture 补了委派默认、显式优先和严格端点 3 组，定向对照通过；
  生成命令沿用[模型请求兼容](native-provider-compatibility.md)，固定 fixture 现有 18 组。

以上为本轮累计的 28 个独立测试项，未重新执行全仓、双 Node、安装或打包。
新增长流用例首轮遗漏非空配置指纹，压缩用例首轮的工具 timeout 超过所设 effect
timeout，均在产品调用前被既有验证拒绝。只修正这两个 fixture 输入并分别定向
重查通过；未改生产校验或放宽断言。初次日志及重查均保留在
`.artifacts/native-migration/model-runtime-*.log`，最终 Host 日志为 `model-runtime-host-final.log`。

剩余的高级 Anthropic block-binding / 中途 system 投影，以及其他产品/线上验收
仍见能力主表；本页不作为整个迁移完成的声明。
