# Native 源码读取与批次预算

新建且已选择 Native 的 Studio 根运行及子任务绑定 `sourceReadPolicy: "studio-source-read/v1"`。
只有可信只读工作区工具可以绑定 `sourceObservationPolicy: "workspace-source-model/v1"`
和 `resultArchivePolicy: "archived-model-view/v5"`。恢复运行保留原可选配置及摘要；没有
该策略的运行、DSH Native 和 Codex 继续使用原来的读取方式，产品默认引擎未切换。

## 原文、模型观察与编辑权限

Node 工作区读取在原有路径授权及文件读取内捕获所选行的完整内容，包含实际请求的
行号格式。模型只收到 token/字节上限内的连续页面，审计大小、mtime、原文载体和
SDK 私有 locator 不进入页面。纯 TS 投影保留未知数据键及精确大整数。

Kernel 只从 Host 后置策略授权的观察归档完整原文，验证真实存储返回的摘要、媒体
类型和字节数后授予引用。后置策略移除的原文不能从私有回执恢复到可读归档；归档时
也不再读取可能已变化的工作区文件。完整私有回执仍留在原执行账本。

没有一整行能够返回时，结果为明确的 `source_state: "unread"`，附归档可用性。
归档成功不授予工作区编辑前置读取状态，也不增加已观察的源码进展。归档失败同样
保留已知读取结果，不能因此重新执行调用。后续 ArtifactRead 只提供归档观察，不自动
成为当前文件的新鲜读取证明。

## 原批次容量

模型返回后、回执提交前，Kernel 使用实际准备好的模型请求计算基础容量，包含当前
协议的工具 schema、参数、指令、受保护消息、原始 assistant 调用声明、模型输出上限、
潜在归档引用及适用的摘要/结果外框预留。计数器缺失、失败、超时或溢出只令容量
不可用，不能把已经获得的模型响应改成可重试失败或重新生成这批调用。

分母来自原声明的全部 workspace/ArtifactRead 读取调用，而非一次并发调度的子集。
带配置、目标、原批次及计数器身份的额度与模型回执一起提交。拆批、数据库重开和
进程恢复使用同一额度；Host 从当前原意图账本核对描述符，拒绝缺失或篡改的额度。
子任务使用自己的模型计数器、Run 及归档作用域，父任务不因委派获得子任务引用。

工作区页面同时满足源码额度、完整投影结果的转义 token 成本和 UTF-8 字节上限。
普通 ArtifactRead 也检查源码/结果额度，结构外框无法容纳时在存储 I/O 前拒绝；Unicode
分页使用连续字符偏移，不丢失下一页内容。原声明只有一个 ArtifactRead 时，另有完整
请求准入：真实 reducer 和 planner 确认页面可直接进入下一次请求，或完整历史可在一次
摘要请求中覆盖后，允许保留整个已读取页面，仍受单次结果字节上限约束。不会执行预测
的模型调用；实际摘要输出仍须通过 Kernel 验证。存在外部效果或需多片摘要时保留分页。

## 压缩时的源码工作集

新建 Native 根运行和子任务默认保留至多 8 个不同的源码范围或归档页面。每个完整调用
批次上限 6000 估算 tokens，工作集累计上限 16000；配置为 `context.compaction` 下的
`readWorkingSetCount`、`readWorkingSetMaxTokens`、`readWorkingSetTotalMaxTokens`。
预算使用实际协议的单消息投影计数，保留完整 assistant/工具回执组，并核对完整请求
硬窗口；工作集可以高于一般历史的压缩软目标。未启用新字段的恢复配置保持原样。

工作区读取范围和完整工作区搜索可被保留。后续未知或写入调用会使先前工作区观察
失去这项保护；压缩历史记录工作区版本，跨版本也不继续保护旧读取。已观察且绑定
授予引用的不可变 ArtifactRead 页面使用独立身份，可跨工作区写入保留。两者都只是
上下文保留规则，不授予编辑许可、引用访问权或任务验收。强制压缩不额外保护工作集。

Studio 近期完整工具批次默认保护 4 批，单批上限 `min(12000, contextWindow / 6)`、累计
上限 `min(24000, contextWindow / 4)`，除法取整，与参考 Studio 组装层一致。字段为
`recentToolBatchCount`、`recentToolBatchMaxTokens`、`recentToolBatchesTotalMaxTokens`。
它仍受压缩软目标限制。一般历史按时间后缀保留，遇到不能容纳的近期单元就停止，
不会因为较早单元更短而把它重新放到新摘要之后；源码工作集单独处理。恢复配置分别
保留这组三字段和源码工作集字段的原有缺省状态。

