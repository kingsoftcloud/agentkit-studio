# Native 本地记忆迁移状态

参考 `ksadk-python` 的 `feat-ksadk-harness-2` / `355059d78e47ed764bbdb3606304cdf34e9838a3`。当前已实现本地候选提取、SQLite 候选消费与纠正/遗忘存储事务、压缩前 Hook，以及模型请求前的本地召回和上下文刷新。**完整记忆能力尚未迁移完成**：显式管理工具的权限/审批和核对、记忆验收、轮次完成后的候选消费、配置界面及全新安装验收仍待补齐。

现有绑定 `memory-instance` 的云记忆是另一个路径：它通过 AICP 召回并在轮次后提交对话。此实现没有用云端对话写入替代 Python 的本地候选语义，Native 的云写入拒绝保护仍保留，等待独立的持久化副作用接入。

## 当前接入

受信任的 Agent Revision/Build 配置可启用本地压缩前消费：

```js
{
  memory: {
    enabled: true,
    providerRef: 'local-default',
    scopes: ['user'],
    recall: { enabled: false },
    write: { mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: false }
  },
  context: { rollout: { memoryWrite: 'enabled' } }
}
```

`write.mode` 支持 `off`、`explicit_only`、`candidate`。`memoryWrite` 支持 `off`、`shadow`、`enabled`，缺省为 `shadow`；shadow 只在 Hook 结果中报告候选策略判定，不打开记忆数据库、不累加观察次数。关闭记忆、关闭压缩前消费、不含 user scope、write off 或 rollout off 都不安装此 Hook。`flushAfterTurn` 已纳入策略绑定，但其消费者尚未实现；目前请勿据此认为轮次后会自动保存。

Hook 与受信任宿主注册的其他 Hooks 合并，保留显式 Stop 继续次数上限，重复 ID 或冲突策略拒绝组装。其绑定包含原 Agent 修订/Build/spec 和来源契约；恢复时重新派生，不接受漂移后的来源。它使用已有的密封 Hook 意图、回执、租约与取消机制，不参与工具授权或任务验收。

本地自动召回通过 `memory.recall` 启用，缺省为 `{ enabled: true, maxTokens: 1600, topK: 8, minScore: 0.45 }`；上例为单独演示压缩前写入而关闭了它。关闭 recall、令 maxTokens 为零或设置 `context.contributors.memoryRecall: false` 都会停用自动召回。召回不受写入 rollout 限制，`write.mode: off` 仍可读取已有事实。

`studio.memory-recall` 是版本化的只读 Context source，绑定原 Revision/Build、scope、Session 和策略。每个持久 Context 意图重新查询 SQLite，不缓存上一轮结果；独立 writer 纠正或遗忘后，下次请求即可看到新状态。新租约会废弃旧召回视图，并用精确的 `not_dispatched` 回执退役尚未领取的模型意图；已领取的效果仍走原恢复分类，不能借刷新逃避结果未知状态。存储层只认可完整匹配的刷新事务，不能凭回执代码绕过领取检查。

本地检索沿用 ASCII 词项和 CJK 二元词的覆盖率排序，置信度不是相关度；它没有语义向量索引。召回校验 tenant/workspace/scope、当前正文摘要、版本、状态、有效期及高敏感标记。来源和版本随完整事实放入不可信 user 数据封装，不能授权工具或证明任务完成，也不写回原用户历史。全部封装使用绑定的模型 wire tokenizer 计费；按整条选择，不截断事实，大项无法装入时仍尝试后续小项，且不能挤占必须保留的输入和输出预算。可选来源失败/超时跳过，调用方取消仍传播，迟到结果不被接纳。

## 来源与存储边界

`studioOriginalUserMemorySources` 对每个待压缩用户消息核对当前消息引用、原历史 Run/消息索引、原 Run 配置摘要及 Host 准入胶囊。只接受原人类用户输入；schedule 即使用了 user 模型角色也排除。只从原始文本块提取，不把附件、工具、模型、摘要或宿主上下文视为记忆来源。重复投影保留原始来源身份，不能成为第二次观察。

