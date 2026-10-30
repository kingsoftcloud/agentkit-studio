# A2A 终态回执与原 Native 运行衔接

现有远程输入、审批或取消控制确认原远程 Task 已结束后，活动中的 Studio Native
Turn 会自动提交原工具的 `reconcile_tool` 命令，不再要求用户额外点击核对。
核心仍负责领取新的只读意图、验证回执、提交工具结果及继续模型循环。

宿主端口版本为 `agentkit.native-a2a-receipt-wait/v1`，记录在 A2A binding 中，
参与原配置和 Frozen 引擎绑定的摘要。独立 TS 核心不依赖 Studio 会话或 UI；
等待发生在 Node 宿主的 idle 回调中，不持有或伪造执行 fence。

等待器每 100ms 读取原调用的本地私有记录。只有 `phase=terminal` 且远程投影为终态
才返回核对命令；暂停、发送结果未知和没有记录均不发起远端查询、继续或取消。
等待器本身不更新执行数据库、不制造工具结果，也不把远端提示当作审批依据。
独立的历史事件 outbox 仍可投递已经提交的观察事件。

每次读取检查原 scope、Session、Run、完整 checkpoint、原工具意图与 uncertain 回执，
并核对私有调用保存的原 fence、工具定义、参数、turn/build/chain 和绑定 spec。
关闭、取消、被产品命令唤醒或 checkpoint 改变后，旧等待器不能继续授权动作。
其他结果未知的工具仍走显式核对。

命令 ID 由版本、原调用身份和终态投影摘要决定，不包含当前进程、时间或新 fence。
已持久化的同一命令不会被反复返回。进程在观察后、入队前退出，恢复时会得到相同 ID；
入队后退出，Kernel 恢复原队列。原副作用意图和 uncertain 回执保持不变，核对结果作为
新回执提交，原工具计费一次。终态已在本地持久化时，核对使用该事实，不新增 Task HTTP。

针对性验证：

```sh
node --test --test-concurrency=1 tests/native-a2a-receipt-wait.test.mjs tests/studio-native-a2a-reconcile.test.mjs tests/native-tool-receipt-authority.test.mjs tests/native-dsh-turn-runtime.test.mjs tests/native-host-child-approval.test.mjs tests/native-a2a-host.test.mjs
```

进程测试使用真实 SQLite、Native Kernel、私有调用记录、localhost 控制面/远端协议和
SIGKILL；模型输出及控制权限回调受控。Studio 集成用例使用实际生产服务、网关和执行器，
Session、工具注册及审批为明确的测试实现。它们不能代替完整挂载 Host、浏览器或真人验收。

本次补齐活动原 Turn 的终态回执衔接，以及底层 Kernel/SQLite 的冷恢复边界。
完整 Host 冷启动后若尚未接回原执行器，仍需现有显式恢复/核对入口；本地记录为未知时
也仍需显式查询确认。自动呈现并等待远程问题、持久化输入决定、显式过期事实、子任务
等待器、订阅和入站组装仍未闭环，完整迁移尚未完成。后续的
[显式输入决定](native-a2a-input-decisions.md) 已补持久化答案与操作意图的关联，
自动问题等待及独立答案/操作审批两阶段仍待实现。
