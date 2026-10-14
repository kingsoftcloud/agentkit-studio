# 完全复用 DSH 会话列表：实施与验收

2026-10-14 用户选择默认复用 DSH 完整列表，取消按当前 Agent 自动过滤。阶段 2 因此改为删除过滤扩展和验证原生列表。代码移除、真实 Web 和 Electron 开发宿主的基础场景已通过。新 Profile、连接中断恢复、归档和已删除 Agent 历史的专项验收仍需补齐，阶段 2 尚未标为完整验收通过。

## 改动

- 删除 007 侧栏过滤补丁，从 015 删除配套 JSDoc、双语说明和文档哈希。
- 删除 Studio 的过滤注册、全局过滤状态及 setter，以及选择器和创建入口的自动过滤调用。列表不读取 localStorage 判断会话归属。
- DSH 原生分组、平铺、搜索、归档和排序保持其原有规则。选择 Agent 只通过官方 `agentPresets.select` 决定当前会话的执行绑定。
- 当前会话的显示兼容缓存继续保留；它不参与列表可见性，也不替代执行绑定。
- 保留 017（未分组新会话）和 018（取消工作区时保留 Agent），补丁数从 34 降为 33，历史编号不补号。

本轮不新增 `SessionAgentBindings` 查询或过滤状态订阅。此前关于显式过滤刷新取得的原型证据保留在忽略的本地目录中，不能用于宣布当前原生列表方案验收通过。

## 验收记录

| 检查 | 状态 |
| --- | --- |
| 源码和 bundle 不再注册 Studio 过滤器或全局 setter | 通过；列表派生文件与固定上游字节一致 |
| 33 个补丁在固定干净 DSH 基线上顺序应用 | 通过；包含 018 测试夹具修复的最终系列已另建干净 checkout 复核 |
| 官方构建、工作区测试、Studio 发行输入检查 | 官方构建通过；DSH 405 项工作区测试、Studio 696 项检查通过，无跳过或失败 |
| 真实 Web/Electron：选择 A/B 或恢复原生会话后，其他历史会话仍可见 | 两端均通过 |
| 清空/伪造缓存后重开、分组、平铺和原生搜索 | 两端均通过，共各 7 个场景 |
| 新 Profile、连接中断恢复、归档、已删除 Agent 历史 | 专项验收待补齐 |

执行绑定、Session 日志和 Agent Revision/Build 格式不变；本轮不发布、不合并。安装更新、Windows 原生和云端结果仍单独记录。

真实浏览器的数据来自完整 Studio Profile：通过实际 RPC 创建两组 Harness Agent，官方 preset admission 和 Session Controller 创建会话，配置模型完成真实请求，再经 DSH 持久化重开。列表断言使用实际 Session ID；搜索断言使用 DSH 自己呈现的标题。没有把展示缓存当作会话身份。

全量工作区测试发现 018 的旧 rename 测试夹具没有提供新增的 `remote.session`、`remote.commands` namespace。已补齐夹具，没有改变产品运行路径或删除测试；最终 405 项全部通过。

证据在忽略的 `.artifacts/refactor/stage-2/`。`native-sidebar-web.json` 和 `native-sidebar-electron.json` 记录真实宿主场景；Electron 为开发宿主，使用独立 user-data 与工作树内 DSH 和当前插件，未验证安装升级或 Windows 原生运行。