`nativeUserMemoryCandidate` 对完整陈述识别显式记忆意图和隐式偏好；不截断长事实，不从引用段落中匹配子串。用户 scope 包含 tenant/workspace/Agent/user；其他 scope 也通过明确命名空间绑定。ID 使用 TS 契约的 canonical SHA-256，不要求复刻 Python 的 JSON 字节或历史摘要。保留参考正则的边缘行为，例如单独的“记住：”会把冒号提议为候选；候选本身不是授权。

`SqliteNativeMemoryProvider` 使用 WAL、synchronous FULL 与 BEGIN IMMEDIATE。每个候选的事实、来源消费标记、独立观察及回执共享一个事务：

- 隐式偏好第一次仅 pending，第二个独立原始来源才可提交；同来源在其他生命周期中重投只得到 duplicate_source。
- 命中敏感标签或检测规则的内容及超长候选拒绝；检测是 best-effort，并非完整 DLP。pending/rejected 状态不保存候选正文。回执保存处理结果与指纹，不保存请求正文。
- 同槽位纠正保留业务 ID 并增加版本；跨 principal 隔离。显式纠正的历史输入边界与事实同事务消费，保留无关槽位的观察。
- 遗忘清空事实正文与槽位观察，保留原来源标记；旧来源不能复活记忆，新来源从第一次观察重新累计。
- 重用操作 ID 但更改请求参数会冲突。旧回执是历史效果，不能证明事实当前仍存在；读取事实必须重新查询。

数据库位于 Studio store 的 `native-harness/memory-v1/<tenant摘要>/memory.sqlite`，与 Run ledger 分开。单个候选内有原子性；一批候选之间、记忆库与 Run ledger 之间没有分布式事务。回调在记忆事务提交后丢失结果会进入结果未知状态，停止摘要派发，不自动重跑；当前人工核对产品流程仍待完善。

## 已执行验证范围

相关测试包含 `packages/agentkit-harness/test/native-memory*.test.mjs`、`packages/agentkit-harness-core/test/context-contributions.test.mjs`、上下文规划/视图及存储/恢复测试，以及 `tests/studio-native-memory.test.mjs` 和 `tests/studio-native-harness.test.mjs`。此次 Node 22、26 各通过 134 项；随后补充压缩阶段准入与 tokenizer 超时回归，两版本各通过受影响模块的 41 项，没有运行全量套件。

覆盖确定性 Python 行为样例、原始来源校验、真实 Kernel 压缩与生产 Host 工厂组装、真实 SQLite 事务回滚、两个独立 Node writer、提交前后实际进程退出及数据库重开、遗忘/纠正/重投，以及提交后回调结果丢失时不派发摘要且不重复写入。新增召回覆盖当前版本与有效期、跨 principal 隔离、整条封装预算、来源/计数超时、取消，以及新租约在模型派发前废弃旧视图；生产 Host 测试还覆盖独立 writer 在两次模型请求之间纠正事实、压缩前 Hook 后继续召回。Host 工厂测试使用受限的 Host/HTTP response doubles。

`node scripts/verify-studio-native-harness.mjs --source <已构建的维护源码> --mount-host --memory --archive <Studio打包文件> --keep` 另通过实际打包的完整 Host、真实认证 HTTP、标准 preset 和公开 SDK 连续运行四轮，在第二轮后关闭并重启 Host。普通用户输入通过真实 tokenizer/context planner 触发压缩；摘要通过实际模型 HTTP 返回。两条独立原始偏好形成一个 v1 SQLite 事实，后续重复压缩复用原始来源回执；另一 Agent 不能读取该事实。公开任务流在模型响应完成前可见，并与持久化 Session 字节一致；内部摘要不作为公开回复流或回复正文展示。独立默认 DSH 会话继续可用。加 `--frozen` 会在创建 Build 后关闭最新 Revision 的记忆，再核对执行遵循原 Build。

开启召回后，第三、第四轮实际模型 HTTP 请求均含当前 v1 事实及其不可信来源封装；这同时验证摘要与 Hook 前后的重新查询。普通 Revision 在 Node 26、固定 Build 在 Node 22 均通过。首次打包验证发现压缩阶段被错误排除，修复后补回归并通过重验。

此场景运行子进程的 PATH 仅含 Node，Python 配置指向不存在的位置。它使用固定的本地依赖图与真实 HTTP 模型模拟端，不代表全新依赖安装、真实外部模型或浏览器界面已经验收。