## 可选旧工具结果清理

`spec.context.compaction.pruneToolResults: true` 启用参考 Native 的 microcompaction。
Studio 默认关闭；未配置的恢复运行继续保留字段缺省状态。可选参数
`pruneKeepRecentBatches` 默认 5，`pruneMinSavedTokens` 默认 256，均为正整数。
只在达到压缩触发阈值时尝试；完整模型请求的实际计数必须节省到最小额度且降至触发
阈值以下，才直接继续任务而不调用摘要模型。强制压缩不使用此投影。

成功状态来自真实工具执行回执的 `toolOutcome`，不从模型或工具正文推断。
缺少状态、错误、待审批、媒体、浏览器、规划、委派只读及永久保留的结果不能清理；
仍有效的源码工作集在 token 保留上限之前受保护。近期批次只统计完整工具批次，
中间的普通消息不消耗窗口。投影保留原调用配对，用带原消息引用和内容摘要的标记
替换旧正文，清除旧的替代显示/回放字段。原始 transcript 和持久工具回执不变。
采用的投影及节省量随 `preparedContext.toolResultPruning` 持久化，并发出
`context.tool_results_pruned` 事件；数据库重开后无需重放工具或补发摘要请求。

参考为 `355059d` 的 `context_microcompact.py`、`context_request_projection.py`
和实际 Studio `native_planning.py` 的关闭默认值。TS 额外使用可信执行状态字段，
因为已有 TS 工具观察不统一包装为 Python 的 `{status, content}` JSON。

本项只运行 Node 26 编译、4 个新增行为用例及直接受重构影响的 6 个工作集用例。
新增用例包含完整请求计数拒绝、保护观察及真实 Kernel/SQLite 重开；未跑全量。
最初两个新增 fixture 分别含非法 undefined 和把可缺省的 task purpose 当成必填，
已修正 fixture 后通过，未放宽运行时断言。命令为
`node scripts/build-native-harness.mjs` 及
`node --test packages/agentkit-harness-core/test/context-microcompact.test.mjs packages/agentkit-harness-core/test/source-working-set-planner.test.mjs`；
新增文件修正后只重跑该文件。Claude Code 在独立 worktree 的纯模块任务超时无交付，
本项代码由 Codex 完成，worker 原有三文件修改未变化。

## 验证边界与剩余工作

定向测试覆盖真实 NativeKernel、Node 工作区/归档存储和 SQLite，以及三种协议的实际
请求投影计数；模型响应和 DSH registry 是受控适配器。真实子任务 Host 验证完整原文、
独立策略、父子引用隔离及数据库重开。两处真实 SIGKILL 验证原额度在执行前、部分
调用完成后持久恢复，六个原调用各执行一次，模型不重新生成原批次。

ArtifactRead/Search 的原声明批次现进一步使用真实 reducer、调度及无压缩 planner
投影完整下一次请求，保留已经封存的成员和实际预算耗尽后缀。搜索动态额度按原声明
及剩余成员分配；并行段返回后再用真实结果核对完整请求，裁剪现有页面或搜索反馈，
不重新执行读取。逐归档反馈保留所有原 URI，无法容纳结构时返回明确容量错误。

这仍不是原参考全部容量策略的等价实现。报价只覆盖无中间命令/Host 变化且能进行
纯转换的路径；需要运行 Hook 或其他外部效果的路径不能伪造预期回执。源码范围保留
及单页完整摘要输入已接入，近期工具批次窗口默认值也已接入。完整、未裁剪且仅包含
已授予 URI 的逐归档搜索可以作为工作集身份，失败行或裁剪反馈不能冒充完整观察。
其余压缩投影配置及完整行为对照仍待闭环。最终上下文 planner 仍负责实际模型请求
准入，报价不会覆盖它。新增策略仅做编译和直接相关检查，未进行全量回归。

尚未完成本项的新安装包/维护版完整 Host 证明、线上模型后端、真实浏览器/人机验收、
所有产品入口及默认切换。此前包和 Host 的其他专项证据不自动覆盖新增源码策略。
