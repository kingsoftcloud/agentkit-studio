# Native 模型请求兼容

参考固定为 `ksadk-python` / `355059d78e47ed764bbdb3606304cdf34e9838a3`，
策略来自 `model_proxy/compat.py`、`transform.py` 和正式 Native OpenAI `_request`。

新 Run 的 `profile.providerCompatibilityPolicy` 使用 `provider-compat/v1`；
规则和模型绑定共同进入兼容指纹。恢复使用已保存策略，旧 Run 缺少该字段时不
启用新清洗。凭据刷新仍由 Host 负责，不进入配置或 fixture。

已迁移并接入实际请求构造：

- 按显式规则、端点和模型解析档位；严格端点清理 stream usage、thinking 和
  私有回放字段，未知端点保留 permissive 行为。
- GLM effort 值域、Qwen 上限、工具/预算触发的 thinking 关闭及显式开启优先；
  Claude disabled effort 值域、Kimi Code 限制与 required/named tool choice。
- KSPMAS 压缩专用 GLM 5.2 / DeepSeek effort 和 GLM 5.3 thinking 策略；核心
  显式发送 `purpose: compaction`，不用空工具或提示内容猜测用途。
- 最终提交保持原 schema 和 Host 验证，Kimi 改为 auto 不放松结果验收。
- 三种协议支持显式非流式、并行工具开关、temperature/top-p；Chat 支持输出 token
  字段选择。Host 从锁定模型参数投影设置，不把父模型参数强加给子任务或视觉模型。
- Studio 准入时拒绝模型不支持的显式 effort/thinking 设置；直接 wire 参数清洗
  与 Studio 配置准入分属不同层次。

## 定向证据

开发时执行一次参考 Python 纯策略，生成带参考提交、源文件 SHA256 的固定 JSON。
Node 测试和运行时不执行 Python。生成器只读参考仓库，不导入 Python Studio/SDK。

```sh
python3.12 scripts/generate-native-provider-compat-fixtures.py /path/to/ksadk-python
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness/test/native-provider-compat.test.mjs
node --test --test-name-pattern 'provider compatibility HTTP:' packages/agentkit-harness/test/native-model.test.mjs
node --test --test-name-pattern 'managed binding reuses real Studio assembly' tests/studio-native-harness.test.mjs
node --test --test-name-pattern 'Studio provider compatibility rejects unsupported' tests/studio-native-harness.test.mjs
node --test --test-name-pattern 'PreCompact binds actual admitted original source' packages/agentkit-harness-core/test/context-planning.test.mjs
```

编译通过；15 组 Python 对照及 2 项跨协议请求检查、4 项实际本地 HTTP、2 项原
配置恢复、1 项 HTTP 前拒绝及 1 项压缩用途检查通过，共 25 项。日志位于
`.artifacts/native-migration/provider-compat-*.log`。首次生成误用系统 Python 3.9，
类型注解不受支持，改用已有 Python 3.12 后成功；未安装依赖或修改参考代码。
本轮未重跑全仓、安装或打包。

## Anthropic 指令位置和签名回放

长流 `idle/v1`、独立 thinking 显示和 disclosed `delegate_task` controller 默认
effort 现已实现并接入冻结配置，具体行为和新增证据见[流式等待](native-stream-timeouts.md)。

Anthropic 新准入保存 `anthropic-wire/v1`。参考目录中的精确模型名
`claude-fable-5-1`、`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`
启用 mid-system 和 `drop_block`；未知别名、未来版本名保持旧投影，不靠前缀猜测。
这些策略和模型说明一起进入兼容摘要。恢复保留原 Run 的策略及字段缺省，不能
因为更新了宿主而给旧 Run 自动开启它们。

- 初始 system 保留在顶层；会话中途的系统指令保留原位置，且只能位于完整 user/
  工具结果之后、assistant 之前或输入末尾。未完成的工具批次不能插入系统指令。
- thinking 默认按适用档位使用 adaptive block binding，并加入
  `thinking-binding-controls-2026-08-01` beta；保留宿主其他 beta token。Haiku 的
  disabled effort 仍生效，显式 thinking block 的预算参数不丢失。
- `journaled-system/v1` 把预算、工具准入和上下文连续性控制写入不可改写的回合记录，
  在上下文计数和模型意图之前提交；新控制不重写已经发送过的前缀。未回答的控制
  可绑定到真正准入的 guide/steer 输入，在请求视图中作为历史数据引用。
- `stable-task/v1` 稳定模型看到的工具声明。实际执行仍由每轮准入、权限和预算决定，
  最终收尾时不能因目录里还有工具就继续执行。
- `anthropic-client-compaction/v1` 把原始私有回放绑定到输入前缀和模型可见工具头。
  压缩/输入编辑或声明变化时，只在请求视图中移除失效 thinking；原签名、tool_use
  和工具结果保持原件。放弃记录在模型调度前持久化，重新规划不能恢复已经放弃的
  thinking。工具 ID 的宿主别名在 wire 上还原为原始 provider ID。

输入摘要用于识别 Native 选择的请求视图，不代表宿主能验证供应商签名。
没有原始输入绑定的私有回放在此新策略下保守放弃 thinking；没有启用新策略的
旧 Run 仍按旧行为运行。

本轮编译通过，7 项协议/核心检查及 3 项 Studio 配置恢复检查通过。包括真实本地
HTTP 连续三轮、启用上下文规划、ID 冲突、稳定目录和最终收尾不执行工具，以及
输入/工具头变化后的单调放弃。命令如下：

```sh
node scripts/build-native-harness.mjs
node --test packages/agentkit-harness/test/native-anthropic-context.test.mjs
node --test --test-name-pattern 'Studio Anthropic policy admission|managed binding reuses real Studio assembly' tests/studio-native-harness.test.mjs
```

日志位于 `.artifacts/native-migration/anthropic-projection-{build,tests,host}.log`。
本轮未重跑全仓、双 Node、安装、打包或完整压缩故障矩阵；未调用真实供应商服务。
这些本地结果不能代替正式 Gateway 的线上互操作和能力主表中其他未验收事项。
