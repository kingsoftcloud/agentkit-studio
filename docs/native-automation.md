# Native 自动化与调度恢复

本地定时计划使用当前 Revision；评测使用选中的 Frozen Build。它们通过相同的
`createNativeAutomationRunner` 调用公开 SessionController，并由已准入的运行时控制
执行循环。选择 Native 的 Harness 由 NativeKernel 执行模型和工具；DSH Native 和
Codex 继续使用各自的运行时。无人值守任务沿用只读权限与禁止交互式审批的策略。

执行器在提交 prompt 之前注册取消处理，因此等待 Host 确认期间的超时或取消也会
发送到原 Agent。取消失败作为错误返回；迟到的确认或 idle 拒绝会被观察。成功结果
必须等待 Session 的公开 `flush` 明确返回 `true`，再读取原轮次历史和交付输出。

调度器按任务隔离正在运行的 occurrence，不同到期任务可并行启动。创建 occurrence
和推进计划的最后触发时间在同一 SQLite 事务内提交，然后才调用 Agent，避免进程
退出后同一个 once 计划再次自动派发。

同一私有目录只允许一个调度器所有者，第二个宿主立即返回 `SCHEDULER_OWNED`。
独立 SQLite 锁事务保持到调度器退出，OS 在进程死亡时释放；不以 PID 或文件年龄
推断所有权。正常退出先等正在运行的任务结束，再释放数据库和所有权。

新宿主获得所有权后，将上次仍在执行的 occurrence 标记为失败并附
`AUTOMATION_OUTCOME_UNKNOWN`。这表示原执行结果尚未确认，保留原 occurrenceId、
sessionId 及已有 runId，不能据此宣称原副作用失败或重新执行。通过原会话核对实际
引擎状态；Native 运行使用原运行恢复入口。周期计划仍按下一次触发时间执行新的
occurrence，原 occurrence 不自动重放。

相关验证为调度器并发、真实子进程 SIGKILL 后锁释放及原 occurrence 不重放，以及
真实打包 Host 的认证计划/评测路由、Native SQLite 运行、权限拒绝和跨进程会话恢复。
这里的模型是实际 HTTP 上的确定性服务，复用维护版 SDK 依赖图；不是线上模型、
全新安装或所有部署后端验收。其余门槛见 [迁移状态](native-migration-status.md)。
