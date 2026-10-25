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
恢复保留原运行配置。Python Studio 的 v1–v7 产品策略到预留时间的自动计算尚未映射；
当前使用明确数值配置，不能把这个接入差异记为已经完成。

核心在准备上下文时提交当前目标的预算观察，进入交付窗口后只保留 Host 已声明的交付
写工具，以及本次运行、当前目标实际成功写入路径的只读检查。模型声明、历史变更路径、
失败或结果未知的写入均不能扩大读取范围。读取 schema 约束和模型批次校验同时执行；
包含越界读取的混合批次不会先执行其中的写入。现有浏览器待观察/验证策略优先，
模型最终预留和工具预算仍有效。

生产网关仅在显式启用时为可信的 `write_workspace_file`、`edit_workspace_file`
和 `read_workspace_file` 添加相应角色。外部 MCP 工具不能仅靠同名获得交付权限。
首次绑定、后续输入刷新和原运行恢复使用同一角色配置。

原始回执和文件内容保持不变。模型输入的分页建议会根据当前可用读取范围调整，避免
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
