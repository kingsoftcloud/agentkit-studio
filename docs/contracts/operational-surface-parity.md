# 运营工作台与旧版 Studio 对齐记录

本记录用于逐项核对旧版 `ksadk-python/ksadk/studio/react-ui/src/pages/` 与
`agentkit-studio` 插件的四个运营页面。页面继续使用 AgentKit Studio 的外观和 DSH
左侧导航；数据、写操作和错误状态均来自 Host/API，不用静态演示数据代替真实结果。

## 对照结论

| 页面 | 旧版 Studio 的关键能力 | 当前插件实现 | 验收口径 |
| --- | --- | --- | --- |
| 自动化 | 新建/编辑、一次性/间隔/Cron、启停、立即运行、删除、看板/列表、执行历史、任务详情、DSH 原生会话自动化提示 | `schedules`、`scheduleOccurrences`、`create/update/run/toggle/delete`；待执行/执行中/需关注/已暂停四组；任务详情和分页；保留 DSH 原生 schedule 目录 | Host 不可用时显示失败态；成功时列表、状态和 occurrence 必须来自 Host |
| Channels | 连接配置、渠道 CRUD、配对审批、会话绑定编辑/解绑/接管、消息会话、平台扫码连接 | 连接配置、渠道 CRUD、配对通过/拒绝、绑定编辑/解绑/接管/释放、消息会话分页；飞书/企业微信支持 `GetConnectQr` 连接地址展示 | 不在插件内复制 Connector 存储；连接/配对/绑定/消息均通过 Channel Action API |
| 观测 | 时间范围、Agent/状态筛选、Trace 列表分页、Span/属性/事件/资源/轨迹/Raw OTLP、Session 导出 | 聚合指标、24 小时/7 天、Agent/状态筛选、Trace 分页、Span 选择、属性/事件/资源/轨迹/Raw OTLP、Session 导出 | 没有 Trace 时显示真实空态；详情读取失败不能伪造 Span |
| 评测 | EvalSet 文件导入、A2A/源码/Build 目标、超时、失败即停、评估器选择、运行筛选、运行详情的用例/断言/轨迹 | EvalSet 导入、三类目标、超时、失败即停、四种评估器、运行/评测集/目标分页、运行详情摘要/用例/断言/轨迹 | `createEvaluation` 使用幂等键；运行状态、结果和目标目录来自 Host |

## 版式约束

- 页面标题只由运行中心外壳显示一次，子页面使用说明行和旧 Studio 的下划线二级页签。
- 表格容器使用独立滚动区域；列表、详情和表单不再挤在同一个横向网格中。新建、编辑和详情使用统一的 Studio 抽屉对话框，较宽的运行详情允许表格和原始事件完整展开。
- 新建评测使用分组表单：EvalSet、目标类型/定位、超时和失败策略、评估器。窄视口下网格自动换行。
- Channels 的连接配置保持在页面顶部，资源列表、配对、绑定、消息使用独立页签和分页；连接字段和消息双栏在窄窗口下自动收缩并保留横向滚动。
- Trace 详情把 Span 列表、属性/事件/资源投影和原始 OTLP 分开，避免一次展开大段 JSON 造成页面拥挤；存在运行中 Trace 时每 5 秒从 Host 静默刷新。
- 评测存在进行中运行时每 4 秒从 Host 刷新，列表仍保留筛选、分页和详情抽屉，不在浏览器内伪造运行状态。

## 仍依赖外部合同的项目

1. Channel 二维码需要 Connector 实现 `GetConnectQr`；没有该 Action 时只展示明确的 Host 错误，不生成假二维码。
2. 观测指标和 Trace 内容需要 Runtime 上报；没有上报的耗时、Token 和 Span 显示“未上报”。
3. 评测运行器由 Host/Server 执行；插件不在浏览器内执行 evaluator，也不把静态数字当成结果。

## 验证

```text
pnpm check       # 51 个插件契约/回归测试
make ci          # check + pack，生成 .artifacts/*.tgz
git diff --check
```
