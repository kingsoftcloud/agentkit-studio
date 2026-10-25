# Native 截止时间与交付窗口

参考固定在 KsADK `355059d78e47ed764bbdb3606304cdf34e9838a3` 的
`harness/native/tool_budget.py`、`execution_budget.py`、`delivery_artifacts.py`、
`delivery_context.py`、`delivery_feedback.py`、`run_clock.py` 和 `effect_control.py`。
这是 Native 的运行预算与可选交付策略；不赋予新的工具权限或验收结论。

Studio 可在 Revision/Frozen Build 的 `spec.execution.nativeLimits` 中固定：

```json
{
  "maxWallMs": 600000,
  "finalizationReserveWallMs": 60000,
  "deliveryContextRecoveryPolicy": "delivery-window-summary/v2"
}
```

时间单位为毫秒。Host 接受的硬时限范围为 1–86400000，交付预留为 0–240000；
预留为 0 时不启用交付窗口。压缩策略可省略或为 `null`、
`committed-write-summary/v1`、`delivery-window-summary/v2`。省略不补写新字段，
恢复保留原运行配置。

也可在 `spec.execution` 中固定原 Studio 产品策略，例如：

```json
{
  "nativeWallDeliveryPolicy": "deadline-delivery/v7",
  "timeoutSeconds": 600
}
```

`timeoutSeconds` 是 0–3600 的整数；0 表示没有硬时限，交付预留也为 0。
声明策略但省略超时时使用 300 秒。只声明超时时固定硬时限，不启用交付窗口。
同一次配置不能在 `nativeLimits` 中重复声明由产品策略计算的墙钟/压缩字段；
冲突会拒绝绑定，避免隐藏覆盖。模型和工具次数上限仍可独立配置。

| 产品版本 | 交付预留（秒） | 交付编辑 | 本次交付文件回读 | 交付上下文压缩 |
| --- | --- | --- | --- | --- |
| v1 | `min(60, floor(timeoutSeconds / 10))` | 关闭 | 关闭 | 关闭 |
| v2 | `min(240, floor(timeoutSeconds / 2))` | 关闭 | 关闭 | 关闭 |
| v3 | 同 v2 | 关闭 | 关闭 | `committed-write-summary/v1` |
| v4 | 同 v2 | 关闭 | 关闭 | `delivery-window-summary/v2` |
| v5 | 同 v2 | 启用 | 关闭 | 同 v4 |
| v6 | 同 v2 | 启用 | 启用 | 同 v4 |
| v7 | 同 v2 | 启用 | 启用，调整分页建议 | 同 v4 |

这些角色要求实际绑定的可信 builtin；v6/v7 回读还要求可信编辑器已绑定。
v2–v7 的原公式还有 `ceil(2 * effect_timeout_seconds)` 项；原组装器在这里传入
默认 120 秒，因此该项为 240，而不是后续浏览器/子任务加长后的效果时限。
v3–v7 摘要输出使用模型上限与声明摘要上限的较小值；v1/v2 保留模型输出上限。
未声明产品版本的原 TS 数值配置继续保留其已有摘要、工具与分页行为。

新 Native 运行的可信写工具会在执行前核对当前目标明确要求的精确 UTF-8 内容。
错误内容返回字节差异；启用交付编辑时，对该精确目标文件的编辑返回完整写入要求。
两者都不落盘、不替换已经审批的参数，纠正后的调用仍须正常准入。
策略和工具定义进入完整配置摘要；恢复保留原字段，旧 TS 运行不因原始 spec 中
曾被忽略的产品字段而改变已接纳配置。原 TS 缺省配置与产品默认切换仍分别处理，
本次没有把所有新 Agent/Build 的缺省策略改为 v7。

核心在准备上下文时提交当前目标的预算观察，进入交付窗口后只保留 Host 已声明的交付
写工具，以及本次运行、当前目标实际成功写入路径的只读检查。模型声明、历史变更路径、
失败或结果未知的写入均不能扩大读取范围。读取 schema 约束和模型批次校验同时执行；
包含越界读取的混合批次不会先执行其中的写入。现有浏览器待观察/验证策略优先，
模型最终预留和工具预算仍有效。

生产网关按上述版本为可信的 `write_workspace_file`、`edit_workspace_file`
和 `read_workspace_file` 添加相应角色；显式数值配置保留原 TS 角色。
外部 MCP 工具不能仅靠同名获得交付权限。
首次绑定、后续输入刷新和原运行恢复使用同一角色配置。

原始回执和文件内容保持不变。v7 及原 TS 数值配置的模型分页建议按当前可用读取范围调整，避免
建议调用已经关闭的 ArtifactRead/ArtifactSearch；不推测缺失内容或声明已读完整文件。
修改后的实际输入与截止提示一起计入上下文预算。

`committed-write-summary/v1` 只允许在实际成功的最近交付写入回执之后压缩；
`delivery-window-summary/v2` 允许在交付窗口内、尚未写入前修复上下文。
两者都不得花掉最终模型预留，不得越过待执行工具、审批或私有复核，也不延长原时限。
压缩调用计入原模型调用预算。

运行使用本地单调时钟记录活动时间，提交到持久账本，包含效果之间和回调中的活动耗时。
暂停、等待审批或核对期间不累计；重开保留已提交消耗，不声称重建崩溃前未提交的时间。
租约和重试时间戳仍使用墙上时钟。运行中的模型和工具同时受端口超时和剩余硬时限约束。
工具超时不能证明写入是否发生，仍进入结果未知/核对流程，不自动重放。

定向验证覆盖内存/SQLite 重开、真实文件、单调时钟与系统时间回退、运行中超时、
压缩预算、分页建议和四个真实 SIGKILL 边界；共享 Studio Host 另覆盖 Revision/Frozen
HTTP 模型响应与实际 Node 网关文件读写。这里的 HTTP 模型使用确定性响应；这些证据
不代替全部产品入口、真实线上后端、其他平台、最终安装及默认切换验收。
