# Native 本地记忆迁移状态

参考 `ksadk-python` 的 `feat-ksadk-harness-2` / `355059d78e47ed764bbdb3606304cdf34e9838a3`。当前已实现本地候选提取、SQLite 候选消费与纠正/遗忘存储事务、压缩前 Hook，以及模型请求前的本地召回和上下文刷新。轮次完成消费、read/search/manage 工具与显式记忆验收现已接入生产 Native Host 和 DSH 工具权限管线。配置界面支持本地记忆，模板创建支持该提供方。**完整记忆能力尚未迁移完成**：云记忆写入、未知副作用的人工核对流程及完整产品安装和浏览器运行验收仍待补齐。

Agent 表单分别保存召回、写入方式、压缩前/轮次后刷新、作用域和写入开关。关闭记忆会保留原设置，空作用域不会自动扩大；写入默认使用 shadow，开启实际写入需要明确选择。Harness 模板可使用 `local-default`，允许写入方式为 `off`；只有启用的本地记忆可以满足模板必需的记忆库要求。关闭本地记忆后创建、重读和保存新修订已通过真实 Agent store 验证；完整浏览器交互尚未验收。

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

`write.mode` 支持 `off`、`explicit_only`、`candidate`。`memoryWrite` 支持 `off`、`shadow`、`enabled`，缺省为 `shadow`；shadow 的自动候选消费只报告策略判定，不执行写入、不累加观察次数；独立的只读记忆工具仍可访问数据库。关闭记忆、关闭压缩前消费、不含 user scope、write off 或 rollout off 都不安装此 Hook。`flushAfterTurn` 已接入生产 Host：canonical completed Run 提交后、资源释放前消费当前原始用户输入；仍须满足写入方式、rollout、资格与来源校验。

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

## 独立轮次消费与显式验收

`bindStudioNativeMemoryTurn` 只消费当前 canonical completed Run 中经原始 Host 准入确认的人类输入，复核原 Revision/Build、scope 和 Session。资格沿用参考的 verified/unverified 条件，失败或阻塞的验收不进入消费。显式记忆任务及已执行的管理操作走各自所有者，不从自动候选路径补写；原始 source 身份与压缩前 Hook 共用，不能重复累计观察。

整轮适配器提供受资源生命周期约束的 `consumeCompletedTurn`：主终态提交之后、资源释放之前执行，取消或截止撤销消费能力，消费异常不替换主结果。消费器关闭会取消在途调用，迟到回调不能开启新数据库写入；已提交但丢失结果的效果仍视为未知。消费器与压缩前模块的定向测试在 Node 22、26 各通过 36 项；生产 Host 已将该回调纳入终态资源生命周期。

`studio.explicit-durable-memory/v2` 只读验收器为已识别的单一显式记忆目标固定验收身份。它重新读取当前 scoped fact，管理写入还须取得与原完整调用、正式工具定义及操作键一致的真实 owner receipt。承诺、伪造工具 JSON 和事实已变化的历史回执不能通过；已持久存在并被当前召回或显式读取的 add 目标不要求重复写入。证据服务失败仍阻塞，验收器不会写入或授予审批。相关验收与既有 verifier 的定向测试在两个 Node 版本各通过 40 项；现由 Host 将基线验收器与真实 Memory owner 验收器组合。

安装包组件可使用 `node scripts/verify-native-studio-install.mjs --archive <Studio.tgz> --keep` 独立验证。它在仓库外以新 npm 缓存安装完整包的生产依赖，禁用安装脚本，PATH 仅含 Node，再加载 Studio/Native Host 工厂并执行真实 SQLite、记忆和 WASM 源码解析。Node 26、22 的新目录安装均成功；此检查不启动完整 DSH Host，也不执行 Codex，不能代替完整产品安装运行验收。

## 管理工具与共享 preset 生命周期

启用本地记忆并提供作用域时，Host 绑定锁定的 `read_memory`、`search_memory`；允许写入时增加 `manage_memory`。工具仍进入实际 DSH pre/guard/around/post 管线。非明确请求的写入和所有遗忘操作需要真实 ApprovalService 的当次授权。审批后及 SQLite 变更前重新核对原调用、完整定义、当前 intent、租约/fence、Session 和 Build 胶囊；过期调用不能借迟到批准写入。

同 preset 的 DSH 工具注册由网关共享，每个 Session 的锁定定义和 Memory owner 单独绑定。单个 Session 结束只释放自己的 owner，不注销共享工具，也不改变其他 Session 的工具摘要。网关关闭同步撤销全部仍在使用的 Memory owner，避免等待中的批准在关闭后写入。子任务不能借用父 Session 的 Memory 工具。

Host 工厂、工具网关及 Memory 防护三个相关模块在 Node 26、22 各通过 50 项，无跳过；包括真实 SQLite 的双 Session 并发、网关关闭后迟到批准无写入、新租约拒绝旧执行者以及真实 tokenizer 对非空检索结果的计数。确定性模型和受限宿主 fixture 不等于完整产品浏览器验收。

完整打包 Host 验收入口为：

- `node scripts/verify-studio-native-harness.mjs --source <维护DSH源码> --mount-host --memory-managed --archive <Studio.tgz> --keep`：八轮记忆读写、纠正、遗忘、拒绝、Host 重启及 SQLite owner 回执核对。
- 同一命令改用 `--memory-parallel`：两个真实 SDK Session 共用一个 preset；A 等待审批时 B 写入并释放，之后 A 继续搜索、B 新轮读取。
- 两者均支持 `--frozen`。`--studio-dependencies <node_modules>` 可以选择全新安装的普通 Studio 依赖图；DSH Host 依赖仍由 `--source` 提供，不代表完整 Host 已完成全新安装验收。
