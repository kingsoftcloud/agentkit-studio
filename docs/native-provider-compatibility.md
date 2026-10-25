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

## 仍需收尾的模型语义

长流 `idle/v1`、独立 thinking 显示和 disclosed `delegate_task` controller 默认
effort 现已实现并接入冻结配置，具体行为和新增证据见[流式等待](native-stream-timeouts.md)。
高级 Anthropic block-binding / 中途 system 投影尚未逐项闭环；不能从普通请求及
上述定向结果推定这些投影已经完成。
