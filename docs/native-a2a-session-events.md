# A2A 远程观察进入 Studio 会话

内部 A2A 出站调用的 canonical 日志现在同时提供两个独立消费者：远程 task-sink
outbox，以及 Studio 本地持久会话。后者使用 `agentkit.a2a-session-event/v1`，不修改
原任务、模型协议历史、Native 执行账本或远程 outbox 的确认状态。

`agentkit/a2a-observation` 是 DSH 的 ignorable、非 surface 信息事件。外层 `seq`
由真实 Session 分配，从零开始；内层 `sourceSeq` 是原调用日志从一开始的序号。
`eventJson` 保留完整 canonical JSON，包括负零，避免 DSH 的普通 JSON 值约束导致丢失。
`sourceKey` 固定原调用和所有者；同一 event ID 内容冲突、序号缺口、Session 替换或
Agent revision/Frozen Build 对应的 preset 改变都会拒绝确认。

Session 投影按来源和 event ID 去重，每次成功或重复投递都必须调用真正的
`sessions.flush` 并确认有持久化监听器参与，然后才能推进原调用的
`managed.events.sessionDelivery.through`。会话落盘后、源游标确认前崩溃会补投相同
事实；Session 去重后再次经过持久化屏障。外部任务不随事件补投重跑。

Native 子任务固定父级真实会话为 `sessionDestination`，逻辑子 Session 仍保留原调用
身份。DSH Native/Codex 使用实际 Agent/Session/revision/Build，不伪造 Native Run。
预设重新挂载时恢复本地未消费日志，即便远程 outbox 已空。关闭或尚未打开的会话保留
未消费事实，待会话实际进入 Host 后重试；交付不启动模型回合或主动加载会话。
这一消费通道当前沿用内部 A2A canonical 生产路径，不能据此宣称其他事件生产者已齐全。

标准 Chat 使用维护版 `conversation.chat.node` keyed slot，Studio 助理视图使用相同
只读组件。消息、制品、公开工具活动、调用作用域和远程输入/审批提示保留各自身份，
展示有界纯文本与附件元数据；不自动访问 URI 或文件，不渲染授权/执行按钮。
远程审批提示仍是观察事实，完整 Host 审批决策集成另行验收。

受影响单元测试：

```sh
node --test --test-concurrency=1 tests/a2a-session-events.test.mjs tests/a2a-observation-view.test.mjs tests/native-a2a-event-host.test.mjs tests/native-a2a-host.test.mjs tests/native-dsh-a2a.test.mjs tests/dsh-node-a2a-tools.test.mjs tests/assistant-conversation.test.mjs
```

实际维护版服务与进程验证（`DSH_SOURCE` 指向已构建的维护版 checkout）：

```sh
node scripts/verify-a2a-session-events.mjs --source "$DSH_SOURCE"
node scripts/verify-studio-native-a2a.mjs --source "$DSH_SOURCE" --archive "$STUDIO_ARCHIVE" --internal-control-plane --public-tool-activity --keep
node scripts/verify-a2a-observation-view.mjs --source "$DSH_SOURCE" --history-root "$PROOF_ROOT"
```

Node 22/26 的实际 Session/投影服务验证覆盖落盘失败、重复投递、错误回执、非协作 flush
退役、Frozen 身份及 Native/DSH 恢复。SIGKILL 验证在落盘前和落盘后但源确认前杀死
真实独立进程：冷进程去重/补投，第三进程再次打开，均无新增远程调用。此处持久化载体是
明确的 fsync 文件测试载体；真正 Studio 持久化由打包 Host 验证覆盖。

两种 Node 的打包生产 Host 各交付 9 条 canonical 事件至真实持久会话，跨 PID 恢复后
原调用与执行账本保持不变、无新增模型/任务调用。实际维护版 Conversation assembler、
Chat builder、process grouping、renderer slot 和 React SSR 验证参考事件，并读取这些
Host 的实际历史，显示完整回复与远端工具活动。受控 HTTP 模型/服务和固定依赖图属于
明确测试边界；这些结果不代表浏览器交互、真实云服务、人机审批、Electron 或全新安装验收。

内部出站远端审批现已接入真实 Host 决定审计与原任务意图的原子提交，详见
[Host 审批决定](native-a2a-host-decisions.md)。这尚未覆盖自动审批等待器、显式过期事实和完整产品验收。

完整迁移仍未完成：订阅/自动等待器/入站服务、完整配置和后端差异、
线上 E2B、所有自动化/Frozen/部署组合、真实模型/Codex CLI 及最终默认切换仍需闭环。

## 当前任务面板的投递诊断

原任务控制回执现附带只读 `agentkit.a2a-event-delivery-status/v1`，从该调用的持久
journal 读取待投递、已确认、永久失败批次数和固定诊断代码。已有 A2A 任务面板显示
等待、重试、确认及失败；任务完成与平台事件投递结果分别显示。原事件内容、服务错误
正文、传输和凭证不进入这个投影。核对已终态任务只读原记录，不重发任务或 GetTask。
临时错误由原 Host dispatcher 重投同一事件；永久失败保留 dead letters，面板不提供
重新执行任务或伪造确认的按钮。宿主重开仍能读取原失败。

本次仅运行面板/真实 HTTP 事件 Host 两个相关测试文件，38 项通过，并构建浏览器包。
这不是完整浏览器人工操作验收。上文末段为历史阶段描述；当前实现及剩余事项以
[实现与验收对照](native-capability-status.md)为准，默认切换已完成。
