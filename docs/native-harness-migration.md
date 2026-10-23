# Native Harness TypeScript 迁移

Studio 的 Native 整轮执行现在先通过 `Agent.externalTurns` 写入版本化 `turn/owner`，等待会话持久刷新，再创建 Native Run。归属记录包含原 scope、Session、轮次、Run、Build、前序 Run、任务链、完整冻结配置及摘要、原始输入和模型来源，不包含端口或模型凭证。刷新失败或超时不会执行模型和工具；取消发生在此窗口时，先保存原 Run 的取消命令。重建 Agent 保留原未结束轮次，认证接口 `sessions/native-recovery-status/resume` 由可信 Host 重新绑定端口并核对完整配置后独占同一轮次、推进同一 Run。会话“子任务”面板已有明确的“恢复原运行”操作，读取和刷新不会自动执行；重复恢复请求不会新建 Run。普通 DSH 轮次与 fork 继续原修复路径。普通 Revision 与 Frozen Build 的真实进程退出、认证冷恢复已验证，完整浏览器和全部产品恢复流程仍待验收。

当前迁移尚未完成，Studio 的默认 Harness 仍沿用既有执行路径。生产 Host 已加入可显式启用的 Native 整轮执行与 Node 工作区工具组装；这不代表全部 Python 正式能力、各产品入口或安装方式已通过验收。

工作区 builtin 的同步写入现在使用 `agentkit.workspace-mutation-lock/v1`：同一规范工作区的预检与发布持同一个 SQLite 进程锁，等待结束及每次实际写入前重新核验当前 Native intent、完整工具调用、冻结定义和有效 lease/fence。该契约进入 Host 与插件绑定摘要。持锁进程退出后由 OS 释放；不会按文件年龄或 PID 猜测接管。子任务隔离工作区已接入同一锁，并已贯通 Host 的文件写入、同 Session 续跑、显式受控合并和原始凭证增量恢复，详见 [子任务工作区](native-child-workspaces.md)。编辑器与任意外部命令不参与这个协作锁，因此它不代表整个文件系统的原子事务。

行为参考固定为 KsADK 的 `feat-ksadk-harness-2` 分支提交 `355059d78e47ed764bbdb3606304cdf34e9838a3`。目标为现有 `runtime.type = "harness"`，保留 DSH Native 和 Codex runtime。没有 Python 历史会话数据，只免除历史数据兼容要求；新运行的持久化和恢复属于必备能力。

## 实现分层

- `packages/agentkit-harness-core`：TypeScript 配置、状态机、命令、预算、重试、效果调度和账本接口。
- `packages/agentkit-harness/src/native`：Node 持久化、模型和工具等端口适配器。
- Studio 与维护的 DSH 宿主：生命周期接入、资源解析、审批、会话事件投影和产品入口。

Native 必须独立控制完整模型/工具执行循环；宿主保留产品会话、生命周期和展示。整轮委派接入之后，不能再让 DSH 额外执行一次模型或工具循环。默认切换须等待能力与集成验收闭环。

## 持久化职责

Native 账本是执行状态、命令、效果意图及回执的权威。DSH 会话日志承载产品历史和兼容消费者的投影，不能反向用展示状态推断一个外部副作用是否完成。

Node SQLite 使用独立数据库、WAL 和事务提交，记录配置摘要、状态版本、租约、fence、命令、意图、回执、追加事件和投影游标。现有测试验证了同一事务回滚、过期执行者被拒绝、数据库重开，以及进程在意图提交后、claim 后、实际写入后退出的行为。已 claim 且没有回执的写操作不会盲目重放。宿主显式声明的纯推理和可重复读取可在持久上限内重新调度，以新操作键执行并保留旧未知回执；丢失尝试仍占用预算，失联期间不会延长墙钟额度。未知副作用的外部核对与产品操作流程仍需补齐。

## 当前验证与剩余工作

日常小步修改和模块合入只执行受影响的定向验证；全量回归留到一批能力接通后的阶段验收，或出现明确跨模块回归迹象时执行，不按每次提交或合入重复运行。

工具内部的模型等资源调用采用 `agentkit.tool-resource-usage/v1`：回执可将 `resourceUsageReported` 与 `resourceUsage` 一起提交。`false` 表示计数只包含已知部分，未知 token 或费用不被声明为实际零用量；已知调用仍扣减共享预算。回执、资源增量、`usage.reported/unavailable` 事件和不完整诊断在同一事务提交，重复驱动不重记。子任务沿用原有独立结算事件，新的完整性标记进入结算摘要，不能重复收费或事后改变。工具结果未知、取消或进程丢失回执时明确保留不完整诊断；所有终态（包括取消）按最终诊断输出 `usageComplete`。真实 SQLite 故障用例分别在工具副作用后、回执提交前，以及回执提交后执行 SIGKILL：前者进入核对且不重放工具，后者沿用已提交用量继续执行。恢复通过公开测试时钟使被杀进程的持久 lease 过期，没有编辑数据库记录。最后受影响的用量、Kernel 和恢复四模块在 Node 26.5 与 22.19 各通过 59 项；构建和类型检查通过，没有运行全量。Vision 适配器及产品展示仍须独立接入和验收，这些核心证据不能代替该集成。

生产 Host 的 `createStudioNativeHarness` 从 Studio Agent 修订或 Frozen Build 解析可信配置，绑定已选模型与工作区身份，通过宿主 attachment 服务解析用户图片和文件引用。凭证只在模型端口调用时重新读取，不进入 Native 配置或账本。`createNativeDshTools` 将 Native 工具意图交给实际 DSH ToolRegistry，保留其权限管线；被允许的十种工作区工具及本地命令工具使用 Node 实现。工具名与资源 ID 分开处理，停用契约不能重新获得 builtin 执行权限。写入成功后管线报错时保留未知结果状态，新轮次不能绕过未知写或中断状态继续执行。

开发验收可设置 `AGENTKIT_STUDIO_NATIVE_HARNESS=agentkit.native-dsh-turn/v1`，使新接纳的本地 Harness preset 显式绑定该契约；未知契约会被拒绝。未启用时，普通 Revision 保持原有 Harness 路径；Frozen Build 使用构建时固定的引擎，见下文。已启用的 Native preset 要求整轮 Host 接口，不能退回 DSH 模型步骤或 Python 工具循环。此开关用于阶段接入，默认切换仍待完整能力验收。未迁移的 builtin 当前显式返回 `STUDIO_NATIVE_BUILTIN_UNAVAILABLE`。本地记忆已接通压缩前消费、轮次后消费、管理工具和显式记忆验收；共享 preset 的多 Session 绑定与关闭防护见 `native-memory.md`。云端记忆写入仍显式拒绝组装，完整记忆能力尚未完成。

`node scripts/verify-studio-native-harness.mjs --source <已构建的维护源码>` 验证实际打包的 Studio 文件、公开 Host prompt 模块解析、生产 Native Host 工厂及 runtime plugin。它在真实 SDK profile 中选择 preset，执行两轮 Native 对话并在轮间重启进程，另外运行一轮策略拒绝写入，核对六次真实 HTTP 请求、两次经过实际 DSH 工具管线的 Node 文件写入、被拒绝的文件未落盘、会话持久化、用量和一个独立的默认 DSH 会话。Node 26 与最低 Node 22.19.0 均通过。运行子进程的 PATH 仅含 Node，Python 配置指向不存在的位置。该验证的 DSH 公共包及 Studio 依赖来自固定的本地 Host 图，不能替代全新环境安装、完整 `mountStudioHost` 启动或所有 runtime 的无 Python 验收。完整流式界面消费、审批界面、源读取工作集等剩余上下文策略、输入的显式重绑与未知领取恢复操作、其他正式端口和自动化/部署入口仍待完成。

已执行核心构建和 195 项核心测试，全部通过，涵盖模型/工具闭环、审批、取消、暂停、并行限制、预算、私有回放隔离、会话历史、验证证据绑定、结构化最终提交、工具参数校验、上下文规划、Hooks、SQLite 及真实进程恢复。同一组 195 项也已在最低支持的 Node 22.19.0 执行通过。单项证据只能支持其覆盖的行为。

进一步使用 `node scripts/verify-studio-native-harness.mjs --source <维护源码> --mount-host` 可在隔离的 SDK 进程中运行实际 `mountStudioHost`，加载公开的标准 preset、WebServer、Connection 和模型选择设置模块。该模式经真实 HTTP 验证未认证控制请求返回 401、认证连接、Host 兼容性、Agent 读取及 `agents/ensure-preset`；Native preset 由生产接纳代码创建，重启后验证生产启动恢复，测试不代为注册它。Node 26/22 均通过，仍保持六次模型 HTTP、两次 Node 写入、一次策略拒绝及后续独立默认 DSH 轮次的断言。SDK 握手早于可选 Host preset 恢复，恢复用例在测试中有界等待真实注册；此证据未覆盖完整浏览器应用、审批界面、Frozen Build 运行和全新安装。依赖由固定维护源码图提供，不能作为独立安装已通过的结论。

结构化交付通过宿主固定的 Draft 2020-12 schema 验证，使用独立的内部 `submit_final_output`，不会调用外部工具执行器，也不占用任务工具预算。提交与普通工具混合的批次整体拒绝；无效参数和缺失提交有重试上限。普通 JSON 答案只保守解包完整围栏，无效或含重复键的内容保留给验证端判断，不由核心擅自修复。

外部工具在进入端口前校验完整参数；严格解码失败不能降级为空对象执行。已覆盖必填、嵌套、格式、本地引用、不同 schema 版本、无类型强制转换、缓存隔离及六轮重复错误停止。模型用量保留缓存输入和推理 token，缺失报告显式标记不完整。

上下文准备不替换原始会话记录，模型视图单独持久化并绑定源摘要。新增核心规划器通过宿主固定版本的计数服务检查完整请求和输出预留，保留完整工具调用组、持久工具观察及尚未确认的 Hook 反馈。超窗历史按连续来源片段摘要，片段、原始消息引用、滚动摘要和覆盖游标均持久化；每段确认后才能推进，全部覆盖后才能启用压缩视图。私有供应商协议不作为历史事实引用，图片另行传给模型。宿主事实与不受信任的摘要文本分开保存。

31 项上下文核心测试覆盖摘要预算、重试、取消、超时迟到结果、SQLite 重开、真实进程丢失摘要响应后的不同恢复策略、Unicode 分段、图片、工具协议完整性和持久观察。摘要通过同一个模型端口和核心预算调度，无工具权限，不成为最终答案；已丢失的尝试仍消耗额度。新增或变化的成功源读取可以重置无进展压缩计数，相同观察不能重复重置。源读取工作集、微裁剪等策略和跨会话继承已封存摘要仍待补齐，因此尚不能认定完整上下文能力已迁移。

生产 Native Host 现从实际 Agent revision/Frozen Build 的 `context` 和所选模型绑定窗口、输出预留、压缩策略及计数服务。参考 Python 的 Studio 生产路径同样使用估算：CJK/ASCII 计数加 25% 裕量，图片另外预留。Node 计数器复用模型端口的实际 Chat、Responses、Anthropic 请求投影，计入工具 schema 和当前允许的供应商回放；计数器身份及模型参数摘要随配置固定。估算不写入供应商用量，不宣称等于供应商精确 tokenizer。

摘要预算显式区分 `strict` 和 `context_bounded_estimate`。Studio 使用后者：摘要可超过估算目标，但继续摘要前、封存后完整任务请求都必须连同原有输出预留装入窗口，失败时不推进覆盖游标。`output_limit` 摘要还须有 `provider-finished-text/v1`；Chat 缺少 DONE、Anthropic 缺少 message_stop 的文本只作为可重试传输结果。图片用户输入在媒体投影和压缩中保留，独立 Host 目标不再要求与图片消息空文本相等。尚未支持的 compaction 选项会明确拒绝组装。

本阶段只执行相关验证：276 项模型、上下文、输入、Host 和 Session 测试在 Node 26/22 均通过。真实 HTTP 联测使用生产计数器和 SQLite，验证中文摘要超过估算目标、完整分段覆盖、摘要封存后重开数据库、工具仅执行一次、供应商用量不受估算污染；该工具为测试端口，生产工具管线由实际打包 SDK 验证覆盖。SDK 普通路径在两个 Node 版本均通过，尚不代表完整 Host 挂载、所有入口或干净安装已经验收。

核心现已持久调度 `PreToolUse`、`PostToolUse` 和 `Stop`，将回执绑定到具体输入、回调版本与执行策略。修改后的工具参数重新经过 schema 和端口权限检查，审批重开不会重跑已提交的前置回调，模型历史保留原始工具参数。后置回调针对实际结果执行；Stop 反馈不能代替验收证据，继续执行受独立的持久计数限制。已执行但结果未提交的回调会中断并要求核对，不能因配置了 warn 就重跑未知副作用。

25 项 Hooks 核心测试包含回调执行前、实际副作用后、回执提交后的真实进程退出和 SQLite 接管。反馈保留到有意义的任务响应确认送达，模型端错误不会清除待交付反馈；上下文端口若遗漏它会被拒绝。`PreCompact` 现仅针对正式接纳的来源集合调度，回调完成后重新计算摘要请求，拒绝时不调用摘要模型。

Node `hook-executor.mjs` 根据固定范围、完整回调定义和执行策略绑定宿主回调，每次执行均须显式授权。单调时钟限定从可用性检查到结果校验的整个期限；取消、关闭和迟到授权不能授予后续执行权。JavaScript 无法强制终止不合作的 Promise，执行器继续持有它，限定清理等待时间，并将无有效结果的修改回调标记为结果未知。生产 Host 现通过 `nativeHookRegistrations` 组装精确 Agent 的可信 Node 回调，核对原运行的持久意图、身份、阶段和 fence；恢复时重新核对同一来源、配置及授权版本。接口及边界见 [Native Hooks 宿主接入](native-hooks.md)。本地记忆现复用该密封 Hook 边界：完整原始用户候选提取、按 principal 隔离的 SQLite 来源/观察/事实/回执事务及压缩前消费已实现，包含 shadow/off/explicit_only 和提交后结果未知的保护。召回、显式管理工具及审批/核对、记忆验收和轮次后消费仍待补齐；范围与当前验证见 [Native 本地记忆迁移状态](native-memory.md)。

目标变更可以在效果尚未领取执行权时撤销旧意图，留下明确的 `not_dispatched` 回执并按新要求准备执行；模型尝试数与 claim 在同一事务增加，准备后被撤销的请求不消耗调用额度。正式 Studio 指导使用 `guidancePolicy=boundary-guide/v1`：已准备的请求和工具批次先完成或核对，指导在封口边界进入当前目标，不撤销原请求。未启用该策略的底层旧指导接口仍保留原先撤销未派发意图的行为。对已经领取而失联的效果，先按恢复策略判断；未知写入继续中断，指导消息不会自动授权重跑。

维护的 DSH 源码新增 `agent/execute-turn` 整轮执行接口，已按源码提交导出为补丁 047；补丁 048 记录两种 SDK 的新会话首轮接管及后续默认循环委派。主线程独立验证了 TypeScript SDK 回放、六项接口/Loader 测试，以及 Python SDK 对真实 macOS arm64 单文件可执行产物的比较模式测试。该产物通过正常构建脚本生成，SHA-256 为 `9ab087d78a5eff5c64cf67cb0945563d7ae998507cc24502a2ee2c77c44141df`。维护源码的汇总类型检查通过；Studio 尚未默认切换执行引擎。

新增 `src/native/session-delivery.mjs` 将 Native 已提交消息和用量交给 DSH 会话。注册的 host projection 根据实际 Session 事件去重；先固定本轮输入，再写会话并等待持久化 flush，最后确认 Native 游标。即使写入成功后、确认前退出，重放也不会增加相同消息。供应商工具调用 ID 投影为本轮稳定 ID，避免跨轮复用冲突；私有协议回放和宿主凭据不进入展示事件。缺失持久化、超时、输入变化或轮次不符会停止推进。

`src/native/dsh-turn-runtime.mjs` 提供可复用的整轮执行适配器，契约为 `agentkit.native-dsh-turn/v1`。宿主解析器显式提供已接纳的 Native 消息、配置与端口；适配器按范围、会话和轮次固定运行身份，并绑定原始输入和模型来源。同轮重放复用持久运行，检查点等待会话持久化后再推进；审批等待和宿主回调可响应取消，迟到决定不会重新授权工具。取消先写入命令，交付失败时保留恢复依据。不同 DSH 轮次遇到尚未结束、中断或含未知副作用的 Native 运行会要求显式恢复；已完成的安全读取恢复允许进入下一轮，当前尚未实现跨轮接管与产品恢复界面。

核心配置现可接纳多条用户消息和图片，随配置摘要固定并在 SQLite 重开后完整传给模型。展示仍使用原始宿主消息及其附件和来源，避免把扁平化的 Native 输入重复写回；实际用户指导与正式工具附加上下文分别按来源投影，模型、验证和 Hook 的内部反馈保持私有。附件字节解析属于可信宿主的职责，整轮适配器不读取用户消息中的路径。

工具回执现在可分别提供模型文本、图片观察和不参与模型协议的宿主展示块；没有显式模型视图的端口沿用原 JSON 编码。Studio 以实际 DSH 后置策略处理后的结果构造这些视图，保留 Node 的工作区变更信息，不绕过策略直接展示原始工具输出。附加上下文与工具回执一起持久化，等整批工具结果齐全后才插入模型消息，SQLite 重开不会重复执行已经完成的工具。后续轮次保留原始 `user_input`、宿主 `dsh_context` 和工具上下文。Node 26/22 的真实打包 SDK 验证已核对后置策略文本、附加上下文、原始用户输入跨进程恢复及 Session 展示；运行中输入现通过后续独立接线进入 `prepareInput`，所有扩展内容块仍未全部覆盖。

运行中输入使用新的 Native `input` 意图与回执：在完整工具批次结束后，以及最终候选验收前，通过 Host `prepareInput(step)` 领取 next-step 消息，经过实际组装与 pre-step 策略后接入。文本、图片、文件引用与来源分别保留模型视图和 Session 展示，已有 Host 工具来源 ID 不再重复映射。人类指令默认作为必须保留的上下文，Host 普通观察按普通保留策略处理；输入不会修改目标契约或工具权限。若输入在最后一次模型请求期间到达，旧候选会被撤销，再调用模型处理新输入；策略拒绝返回 blocked。领取意图已准备但未派发时可以恢复；已领取但回执未知时明确 interrupted，取消后的未知领取也不能被新轮次绕过。已提交回执的消息只接纳一次。

输入定向验证包含 19 项核心行为与实际进程退出测试（prepared、claimed、领取后、回执后），以及生产 Host 的图片解析、来源映射、策略拒绝、绑定变化和关闭竞态。Native 核心与相关输入/整轮适配器曾联合运行 255 项，Node 26/22 均通过；之后针对新增保留策略和展示回退，又在两个版本各执行相关 93 项，包含 19 项输入核心测试和 12 项 Session 交付测试，全部通过。真实打包 SDK 在 Node 26/22 均验证了实际 Host 收件箱追加指令进入下一次模型请求、Session 与重启后的历史，仍是六次实际 HTTP 请求。`startsRequestSeries` 或模型/工具组装变化当前显式要求重绑，领取未知结果仍需产品恢复工作流；不能将这一阶段称为全部输入恢复能力已完成。

`node scripts/verify-native-dsh-turn.mjs --source <已构建的维护源码>` 通过真实 `dsh --profile sdk` 使用上述整轮适配器运行 Native 核心、SQLite、HTTP 模型端口和文件写工具。已验证两轮 Native 对话、轮间进程重启和会话恢复、四次 HTTP 模型请求、两次真实写入、工具配对、用量、持久会话与整轮重复执行，随后成功委派给默认 DSH 循环。Native 轮次中若调用默认模型执行器，验证会立即失败。该通用 SDK 验证证明了实际宿主执行边界与消息交付；生产 Host 资源组装与实时流事件的后续证据见下文，审批和运行中断后的产品恢复流程仍需继续接入。

真实 SDK 的普通与压缩模式已通过，压缩模式在 Node 26 和最低 Node 22 均完成 13 次 HTTP 请求（其中 9 次摘要），使用整轮重放确认没有额外请求或写入。无故障验证服务器现在显式关闭每个连接，以隔离空闲连接复用时序，并保持 HTTP 次数、模型步、用量和事件数的严格对应断言。早期 Node 22 运行曾多出一次未到达服务器的可重试错误，原日志保留；新增终态诊断会记录模型结果与回执失败类型，模型重试及缺失用量另有独立故障测试。

同一验证增加 `--context` 后，在 Node 26 和 22 均完成十三次真实 HTTP 请求，其中九次摘要请求，仍只有两次实际写入，并完成进程重启、两轮 Native 对话及后续默认 DSH 轮次。会话投影单独记录摘要用量，不公开内部摘要正文；重复交付不增加事件，DSH 汇总用量与 Native 一致。该验证使用明确固定的测试计数器，不作为生产 tokenizer 准确性的证明。

Python 参考能力清单见 [native-reference-capabilities.md](native-reference-capabilities.md)。20 个冻结行为场景已用只读参考 Python 重新生成并确认无差异；24 项 fixture 校验通过。新增 18 项 TS/Python 对照测试直接运行实际 Native 核心，核对普通闭环、并行读取、串行写、取消计数、未 claim 模型调用的暂停恢复、审批、未知副作用接管、重试预算、最终提交和账本行为。审查时发现取消丢失工具尝试计数，已修正核心；冻结期望未改动。接管场景使用确定性租约失效，真实进程退出另由核心故障测试覆盖。这些场景仍不能替代完整能力迁移验收。

上一阶段默认 `pnpm check` 通过构建、类型、语法、可移植性检查及 2050 项测试、1 项原有跳过、0 项失败；后续运行中输入接入按上述节奏只做定向验证，该全量结果不作为后续代码已全量重跑的证明。此前默认及有界并发曾停在原有 assistant-native-transport 测试，失败日志仍保留；现已确定其中双编辑器测试错误地按 WebCrypto 完成顺序分配上传闸门，反向摘要完成会让测试永远等待。保留旧分配逻辑的独立反向调度复现会超时；正式测试改为按请求绑定闸门并强制反向摘要完成，原幂等与恢复断言保持，16 项在 Node 26/22 均通过。最低支持的 Node 22.19.0 最新工具上下文联合回归 250 项全部通过，包含完整核心、输入、工具、会话交付、SQLite 恢复和整轮适配器。153 项模型端口、40 项 Hook 执行器及 74 项工作区测试也各有 Node 22 验证记录。

Node 工作区适配器已审查并合入，提供十种工作区工具、读取修订约束、原子发布、路径边界及持久审批绑定。74 项测试在 Node 26 和 22 均通过，其中实际 Native 核心、SQLite 和文件系统联测验证了审批重开恢复，以及发布后状态写入失败会中断并阻止重复执行。默认路径的 Python bridge 尚未移除；Native 开发入口已使用该端口执行对应工作区工具，全局读取预算、artifact 保存和诊断叠加也仍需补齐，不能将工具名称齐全视为行为全部齐全。

`lint_workspace_file` 现用固定的 `@astral-sh/ruff-wasm-nodejs@0.16.8` 检查 Python 源码，在独立 Node Worker 内运行 Rust/WASM，不启动 Python。版本化的 `agentkit.python-ast-syntax/v1` 固定 Python 3.12 语法，对应参考仓库 `pyproject.toml` 的最低版本；类型别名、类型参数及 3.12 f-string 可用，更新版本的语法会明确报错。这属于显式语言版本差异，不能宣称覆盖任意 Python 解释器版本。诊断文字和错误跨度来自 Ruff，与 CPython 不要求逐字一致。

检查只接收经过既有工作区边界检查捕获的文本，不读取工作区的 Ruff 配置，也不执行源码。它使用 Ruff 的严格语法解析边界，避免将重复参数、模块级 nonlocal 等仅在编译阶段失败的情形误当成 `ast.parse` 错误；另保留默认 4300 位十进制整数、200 层括号、99 层缩进和 NUL 限制。解析最多使用现有 2 MiB 文本预算，10 秒期限或取消会终止并等待 Worker 退出；失败显式返回错误，不能降级成“检查通过”。V8 内存限制不等于 WASM 线性内存限制。引擎身份进入启用该 builtin 的 Host 绑定摘要，同名 MCP 不取得它。

相关验证包括真实 Native 核心的“读取、检查错误、编辑、再检查”循环及 SQLite 重开；语法、权限、配置隔离、取消、超时及 Unicode 位置均在 Node 26/22 验证。`node scripts/verify-native-python-syntax-package.mjs <Studio tarball>` 在仓库外新建依赖树和空 npm 缓存，仅安装发布清单固定的解析器依赖，核对完整性并在 PATH 只有 Node 时执行实际打包文件；两个 Node 版本均通过。此证据仅覆盖该组件的全新安装，不替代完整 Studio、DSH Native 或 Codex 的安装与执行验收。解析器 API 为上游实验接口，精确依赖和守卫随包维护，来源见 [Ruff WASM 0.16.8](https://github.com/astral-sh/ruff/tree/0.16.8/crates/ruff_wasm)。

Node 模型端口现支持 OpenAI Chat Completions、Responses 和 Anthropic Messages，每次调用只发起一个 HTTP 请求，由核心独占重试和工具执行。153 项测试包含真实本地 HTTP、Kernel 与 SQLite 集成、私有回放与历史调用 ID 映射、严格 JSON、工具参数拒绝、响应大小和超时、终止帧后的及时收尾、用量缺失及缓存语义、整次请求的图片预算。Anthropic 输入用量包含缓存读取和创建；只有主要计数完整才认定为已上报。图片预算按编码后的内联 URL 总字节计数，保留当前用户全部图片，历史图片超额时以明确省略标记替换模型视图，原始会话和回执不变。

Responses 端口按输出序号组装文本、推理和工具参数，完整事件封存后才返回工具批次；拒绝完成帧同时携带错误、改写已收到参数的快照和不合法的历史参数。请求不允许绑定注入其他供应商会话、后台执行或自动裁剪，完整输入由 Native 管理。独立审查补充了六项回归，其中索引推理项省略可选 content 数组也能正常完成。与参考实现一致，Responses 推理可以封存为私有记录，但不重新投影为后续 Responses 输入；Anthropic 私有协议不能跨用到该接口。

模型协议仍有正式能力待补，包括 GLM 内联推理兼容、text-only 图片策略与更完整的 profile 兼容规则。这些端口测试不能证明所有源模型行为或 Studio 模型配置已贯通。

Artifacts 文件存储适配器已由真实 Claude Code 交付，经主线程独立审查和验证后合入。跨进程写入由 SQLite 活连接事务串行化，进程死亡由系统释放锁，不通过失效锁抢占判断所有权。完整写入身份先于内容发布，恢复时拒绝改写类型或元数据；字节配额在持锁期间核算。读取校验范围、引用、摘要和字节数，Unicode 分页保留 BOM 与完整字符，非法 JSON 和不完整 Unicode 内容显式拒绝。存储目录及锁目录必须由 Host 管理、位于不受工具直接修改的区域；Node SQLite 按路径打开，当前路径复核不能证明已打开文件描述符的身份，不能声称防住任意并发目录替换。

81 项适配器测试已在合入后的主仓库用 Node 26/22 重跑通过。另有两项实际 Native 核心、SQLite 和文件系统联测，覆盖工具回执提交后交付中断，以及文件已发布但工具结果未知：重开账本均不重复写入，只有已确认的引用进入运行状态。此处使用测试 Host 转发端口，不代表生产 overflow 调度、`ArtifactRead`/搜索工具、可用引用授权、页面预算、来源工作集或 Studio 下载消费已经接通。

Native 的实时文本、可见推理和工具参数预览现通过公开 `emitAgentEvent` 发布 `agent/assistant-stream`，使用递增 attempt revision、连续 chunk index 和实际 turn/step。预览工具 ID 不具备执行权限，完整模型回执提交后仍以 Native 的规范工具调用为准。Host 不再需要等待整次模型响应完成才看到内容；Session flush 与 Native 投影确认后，结束帧指向真实 `assistant/message` 或 `assistant/attempt` 的序号。标准 DSH 在同一步产生多次失败 attempt，也可以共存于宿主投影。

核心将公开片段封装为 `agentkit.model-display/v1`，与模型回执和对应事件一起提交；Session 重放用同一份片段和时间戳恢复，投影不依赖进程内缓存。默认只记录最多 1 MiB 的片段数组，超限保留前缀并记录 truncated，完整模型结果仍正常提交；`maxModelStreamBytes: 0` 可关闭展示记录。供应商签名和私有回放字段不进入展示；摘要调用不公开流式内容。当前结构化最终提交契约的模型流全部隐藏，以保护被拒绝的普通草稿，结构化任务的细分实时展示仍需后续完善。断流、超时及取消留下的未封存片段记为 attempt，不据此派发工具；结果提交前进程退出的实时片段仍可能丢失，恢复依照已有未知执行结果规则处理。

本阶段对流式输出、checkpoint、Session 交付、整轮适配器、Host 和三种模型协议执行了 Node 26/22 定向验证（原组合各 237 项通过，审查后新增两项分别在受影响模块复验，当前共 239 项相关用例）。SQLite 重开测试核对 flush 前、flush 后确认前的同一流式记录和工具不重复执行。实际打包 SDK 的完整挂载与普通 Host factory 场景均已在两个 Node 版本通过：六次 HTTP 模型请求都等待公开片段出现后才发送终止帧，工具预览期间没有执行工具，最终公开片段逐项匹配 Session 落盘记录，并保留跨进程会话、策略拒绝和独立默认 DSH 轮次的断言。测试脚本使用维护源码的既有依赖图，仍未证明干净安装、浏览器 UI 渲染或完整 SessionController 消费；本阶段没有运行全量测试。

浏览器的正式数据契约及核心资源恢复已加入 TS 核心。会话引用包含 scope、run、runtime、workspace、generation 和 lease；只有固定声明为浏览器角色的工具回执可以登记所有权。错误及未知结果仍保留已知会话引用，普通工具文本不能生成浏览器证据。观察成功只证明观察发生，不等于验收通过。契约使用 camelCase 与 `agentkit.*` 版本名，整数和布尔值按 TS 核心规则严格检查，摘要不要求兼容 Python 历史字节；图片 JSON 会复制并保留 `__proto__` 数据键，避免改变对象原型。

继续已有运行时，核心在下一项效果派发前调用只读 `BrowserRecoveryPort.recoverSessions`，校验每个完整引用并将资源状态落盘。探测受取消和超时约束，其耗时计入运行预算。页面失联会清除旧观察、候选结果、验证、预备上下文及压缩缓存；已领取的旧效果先按未知结果规则处理，资源丢失不能掩盖未知副作用。未派发的旧动作可明确作废，不能自动重新输入。仅在安全的模型边界且端口明确允许时，运行才要求重新观察；新的完整截图必须精确对应下一 generation 和 lease 才能消除该资源的观察欠账，模型直接提交最终结果不能绕过此要求。普通 guide/steer 不能恢复已判定不可用的页面。

此批先在 Node 26/22 各执行了 175 项浏览器契约、核心、账本、恢复、Session 交付及整轮适配器定向测试。补充预算和取消竞争检查后，对受影响的恢复与存储组合各复验 76 项，再对最终浏览器运行与进程恢复组合各复验 32 项，全部通过。四个新增进程场景在 PATH 无可用程序的子进程中执行，分别在观察回执提交、旧动作意图提交、领取、实际动作后退出；重开 SQLite 后均不重放旧输入，未知动作保持中断。本批未运行全量。这里仍是核心恢复与故障边界证据，实际 Node Playwright 后端、Studio 页面所有者、截图消费和生产浏览器工具绑定尚未集成。

Node 的 `browser-workspace-server.mjs` 为后续 Studio 页面所有者提供独立的本地文件服务。服务器只监听 `127.0.0.1`，每个页面使用随机 URL 前缀与独立端口，检查 Host、路径和实际文件身份，拒绝写方法、目录列表、越界符号链接与目录索引逃逸。入口所在目录的元数据修订用于判断是否重载；生成截图只在文件身份与元数据仍匹配时排除，不能据此证明应用正确。与 Python HTTP 服务相比，URL 增加页面令牌，单文件默认限制 32 MiB（可配置），连接数限制 16；目录列表被显式禁用。Host 仍须管理根目录，这不是抵御任意并发目录替换的文件系统沙箱。8 项实际 HTTP 测试在 Node 26/22 通过，包括资源类型、HEAD、跨页面 URL、路径/索引攻击、修订失效、限额及关闭释放。该服务尚未绑定生产浏览器工具。

`browser-workspace-protocol.mjs` 与 `browser-workspace.mjs` 已实现 Studio 页面所有者组件。公开参数保留 `path/actions/wait_ms/screenshot_path` 和既有 snake_case 动作字段；整批最多 20 个动作、显式等待合计最多 30 秒，在启动浏览器前全部校验。各 Run 有独立页面与文件服务，同 Run 的动作和恢复检查串行；文件修订变化会重新导航，生成截图不会被当成应用编辑。只有显式 reload 且不夹带旧输入时，失联页面才可新建 generation/lease。错误和未知动作保留资源引用；未知结果与取消会撤销该代页面的后续网络和截图权限，不被新截图洗成成功。端口返回显式模型图片上下文与类型化观察；默认工具超时 110 秒，可放入现有 120 秒 Native 效果上限。

可信 VerificationPort 可调用 `verifyPage`，每次使用新的隔离上下文，把截图写到工作区外的 Host 目录，保留观察期间的错误，并最多点击一个没有歧义的启动控件；重复启动 ID 会被拒绝。这里返回浏览器观察，不能证明完整用户目标或视觉质量通过。端口组件、真实 loopback 文件服务与 Memory/SQLite 核心恢复的早期组合在 Node 26/22 各通过 59 项检查，其中浏览器驱动使用故障注入替身。后续实际 Chromium 和 DSH 绑定验证见下文；UI 展示与独立验收的产品组装仍需完成。

Node `NativePlaywrightBrowser` 与 DOM 元素引用管理现已导入。真实 Claude Code 在独立 worktree 提交后，主负责人独立复现并修复了取消后迟到派发、派发后错误误标安全重试、可变引用污染、清理阻塞取消，以及通用浏览器图片未进入模型上下文等问题。动作先记录未知结果，重复 actionId 不会再次输入；取消或超时后资源立即撤销，清理可以继续，但旧引用不再接收输入。仅显式 restart 递增 generation 与 lease 后才能新建页面。排队动作超时不会撤销另一个仍健康的在执行动作。

浏览器后端、页面所有者、HTTP 服务及核心契约与恢复的 136 项定向检查在 Node 26/22 均通过；两版本另各通过 11 项真实 Chromium 检查，无跳过。真实检查覆盖输入、元素替换、网络约束、密码遮蔽、借用/自有浏览器清理、工作区资源重载、每次独立的冷验证，以及 Chromium 页面丢失后 SQLite 重开、拒绝旧候选结果、显式重新观察且不重复旧点击。生产依赖固定 `playwright-core@1.58.2`，驱动本身不安装浏览器二进制；无 Python 的安装与分发验证仍需补齐。这些证据不能代替 Studio 全路径验收。

核心已加入显式 `workspaceObservationPolicy`，由 Host 固定需要浏览器观察的文件后缀；未配置时不启用，不在 Kernel 内猜测网页类型。工具回执即使报错，只要记录了相关文件改动，就推进网页修改游标。观察间隔与模型验证预算共同决定后续可用工具：到期先观察，失败尝试可留出修复机会，但不会生成成功截图证据；最后的工具窗口禁止继续修改，只有新鲜观察且没有未解决交互错误时才开放读取。子任务用量计入剩余模型预算，目标允许的工具范围保持生效，结构化最终提交仍按原契约开放。

浏览器交互错误按工具和入口页面持久化。后续截图、宿主自动重载、移动、滚动或另一页面的操作不能清除它；只有同工具、同页面的显式交互成功才清除。真实 steer 清除旧目标的观察和交互错误，guide 保留它们。模型的临时观察指令参与与实际请求一致的 token 计数，工具或结束预算耗尽时不再提示浏览器可用。相关组合在 Node 26/22 各通过 153 项定向检查，最后增加预算优先级检查后，策略模块各通过 28 项；Memory/SQLite 场景验证了错误回执交付中断、数据库重开、修复窗口、拒绝夹带禁用工具及成功观察。交互错误现由下述独立验收器消费。

Host 现通过 `agentkit.studio-native-task-policy/v1` 固定 Studio 网页后缀、每 12 次工具调用的观察间隔，以及最多 6 次模型调用的验证保留预算；仅已绑定的正式浏览器 builtin 激活此策略，同名 MCP 不激活。Agent Revision/Frozen Build 的 `spec.execution.nativeLimits` 可显式设置 `maxModelCalls`（正整数或 null）和 `maxToolCalls`（非负整数或 null）；新 TS 配置省略时均不限制次数，0 次工具禁止工具执行。策略及预算进入 Host 绑定摘要和运行配置。Host/绑定的 21 项检查与核心策略的 28 项在 Node 26/22 通过。

核心浏览器证据新增可选 `entryPath`，只从正式工具的 canonical `entry_path` 回执固定；DSH 策略渲染出的模型或展示文本不能替代它。Node `writtenNativeWebEntry` 据已提交的工作区变更与此路径选择交付页面，拒绝越界、已删除页面、多页面歧义，以及没有明确引用的无关根页面。保留源实现对 HTML/HTM/JS/JSX/CSS 的交付入口识别；TS/TSX 仍参与观察策略，但单独的源码修改不会推断 HTML 入口。HTML 使用固定 `parse5@7.3.0`，最多读取 4 MiB UTF-8 前缀并解析首 1 Mi Unicode 字符；显式拒绝重复属性的引用绑定，避免源 HTMLParser 对重复属性取最后值、实际浏览器取首值的歧义。相关浏览器证据及入口选择 36 项检查在两版本通过。入口选择现由下述独立验收器使用。

Native builtin 图片输出现先通过 Host 的 `attachments.saveImages` 校验并持久化，再把附件引用交给 DSH 渲染与输出策略；模型图片只从策略处理后的引用经 `readImageRequest` 获取。远端 URL、文件路径、非规范 base64、超出部署图片预算的整批输入在存储前拒绝，取消后不发布迟到引用；纯文本工具不需要附件服务。`verify-native-dsh-output --source <built maintained DSH checkout>` 已在 Node 26/22 验证实际 DSH 附件的图片解码、持久化、服务重建后读取、策略省略和 Native 下一轮模型接收；29 项输入/输出/工具定向测试也在两版本通过。UI 实际渲染截图仍需验证。

`NativeDshTools` 现正式注册已绑定的 `browser_inspect_workspace` builtin，固定 Native 浏览器角色和参数；同名 MCP 工具不获此角色或恢复权限。所有输入先通过实际 DSH 注册器的 pre/guard/around/post/result 流程，模型无法自行绕过注册器调用后端。`native-dsh-browser.mjs` 按 ledger scope、会话及固定工作区延迟创建所有者；同会话更换 Agent 对象仍保留页面，不同会话或租户隔离。进程替换保留稳定所有者身份，恢复只探测，失联后必须显式 reload。preset 关闭会取消在途调用并释放页面、HTTP 服务和自有浏览器，即使注册器注销报错也继续释放资源。

浏览器现在随一次 Native 运行激活退出而释放，覆盖完成、失败、取消及暂停；不再等到 preset 关闭才清理。此边界对应只读参考 `native_product.py` 注册的 `persistent_browser.aclose`。Host 将可信 `releaseResources` 回调传给整轮执行器，执行器先结算状态，再等待清理结束后释放会话推进锁。清理错误保留原运行错误并显式抛出，不改写已持久化状态；同一所有者清理失败时拒绝隐式创建替代资源。会话和 scope 隔离，未用浏览器不分配实例。重新激活时旧引用仍按失联处理，只有恢复检查后的显式 reload 才建立新 generation/lease；不会自动重放先前点击。

该释放链的 4 个受影响模块在 Node 26/22 各通过 92 项测试；补充排空与取消前置检查后，只复验浏览器模块，各通过 12 项。上述实际 DSH + Chromium 联测同时证明 `releaseSession` 后原页面 HTTP 服务不可访问、旧输入被拒绝、显式 reload 递增 generation 与 lease；Node 22 联测使用 `PATH=/no-programs`。这些证据不替代全新无 Python 安装或完整 Studio UI 验收。

开发入口的 Host 配置可通过绝对路径 `AGENTKIT_STUDIO_NATIVE_CHROMIUM_EXECUTABLE` 指定 Chromium；省略时使用 Playwright 预期的已安装浏览器，模型参数不能指定可执行文件。`verify-native-dsh-browser --source <built maintained DSH checkout> --chromium <executable>` 在 Node 26/22 通过真实 DSH ToolRuntime、附件服务及生产浏览器绑定的联测，覆盖 pre 和单调 guard 拒绝、策略省略图片、下一轮模型图片，以及所有者重建后拒绝旧输入并仅由显式 reload 建立新代页面。相关绑定、输入输出及 Host 组合两版本各通过 55 项检查；补充注销失败场景后，最终绑定模块各通过 22 项。这是工具和核心边界联测，尚未覆盖完整 UI、自动化或 Frozen Build。

可信 `verifyBrowserPage` 已接入逐动作授权：冷页面的导航、截图及实际选中的 Start 点击分别经过同一 DSH 注册器，模型不能指定此私有分派方式。拒绝其中一个动作会关闭冷页面；正常会话页面保持独立。冷截图写在 Host 工作区外，并通过 DSH 附件服务处理，策略省略图片不会被直接模型上下文绕过。42 项相关端口和绑定检查在 Node 26/22 通过，实际 DSH+Chromium 联测也验证了允许加载而拒绝 Start 点击的 guard；Node 22 同一实际链在 `PATH=/no-programs` 通过。这一观察边界现已接入下述独立验收报告。

## 独立验收与交付证据

生产 Native Host 通过 `agentkit.studio-native-verification/v1` 编译当前目标的验收契约，将候选、上下文绑定、工作区版本、观察事实和逐项结果写入工作区外的持久 artifact 后才返回报告。最终报告仍由核心核对候选和契约版本，并在结束前重新观察工作区；验收后工作区变化会撤销旧候选。证据服务或浏览器权限不可用时明确阻塞，不能将环境失败作为要求模型改代码的依据。

`native-verification.mjs` 固定两个 Host verifier：通用交付检查可以拒绝格式错误、浏览器加载/脚本错误和未重新验证的交互错误；精确文件检查只对源实现支持的明确字面内容验证真实文件字节。冷浏览器通过正式 DSH 工具注册器执行导航、截图和唯一 Start 点击，其成功不能代替模型在最后一次网页修改后的正式观察。普通格式或浏览器 smoke 成功仍为 `not_run`，不独立证明任务语义；精确文件通过只授予该项证据，因此综合结果可以是 `partial`。可修复失败进入已有的持久修复预算；未知、缺证据或被拒绝的观察不授予通过。

输出格式助手移植源实现的显式数字、句子、JSON、Python 列表及精确文件指令，不从任意描述推断答案。Python 列表用离线 Node tokenizer/parser 校验，不执行用户内容或 Python；Unicode 命名转义数据固定为 CPython 3.11 基线的 Unicode 14.0.0，生成器验证官方输入 SHA-256，随包附来源与许可。十进制整数字面量上限固定为该基线默认的 4300 位；其他解释器 Unicode 版本或可配置整数上限属于明确的平台差异。不可哈希的 set/dict 键在 Node 中作为有界格式拒绝，源 Python 会抛出未捕获 TypeError。结构化 JSON 中超过 JavaScript 安全整数范围的数值仍有精度缺口，尚未完成无损验收。

本批仅对输出助手、verifier 和 Host 执行 Node 26/22 定向组合，各 123 项通过。包含真实子进程在 artifact 持久化后、外层 verify 回执提交前退出，SQLite 重开后保留证据但拒绝重跑未知验收或凭孤立证据授予通过。实际 DSH+Chromium 链验证生产工具写网页、模型观察、独立冷观察、证据重开和 Start guard 拒绝；Node 22 在 `PATH=/no-programs` 下通过。打包完整 Host 在两个 Node 版本验证跨进程会话与证据契约匹配。上述链使用维护 SDK 的既有依赖，尚非干净安装、完整 UI、所有产品入口或可选视觉语义验收的证明。周期 checkpoint 调度及验证见下一节。

## 工具执行期间的周期验收

核心现按源实现的三个边界为已变化的工作区创建 `purpose = "checkpoint"` 候选：进入验证预算窗口、最后一次工作区修改后经过指定工具调用间隔，或对尚未 checkpoint 的网页修改取得当前工具游标的浏览器观察。必须有可信工作区版本、已执行的工具调用和剩余模型额度；同一已观察版本不会重复触发。已知浏览器恢复和重复工具错误优先处理，不能形成“创建候选、拒绝候选、立即重建”的空转。Studio 仅在正式浏览器 builtin 激活时绑定 4 次工具调用的空闲间隔。

checkpoint 的效果意图、回执、工具游标及工作区版本进入账本。报告提交后，核心再次观察工作区，版本漂移就撤销旧观察；稳定时只把失败、阻塞和未执行检查的安全诊断交回模型，保留完整证据于账本。checkpoint 不要求最终答案格式、不调用 Stop、不授予完成，也不扣除最终候选的修复次数。通过、失败或阻塞都仍需继续执行并另外提交最终候选。进程丢失且验收结果未知时不会重跑该效果。

Node 26/22 的相关 139 项定向组合通过；补充漂移、损坏报告及恢复优先级后，只复验直接受影响的 checkpoint、浏览器恢复和任务策略 70 项，两个版本均通过。真实 DSH+Chromium 链验证正式工具写入、浏览器观察、下一次模型调用前的 checkpoint 反馈、独立最终验收及 Start guard 拒绝；Node 22 在 `PATH=/no-programs` 下通过。仍未由此证明所有 Studio 入口、可选视觉反馈或完整迁移完成。

最终验收的修复反馈同样只含安全诊断，完整报告和证据地址保留于账本。修复开始时重置单次响应的继续生成计数，保留累计模型、工具和修复预算。相同失败指纹且验收对象、环境和诊断均未变化时终止重复修复；仅更换 artifact 地址不算进展。失败指纹和进展摘要持久化，SQLite 重开后继续约束；更正目标会清除旧失败状态。只有完整匹配候选与验收契约的报告才更新验收工具游标，失配报告会清除旧游标。

这批只执行验收修复、契约、checkpoint 和 Host verifier 的定向用例，Node 26/22 各 75 项通过；最后收紧游标规则后，仅复验两个直接受影响模块，各 15 项通过。覆盖持久化后重开、重复证据地址、实际诊断或对象变化、安全反馈以及累计预算保留。

## 目标契约和运行中更正

整轮适配器支持可信 Host 的 `taskContractFactory`：编译前固定当前会话父 Run、父目标及父契约，编译结果通过会话头 CAS 接纳。编译期间另一执行者推进会话，或原请求已取消时，不会创建新 Run 或发送模型请求。重复交付按原父 Run 编译，已被后续 Run 替代的旧轮次不能重新发布到 Session。执行配置摘要固定 `agentkit.native-goal-contract/v1`，避免目标编译和命令语义变化被当成同一宿主绑定。

核心 `steer` 命令要求 `expectedGoalRevision`。过期或无效命令不改变目标、验收或尚未分派的效果；缺少版本时明确阻塞。可信 Host 可以附上新版本的 `taskContract`，更新验收项、最终提交 schema 和已绑定工具范围；省略契约时保留原验收。替换后的契约及摘要随状态持久化，数据库重开后继续生效，并参与候选验证绑定。暂停状态保持暂停，模型、工具、修复、输出重启及压缩的累计消耗不会重新授予；已运行而结果未知的副作用仍须恢复核对。

本阶段在 Node 26/22 各执行 178 项目标契约、上下文、浏览器策略、验证、整轮适配器与 Host 的定向测试；最终补充摘要完整性检查及宿主绑定版本后，仅复验直接受影响的 58 项，两个版本均通过。覆盖内存/SQLite、契约提交后重开、相同目标版本竞争、异步编译时会话头变化、取消和旧轮次重投。未执行全量回归，尚未据此验收所有 Studio 目标更正入口。

## 模型 JSON 的精确整数

`agentkit.native-json-integer/v1` 将超过 JavaScript 安全范围的 JSON 整数 token 表示为 `bigint`，普通整数继续使用 `number`。十进制小数及指数 token 保持原 Python 的浮点语义；大型浮点值在编码时保留指数形式，避免数据库重开时误变成另一个整数。整数转换采用 CPython 3.11 基线默认的 4300 位限制，重复键和非法 JSON 仍被拒绝。

核心的 `canonical`、`copy`、`parseNativeJson` 和 Node SQLite 账本保留整数原值。`stringifyModelJson` 通过 Node 22 支持的 `JSON.rawJSON` 编码真实的 bigint；普通对象中的伪造包装字段不获得数字权限。宿主应使用这些 codec，普通 `JSON.parse` 会舍入大整数，普通 `JSON.stringify` 无法编码 bigint。DSH 整轮绑定摘要包含该 codec 版本。模型 JSON 仍限制 256 层，账本解码允许 1024 层以容纳模型数据外面的状态与回执封装。

含精确整数时，schema 校验将结构投影交给原有 AJV，数字上下界、整除、枚举、常量和数组去重则读取原始树精确判断。局部引用、条件分支、旧 draft 的引用语义与结构约束继续生效。普通数据仍走既有校验器。三种协议的缓冲、流式输入和私有回放已接通该 codec，Anthropic 整块 `input` 的中间复制也保留原值；artifact 元数据的重开和搜索同样保留整数。

本批在 Node 26/22 各执行 328 项相关检查，没有执行全量。覆盖真实 HTTP 协议、schema、存储、流、DSH 桥及 Session 交付。新增真正的 Node 子进程在工具回执提交后退出，替换执行者重开 SQLite 后交付 `9007199254740993`，不重复已执行工具；子进程 PATH 中没有 Python。补充进程、封装深度和 schema 边界后，仅复验三个直接受影响模块，两个版本各 36 项通过。

DSH 维护补丁 `049` 提供显式协商的 `dsh.raw-json-number/v1` 工具参数编码。Native 在进入 SDK 时只把需要精确传递的数值转换为内建 `JSON.rawJSON`，普通数字保持原语；SDK 复制、冻结及权限管线保留真实数字 token，普通同名字段不能伪造该权限。内置工具核对解码后的参数后仍使用原 Native 请求，MCP 使用原数字发送 JSON。编码版本进入宿主绑定摘要。普通 SDK Session JSON 和类型化工具输出没有扩展；旧 SDK 对不支持的输入仍在分派前返回 `STUDIO_NATIVE_EXACT_NUMBER_UNSUPPORTED` 和 `executed:false`。

`verify-native-dsh-numeric` 在正式 SDK profile 中验证模型 HTTP → Native 整轮 → 实际 DSH guard → 实际 MCP HTTP → 回执 → 后续模型。大整数、浮点负零、大型整数形态浮点数及伪造包装字段均经过实际线格式检查；重复交付不再执行工具。Node 26 与 Node 22 均通过，其中 Node 22 的父进程和 SDK 子进程使用不含外部程序的 PATH。SDK 四个相关模块各 168 项定向测试通过，Studio 工具和宿主两个模块各 18 项通过；未执行全量测试，也不以这些证据代替全新无 Python 安装验收。

MCP 的结构化返回值仍经过现有客户端的普通 JSON 解码；发送参数和文本返回的证据不能证明结构化数字也已保真。该接收方向及特殊 schema 引用仍是待闭环项目，不能把本阶段视为整个工具链已无损。

## Studio MCP 完整结果接入

实际 Studio 产品路径使用 `local-resource-adapters.mjs` 的 MCP SDK 1.31.0，而上述 DSH MCP 插件联测使用维护源码中的客户端。原产品适配器只返回 `content`，会丢失 `structuredContent`。Native 现通过 Host 私有的 `mcp-result/v1` 返回模式取得完整协议结果；该版本进入宿主绑定摘要。普通 DSH 与 Codex 调用继续使用原有内容列表。完整结果模式在 HTTP、stdio 和旧 SSE 的相关测试中保留结构化对象及已知错误；非法返回模式在连接前拒绝。

Native 自己注册 revision 绑定的 MCP 工具，经过同一 DSH pre/guard/around/post/result 管线后才调用 Host 资源执行器；preset 不再为这些名字重复注册旧桥。完整结果作为 Native 原始回执，已知 `isError` 保持工具错误；传输中断没有回执时进入结果未知处理，不据此重跑。与 builtin 同名的 MCP 工具使用远端 schema，不能取得本地文件读取或浏览器观察权限。模型只看到后策略的投影：纯文本及唯一 FastMCP 字符串镜像可展开，其他结构化数据保留；`_meta` 不进模型，媒体不作为 base64 文本重复暴露，嵌入 URI 不会被抓取。支持的图片经过既有附件服务校验和发布，策略删去图片时 Native 不能从原始回执补回。

`verify-native-dsh-numeric --source <built maintained DSH checkout> --studio-mcp` 在真实 SDK profile 中组装 Studio preset 插件、运行桥、生产资源适配器、Native SQLite 回执与整轮执行器，验证完整结果到后续模型及重复投递不重复执行。Node 26/22 均通过，Node 22 使用 `PATH=/no-programs`；原 DSH MCP 插件模式也通过相关回归。最初的结构化回包只含安全数字，后续精确 JSON 验证已增加大整数、负零、浮点数及精确输出 Schema 边界；这些结果不能替代完整 UI、全部 MCP 语义或全新无 Python 安装验收。

生产 MCP SDK 1.31.0 现通过根 `pnpm-workspace.yaml` 的补丁引入显式 `mcp.json-parser/v1`，覆盖 stdio、旧 SSE、Streamable HTTP 的 JSON/SSE 入站消息；协议验证、认证、取消和重连仍由原客户端处理。Native 的完整结果模式选择 `agentkit.native-json-integer/v1`，并使用正式 `jsonSchemaValidator` 接口精确校验输出。它与普通调用分别缓存连接，避免混用解析器；凭证轮换仍在每次操作时重新检查。重复对象键、非有限数字及超出 Native 编码限额的消息显式拒绝。该解析契约进入宿主绑定摘要。

源码安装使用 `pnpm install --frozen-lockfile` 应用补丁。`build:mcp` 及既有 prepack/pretest/precheck 会把修补后的客户端和完整依赖许可构建为 `dist/native-mcp-client.*`，随 Studio 发布；桌面 npm 安装使用这个产物，不依赖消费者传播 pnpm 补丁。构建时缺少补丁会报错，不能静默退回有损解析。真实四种传输测试验证数值 token、分片、Schema、普通/Native 连接隔离和现有 stdio/SSE 凭证行为。

Native 产品预设现使用 `listMcpTools(binding, {jsonCodec: 'agentkit.native-json-integer/v1', snapshot: true})` 取得精确 Schema。目录查询使用独立连接，完成后关闭，既不关闭正在调用的连接，也不把远端可变的输出校验缓存带入固定版本执行。输入/输出 Schema 以带版本的 `agentkit.native-mcp-schema/v1` JSON 文本存入工具绑定，经过普通预设序列化后由 Native 解码。Native 使用完整输入 Schema 构造模型请求并在分发前校验参数；固定的输出校验器直接消费已返回的结果，错误回包保留原始回执并记为工具错误，不被误当成未确认的传输结果。

DSH 继续负责权限和执行。对于它无法以普通 JSON 快照表达的数值约束，注册表参数携带完整 Schema 文本注解；Native 模型和校验器使用解码后的原始 Schema。该载体变化会显式拒绝，不支持 Native 引擎的配置也不能退回默认循环。工具绑定在创建时复制，资源 ID 与输入/输出 Schema 的摘要进入宿主绑定摘要，后续修改原配置不能替换已准入的绑定。DSH 自带另一套外部 MCP 插件仍使用普通数字解析，不属于这条固定版本 Schema 路径，不能据此宣称所有 MCP 插件都已完成数字精度迁移。

本阶段定向运行 `native-mcp-json`、`local-resource-adapters`、`mcp-transports`、`native-dsh-tools`、`studio-native-harness` 五个测试模块，Node 26/22 各 68 项通过；追加连接/凭证断言后只复验对应两个模块，各 8 项通过。两个版本的真实 `verify-native-dsh-numeric --studio-mcp` 也通过。`pnpm pack` 和 `check-package.mjs` 检查了实际发布包；`node scripts/verify-native-mcp-package.mjs <Studio tarball>` 在仓库外解包运行，两个 Node 版本均确认没有安装依赖且 `PATH=/no-programs` 时保留精确 HTTP 回包。此隔离证据仅针对发布包里的 MCP 客户端模块，完整 Studio 全新安装验收仍未完成。

固定版本 Schema 的后续验证包含七个相关模块，Node 26/22 各 104 项通过；追加绑定复制与摘要后只复验工具和 Host 两个模块，各 43 项通过。真实 SDK profile 已检查模型请求中的大整数上下界、精确工具参数和输出。`verify-studio-native-harness --mount-host --mcp-schema` 进一步使用实际打包文件挂载完整 Studio Host，经认证 HTTP 控制接口准入 MCP 预设；它验证两轮真实 MCP 文件发布、进程重启和 SQLite 回执恢复、一轮权限拒绝、六次模型请求及其公开流、输入收件箱、后置策略和独立默认 DSH 轮次。固定 Schema 的传递与回执检查覆盖实际产品组装，完整 UI、审批恢复、所有自动化入口及全新无 Python 安装仍需验收。

## 后台命令的账本与观察端口

核心现在实现 `completed-before-model/v1`，并以 `agentkit.background-command-observation/v1` 明确观察端口契约。只有绑定 `owned-command-launch/v1` 的串行工具回执能够登记 `{taskId, sourceRunId, operationKey}`；任务 ID 必须是 64 位小写十六进制，来源运行和操作键必须匹配当前已调度的启动操作。工具内容、模型文本或同名普通工具不能授予该能力。未显式配置策略的运行不增加观察行为；旧的泛用后台端口仅是未实现的类型占位，现替换为只有 `observe` 的正式接口。

观察只发生在受控上下文边界、模型请求尚未 claim 的边界。通知消息、`notified` 去重标记、活动墙钟用量以及旧模型意图的 `not_dispatched` 回执在同一事务中提交；存储层重建并核对整笔观察事务，不能把已认领的操作伪称为未执行。取消、权限撤回和租约接管优先，迟到的报告不能再写账本。进程在启动 claim、实际启动、启动回执提交、观察读取或通知提交后退出的测试均检查恢复时不重放启动、不重复通知。只读观察本身允许重新读取，未回报的副作用仍按未知结果处理。

Node 的 `createBackgroundCommandPort` 核对当前运行、Session、未通知句柄、源运行及其已提交的成功启动回执；还要求回执属于正式启动工具的单项工具意图。后端只从规范回执的 `content.backend` 选择 `sandbox/local_process` 或 `sandbox/e2b`，无封存后端或未绑定读取器就返回 `unavailable`，不读取当前环境作为回退。读取从零字节游标开始，单次窗口 8192 字节、等待为零，最多返回八项终态观察；进程输出只作为带警告的数据进入上下文，不进入公开观察事件正文。输出游标、截断、证据缺口和已观察到的退出码完整保留。与参考代码一致，仍在运行不产生完成通知，`unknown` / `unavailable` 停止普通推理；已知完成伴随证据缺口时保留信息供模型继续读取，不把缺口改写为完整证据。

该子契约使用 TS 的 `canceled`，Node 后端适配器必须将 Python 风格的 `cancelled` 映射后再返回；字节游标和退出码要求安全整数，超界显式拒绝。每个输出字段至多 8192 个 Unicode 码点。没有 Python 历史数据兼容要求，原占位后台状态也没有生产写入路径。

核心、真实子进程退出、Node 观察端口、存储、恢复、请求作废、上下文和浏览器相关九个模块曾在 Node 26 / 22.19.0 各通过 206 项；随后为保留上述证据缺口语义，只复验三项直接相关模块，在两个版本各通过 76 项。该阶段没有运行全量回归。这里完成的是登记、观察与事务语义；实际本地/E2B 命令启动器、资源上限、supervisor、输出读取/停止工具、Host 唤醒与 Studio 产品入口仍未接通。不能据此声明命令能力或整个迁移已完成，也没有启用 Native 默认路径。

## 本地命令的受限进程适配器

`local-process.mjs` 现提供真正的 Node 进程执行、逐通道字节输出上限、增量 UTF-8 观察、墙钟超时、取消及进程组清理。正常主进程退出时也清理仍持有输出管道的后代；观察回调异常不能改变命令结果。清理及输出排空具有独立时限，失败会返回 `cleanupError`，不把不完整清理伪称为成功。

Node 没有直接设置 POSIX 资源上限的接口，因此随包分发小型 C exec/watchdog 适配器，核心状态机和调度仍由 TS/Node 实现。安装、启动和执行时不编译，不依赖 Python。执行前按继承的硬上限收紧 CPU、地址空间、进程数、文件描述符数和文件字节上限，回读验证后才执行命令。与参考版本一致，Darwin 显式报告地址空间及进程数上限不支持；Linux 要求五项全部生效。不能创建私有 watchdog 就拒绝执行。调用者被 SIGKILL 时，独立 watchdog 通过私有管道关闭检测终止所属进程组；命令不能继承该私有管道或控制报告通道。

支持 Darwin ARM64/x64 和 Linux ARM64/x64，Windows 显式拒绝，当前没有对应的本地 POSIX 后台能力。Linux 使用静态 musl 可执行文件，随包保留 musl/GCC runtime 许可。维护者构建脚本记录编译器、Linux 基础镜像摘要及源代码/产物 SHA-256；发布前检查四种产物的架构、静态链接、许可和摘要，运行前再次验证选中产物。校验用于发现损坏或不匹配，不构成对可修改整个安装目录的攻击者的签名信任。维护者构建需要 Apple SDK 或 Docker/C 编译器，消费者不需要。

定向测试覆盖精确到 1001 字节的文件上限、继承硬上限、CPU 与墙钟超时、各通道输出截断、UTF-8、取消、主进程退出后的后代、调用者硬退出及产物篡改。Linux 非 root 还检查无法创建 watchdog 时不执行目标命令。`verify-native-local-process-package.mjs <Studio.tgz>` 从实际发布包在仓库外抽取模块和可执行文件，用空 PATH 执行；它只证明这一组件可独立运行。Intel Mac 在当前 ARM Mac 上没有原生运行证据，架构与摘要检查不代替该平台的执行验收。

该模块在 Darwin ARM64 的 Node 26 / 22.19.0 各通过 14 项，在 Linux ARM64 和 Linux x64 的 Node 22.23.2 各通过 15 项；x64 使用 Docker 的 Rosetta 仿真。Linux 测试均为非 root、断网和空 PATH。测试夹具修正后，Mac 仅复验直接受影响的三个用例，两版本均通过。实际包通过 `check-package.mjs`；包内组件在上述四个 Node/平台组合中冷执行成功，Linux 还使用只读根文件系统和可执行临时目录。没有运行全库测试，也没有据此宣称完整 Studio 安装或所有运行入口已经通过。

这一层只接受宿主已经授权的 argv/env，不是安全沙箱。命令风险扫描组件及持久后台 supervisor 的 Node 实现见下节；工作区约束、输出读取/停止工具及 Studio 产品绑定仍待实现。上层必须把控制报告失败或清理失败纳入未知结果核对，不能因此重放已产生的副作用。

## 本地后台命令的持久生命周期

Node 的 `LocalCommandStore` / `LocalBackgroundCommand` 使用 `agentkit.local-background-command/v1`，按规范工作区路径、后端及 Session 隔离所属目录。状态根必须位于可编辑工作区之外，并拒绝符号链接、非所属用户、非私有目录/文件和文件硬链接。读取与写入使用 no-follow 文件描述符；SQLite 本身没有 no-follow 选项，额外检查私有父目录、文件及 inode。这是宿主所有权约束，不是针对同一 uid 恶意进程的 OS 隔离保证。

每个操作键产生稳定的 64 位十六进制命令 ID；请求摘要包含命令、cwd、环境、超时和控制设置。Session 的启动互斥及每条命令的 supervisor 所有权使用独立 SQLite 数据库的写事务，进程死亡由内核释放锁。持有 supervisor 锁不阻塞输出和记录读取。正式记录及输出文件先在私有临时目录准备、fsync，再整体发布并同步父目录；只有发布完成后才能启动 supervisor。准备期间退出不会留下半成品正式句柄，正式意图发布后的退出则保留稳定句柄。既有操作永不重新启动；同键改变参数显式拒绝。读取既有句柄不要求当前安装仍有可用的命令执行器。

supervisor 是独立、分离的 Node 进程，使用固定的最小宿主环境。命令及其环境只经私有 stdin 传入，不进入 argv 或记录正文；请求摘要不包含明文凭证。它在执行命令前保存 running 状态，持有资源受限进程组的私有 owner pipe。一次性工具进程或 Studio 宿主退出后，命令继续运行；supervisor 自身硬退出会触发前节 watchdog 清理命令组。取消通过所属记录的持久标记完成，不向模型提供按 PID 取消能力。公开 PID 仅是兼容诊断定位值。

supervisor 将完整的有界 stdout/stderr 分别 fsync 并原子发布后，才提交 completed/failed/canceled/timed_out/output_limit 等终态。超时使用 124、输出超限使用 122；控制准入失败、输出持久化失败或清理失败进入 unknown，并在可用时保留观察到的退出码。所有权锁丢失且没有终态时，只读观察派生 unknown，不重写已有记录，也不重新启动命令。启动窗口为五秒，过期 supervisor 在执行前拒绝启动；这避免迟到进程在调用方已经观察到未知后才执行。未知结果需要核对，不能承诺外部副作用 exactly-once。

输出游标是 UTF-8 字节偏移，窗口保持完整字符并拒绝落在字符中间的游标，保留 BOM。完整等待返回全部保留输出及对应的完整字节游标；只读等待取消或超时不取消后台命令。`createLocalBackgroundReader` 可绑定前述核心观察端口，只接受同 Session、同操作键派生的句柄，等待为零，不启动或取消进程。

首轮 18 项定向用例在 Darwin ARM64 的 Node 26/22.19.0 和 Linux ARM64/x64 的 Node 22.23.2 均通过；Linux 为非 root、断网、只读根文件系统和空 PATH，x64 使用 Rosetta 仿真。真实外部进程测试覆盖宿主与 supervisor 的 SIGKILL、准备发布前、正式意图后但启动前、最终输出后和终态提交前后退出，均检查不重复命令。另使用真实命令、SQLite 重开及 Native 核心循环验证完成通知只消费一次，未知结果停止普通模型调用。补充场景按直接相关用例复验完整输出游标、启动失败、既有句柄在执行器缺失时的读取，以及 Linux 控制准入失败的未知结果语义。`verify-native-local-process-package.mjs <Studio.tgz>` 现同时验证实际包内前台执行、后台 supervisor、重开及幂等读取，不安装依赖。

该层仍是宿主已授权命令的后端组件。审批、工作区和风险策略绑定、run/read/stop 工具、E2B 后台实现、宿主唤醒及 Studio 各入口尚未接通，不能据此宣称后台产品能力或整个迁移已完成。

## 不依赖解释器的命令风险检查

`checkLocalCommand` 使用 `agentkit.local-command-policy/v1`，对应固定参考提交 `355059d` 的 `ksadk/sandbox/local_controls.py` 中 `check_command`。保留的是该检查器的有限风险规则：拒绝 kill/killall/nohup/pkill/setsid、后台 `&` 和递归强制删除；递归检查 shell/Python 的 `-c`；仅扫描直接执行且位于允许根内的 `.py/.sh/.bash` 入口，不扫描未使用的辅助文件或普通参数。引号内的数据和受支持的重定向保持为数据。

Python 分析使用已固定版本的 Ruff Rust/WASM 解析器。工作线程解析语法并解码该版本的结构化 Rust Debug AST，收集 import/from 别名，再检查真实 Call 节点；没有启动 Python，也没有把正则字符串匹配当作 Python AST。覆盖 os.kill/killpg/setsid、os.system/popen 中的字面量 shell、subprocess 字面量列表/元组与 shell=True、Popen 的 start_new_session=True，以及 shutil.rmtree 的静态工作区外路径。与源代码一样，动态表达式、非字面量标志和语法错误不被推断为这些静态规则；该检查器不构成 OS 安全沙箱，也不扩大已有规则的保证。

工作线程具有十秒上限、源输入二 MiB 上限、V8 内存限制及递归上限；取消等待线程终止。WASM 线性内存不受 V8 堆限制，这是资源防护而非隔离保证。固定解析器版本或 AST 编码不匹配、资源超限和解析器异常均明确失败，调用方必须拒绝执行，不能降级放行。目录和缺失路径解析检查现有及悬空符号链接的目标；具名其他用户主目录 `~user` 明确拒绝，不通过外部系统命令查找它。

Python 语法目标与前述文件语法检查一样固定为 3.12。AST 中间结构和错误文案可与 CPython 不同；多处违规的首项报告顺序可能随 AST 结构不同，但不得因此漏检规则。行为用例从固定源和其 phase-one 测试逐项提取，没有运行参考 Python。组件验收覆盖每条正式风险规则、允许的数据、直接脚本、真实路径、取消和超时；实际包的冷安装验证同时执行语法检查与命令 AST 检查，仅 Node 在 PATH，安装脚本关闭。

上述策略本身是独立组件；低层 `LocalCommandStore` 只接受宿主已授权请求。正式本地命令工具按下一节将策略接入产品；其余 Python builtin bridge 的替换仍须逐项验收。

## 正式本地命令工具与 Studio 组装

`agentkit.local-command-tools/v1` 提供 `sandbox_status`、`run_command`、`read_command_output` 和 `stop_command`。Native 持久化并领取工具意图后，生产 `createNativeDshTools` 通过真实 DSH 工具权限管线调用 Node 实现；模型提交的 `approval` 字段不能授权执行。`run_command` 和停止操作串行调度；读取显式绑定 `safe-read/v1`，可安全重复。工作目录固定在所属工作区内，目录组件不允许符号链接，执行环境仅含宿主许可变量。该后端共享宿主文件系统和网络，工作目录边界与静态命令检查不构成 OS 隔离。

正式命令先执行 `agentkit.governed-command-policy/v1`，对应固定参考 `ksadk/tools/gateway.py` 的默认命令策略，然后执行本地进程风险策略。保留源中两层检查的区别：上层默认策略会拒绝递归删除、sudo/kubectl/docker、特定 git 写操作及元数据地址，并保留其 shlex 分词和只读 git 提前返回语义。审批通过也不会隐式绕过它。

前台命令返回实际退出码；普通非零退出仍是一次已知执行结果，超时和输出上限分别报告 124、122，监督或清理证据缺失则返回 `uncertain`。执行之后的异常和 DSH 后置管线失败都不能变成“未执行”，不能自动重跑。实际工作区捕获产生修改路径。较大结果以完整 JSON 写入持久 Artifact，模型只收到有界 UTF-8 预览及类型化引用；分页读取能恢复完整内容。超出安全整数范围的模型超时值在转换前按宿主上限钳制；字节游标显式限制为安全整数。

后台启动使用 Native 操作键幂等登记，回执保存原始 Run 与操作键。读/停必须先从当前已领取的工具操作、当前 Session 的继承句柄和原始已提交启动回执共同核实所属关系；仅有 task_id、模型声明或环境变量不能选择后端或授权访问。生产 Host 绑定 `completed-before-model/v1`，在上下文和模型调度边界调用正式只读观察端口。失去 supervisor 后的未知结果停止继续推理，不重新启动命令。读取等待独立于后台进程超时，停止返回取消请求，后续读取才确认终态。

命令契约、进程上限、风险策略版本、实际许可环境摘要进入 Host 配置摘要；工具超时也纳入 Native 效果超时。生产权限仅给绑定的 builtin，同名 MCP 工具保留 MCP 路径。宿主重启后沿用 SQLite 账本和原启动回执读取命令。

定向验证包含真实进程、SQLite 重开、继承句柄、伪造访问拒绝、停止与进程组回收、真实 supervisor 丢失、Artifact 全文分页、超时/输出上限及后置策略失败。Node 26 的新增命令与策略模块 21 项通过；既有受影响模块分别 119、26 项通过。最低 Node 22.19.0 的这些受影响模块合计 166 项通过，没有运行仓库全量。`node scripts/verify-studio-native-harness.mjs --source <维护源码> --mount-host --commands --archive <实际 Studio.tgz>` 在两版 Node 上均通过真实 Host 权限管线的命令写入、两轮跨进程重启、第三轮拒绝、六次流式模型调用及独立默认 DSH 轮次。仅 Node 位于 Host PATH；命令依然可以执行显式授权的系统程序。这是正式本地命令路径的验证，不能替代全新安装或所有入口验收。

发布配置显式登记四个平台启动器为可执行文件，包完整性检查从真实 tarball 解压并检查权限，不能用 checkout 权限代替发布证据。一次真实 Host 验证发现 pack 规范化丢失权限，修正后重新打包并通过 Host 验证及包内前台/后台冷执行；没有在测试中补 chmod。

剩余命令能力包括 E2B/其他正式后端的产品选择和恢复、源 sandbox registry/TTL 状态字段、前台输出增量展示，以及后台持续写入与验收/工作集的完整联动。这批实现不等于所有 sandbox 能力或全部 builtin bridge 迁移完成。E2B Node 命令端口的进展见文末对应节。

## Frozen Build 的引擎固定

新的 Harness 构建使用 `agentkit.agent-bundle/v2`，使旧版宿主明确拒绝不认识的格式，避免忽略引擎字段后使用错误引擎执行。归档下载、运行包导出和导入保留同一引擎绑定；历史 v1 构建只接受未固定引擎的旧格式。

Harness Build 在内容寻址的 manifest 中固定 `agentkit.build-engine/v1`，明确使用旧 Harness 或 Native 引擎。Native 同时固定整轮接口、核心引擎、运行 schema 与精确 JSON 编码契约。该字段由宿主 Build 服务生成，不从可编辑的 Agent spec 获取授权；构建操作的幂等指纹也包含它。因此相同 Agent Revision 切换引擎会产生不同 Build ID 和构建操作，不能错误复用先前缓存的结果。

归档读取、preset 接纳和 Native Host 都检查该绑定。关闭普通 Revision 的 Native 开关后，已经冻结的 Native Build 仍可运行；反向开启开关也不会把旧 Harness Build 改成 Native。早于此字段的 Build 保留旧 Harness。未知或被改变的引擎、整轮协议、运行 schema 和 JSON 编码明确拒绝执行。Node 工具工厂始终注册为可用能力，仅由显式接纳的 Native preset 调用，不改变普通 Revision 的默认引擎。

`node scripts/verify-studio-native-harness.mjs --source <维护源码> --mount-host --commands --frozen --archive <实际 Studio.tgz>` 在 Node 26 和 22 均通过。验证实际构建归档、修改当前草稿至下一 Revision、关闭 Host 的 Native 默认开关，再经真实 HTTP 接纳 Frozen preset。两轮真实命令执行跨 Host 进程重启、第三轮权限拒绝、流式与持久化核对以及独立默认 DSH 轮次均通过；每次模型请求都包含冻结指令并排除后来草稿指令，所有 Native Run 均绑定原 Build ID。相关 Build、操作幂等、preset、Native Host 与既有 Frozen runtime 模块定向通过。此证据覆盖该冻结引擎及对话路径，自动化、部署 HTTP 运行和完整安装仍需单独验收。

## 自动化入口与会话权限

`agentkit.native-host-interaction/v1` 将 Native 已持久暂停的工具审批接入 Host ApprovalService。普通调用复用会话中已展示的 callId；子任务审批通过父账本的预算预约、完整因果身份、冻结配置与工具摘要核实，再使用父桥接的不透明 ID。只接受 `allowed-once`，其他答复形成持久拒绝；服务缺失保留等待状态。取消和审批期间状态变化使迟到答复失效。相关测试覆盖真实 Native 父/子 Kernel、内存及 SQLite，以及生产 Host 工厂的允许、拒绝、缺服务和取消。它尚不等于子任务角色、工作区、媒体与全部 Studio 入口的组装验收。

Native 从已接纳的公开 prompt assembly 读取 SessionController 选择的模型，再对照 Agent 或 Frozen Build 的模型绑定核验；创建时的 Agent options 只作为未提供选择时的默认值。中途改变模型仍要求显式重绑，不能在同一冻结的 Run 内静默换模型。

Node builtin 直接操作文件或进程，不能仅凭进入 ToolRegistry 推断已获得 DSH 文件权限。当前正式 builtin 在自身实际派发前读取 Host sandbox policy；只读工具可执行，有潜在修改的工具在 read-only 模式下必须通过真实 ApprovalService 的 allowed-once。拒绝、服务缺失、非法答复、取消和审批后服务丢失或策略失效都不派发。该契约 agentkit.native-tool-permission/v1 纳入 Host binding digest；它只授予本次工具调用，不改变会话模式，也不跨调用缓存授权。

`node scripts/verify-studio-native-harness.mjs --source <维护源码> --mount-host --commands --automation --archive <实际 Studio.tgz>` 使用真实认证 HTTP 创建 Build 操作、修改当前 Revision、执行计划任务并运行固定 Build 评测。计划使用新指令，评测保持冻结指令；两者的无人值守 read-only/never 策略使真实命令被拒绝，持久 Native 回执明确 executed=false，工作区无被拒绝文件，DSH 有对应的审批询问/拒绝审计。既有 SDK 对话、重启、公开流式和独立默认 DSH 轮次同时保留。此验证使用固定本地 Host 依赖图，不是全新安装或部署 HTTP 验收。

权限判断目前依正式工具的 readOnly 声明保守执行：run_command 即使只有读取命令也被视为可能修改，browser 工具也未按每个动作拆分；它们在只读模式下仍需单次审批。尚需补齐命令隔离后端与更细能力策略，以及交互审批恢复、审批期间进程崩溃等产品语义，不能据此声称审批整体迁移完成。

尚需完成源正式能力清单的逐项对照、上下文剩余策略、子任务及后台生命周期、其余模型和端口能力、Studio 各入口及剩余事件消费、自动化和 Frozen Build 的剩余运行入口、无 Python 安装执行及其他 runtime 回归。

## 子任务预算预约与结果结算

核心的 `child-budget.mts` 对照参考版本 `355059d` 的 `native/child_budget.py` 实现父账本预约和结算。预约与 `ChildState` 展示状态分开保存，绑定父 operation/call、child scope/run、请求和配置摘要；相同 tenant/workspace/user 下允许不同 agent。工具获得的预算由核心生成，已扣除本次工具调用、现有预约和父任务最终回复预留。`null` 表示无限额度，有限额度的零值始终表示耗尽。`start/v1` 额外保留一次显式收集工具调用，`delegate/v1` 沿用宿主收集的额度语义。

预约随工具回执和父状态一起提交；已预约额度参与模型、工具、浏览器验证和周期验收的调度，并保留在压缩后的 Host continuity 中。存储层禁止删除、重排或改写预约；已结算摘要不能再次改变。只有绑定正确的 `settle/v1` 回执可以释放额度，实际 token、调用和费用计入后代用量；同一结算再次返回不增加后代用量，收集操作本身仍计工具调用。超额或身份冲突的回执转入结果未知的中断流程，禁止自动重新启动。

本节账本验证覆盖内存与 SQLite、数据库重开和执行者替换、预约不可删除、调度额度、重复结果与违规适配器；这组测试中的子任务回执由确定性端口提供。真实子 Kernel、审批与取消接入见下节，Studio 角色与工具组装见最后一节。

## 已拥有子任务的执行与收集

`child-contract.mts` 将占位接口替换为带身份的 `collect`、readiness、只读恢复核对及资源释放端口。开启 `childLifecyclePolicy=owned-background/v2` 后，核心在安全边界轮询已预约子任务，最终答复前等待其结果，取消或退出前调度清理。结果与用量在同一父事务中提交；子任务发现只能成为带来源的观察，不能代替父验收。结果到达时会退回父任务提前生成的候选答复，再由父模型消费观察。准备好但未派发的父模型请求可被子任务 readiness 原子替换，不消耗一次模型调用。

Node 的 `createNativeChildOwner` 运行真实子 Kernel，每个子任务有独立 Run 和 Session。宿主显式提供角色对应的配置、端口及允许的 child scopes；恢复不回退环境模型。子配置的 `childOwnerBinding` 单独保存因果归属，Session 的 `parentRunId` 仍表示会话历史。子任务额度同时受父预约、请求上限和角色配置约束，不能抬高角色原有上限。副作用前检查父任务已提交的预约，或原启动 intent 的租约代次；迟到的宿主绑定不能让过期执行者启动新子任务。

后台子任务暂停审批时，父状态保存 scope、父 operation/call、原 child interaction、工具和定义摘要；只有匹配的父审批才能转交。暂停父任务只关闭已加入的观察者，保留原子任务及预约；恢复收集同一结果。父取消会显式停止已拥有子任务。工具结果未知时保持预约并报告恢复需求，不把未知写入当成可重试失败；DSH 也禁止用新一轮绕过尚未结算的子任务。已封存的启动/收集结果可在进程重启后只读核对，不重启子任务；没有足够证据的窗口仍进入显式恢复流程。

子任务专项通过实际 Kernel、内存/SQLite、真实文件写入及独立 Node 进程退出验证；模型响应为确定性数据。Native 账本生成独立 descendant usage delta 事件，尚不等同于 Studio 用量界面已消费这些事件。默认入口保持未切换，不能将本节视为子任务或全迁移已无损完成。

## Studio 角色绑定与正式子任务工具

启用 Native 引擎的不可变 Revision 声明 `subAgents`（兼容 `sub_agents`）后，生产 preset 注册 `native_start_child`、`native_delegate` 与 `native_child_control`。Host 将已批准的角色、模型和工具绑定纳入配置摘要，模型不能通过工具参数自行选择其他模型或工作区。每个角色使用独立指令、Run、Session、预算、验证端口及工作区读取状态。子任务读取不能为父任务授予覆盖文件的读取证据，子任务不能调用角色工具集合之外的工具。恢复时核对原角色绑定摘要，不能借恢复切换配置。

`native_start_child` 默认后台执行，`background=false` 等待原子任务；`native_delegate` 默认前台执行，也支持显式后台执行。正常前台结果直接返回原工具调用，预约与终态用量在父事务内同时提交，不额外生成后台结果消息。审批或父暂停时先保存原子任务预约；恢复后等待同一子任务，父模型不能提前继续。取消或超时发生在启动回执提交之前，也先核对已创建的子任务并保留其归属；结果未知的副作用不重跑。已封存的前台结果可在进程重启后核对恢复，不重复启动和计量。

当前支持后台启动、前台等待、前台转后台、向原子任务发送指导、停止、有限等待和已结算子会话续接；终态原始结果与实际用量只结算一次，取消时未获得的提供方用量标记为不完整。角色开放已批准的工作区工具，写角色使用独立目录和显式受控合并；`inheritMcp: true` 另外借用父 Agent 绑定的 MCP 工具，独立核对原子任务当前执行权限，不能由子任务关闭父连接。Skills 继承尚未接入；`maxArtifacts` 等未实现策略也不会被静默忽略。文件隔离和 MCP 继承的验证范围见 `native-child-workspaces.md`。Studio 已接入子任务状态、结果及用量面板，完整子会话对话、通知与全局后代用量消费仍待完成。

`native_start_child` 和 Studio 的 `native_delegate` 支持 `continuation_of`：源子任务必须已终止、安全封存，并有原父任务已提交的启动及用量结算凭据。源可以属于当前父 Run，也可以属于同一父 Session 的已终止祖先 Run；其他 Session 的任务 ID 不构成授权。续接复用源 Session 的协议历史，创建独立 Run、因果归属和预算，角色必须相同，模型、工具及输出约束由当前 Host 重新批准。图片历史保留原获准图片；当前模型不支持图片时，在创建新 Run 前返回明确错误，不向模型发送不受支持的图片或丢弃原历史。源 Run、旧父 Run 及已结算用量保持封存，不向新父任务重复计费。TS 要求非空任务链标识，因此新续接 Run 使用自己的 ID 标识新链。

创建前再次核对源凭据，并以源 Run 为预期会话 head 原子创建；被后续 Run 取代的源返回 `child_followup_source_not_current`。未结束、未收集或含未知副作用的源不能续接；先使用原拥有者的结果收集或恢复核对流程。明确的准入拒绝返回工具错误回执，不伪装成未知副作用。真实 Node 进程在新子任务已封存、当前父回执尚未提交时退出的验证，重开 SQLite 后只核对同一个新 Run，原写入和后代用量均不重复。

前台转后台必须显式启用 `childPromotionPolicy=owned-child-promotion/v1`，并使用提供控制元数据的已拥有子任务端口。Studio 已批准子角色的配置启用该策略。提升保留原 Run、Session、配置摘要和预约；独立的 `promotedChildRunIds` 只追加，不改原预约的 `deliveryMode`。`child.promoted`、命令消费与父状态在同一事务提交，父模型在提交后才能继续。重复命令返回原命令身份，错误子任务 ID、终态子任务或未启用策略都不能产生提升事件。父取消仍停止原子任务；未知副作用仍保持预约、要求恢复核对。

Studio 的现有认证控制通道增加 `sessions/native-child-tasks`、`sessions/native-child-promote`、`sessions/native-child-send` 与 `sessions/native-child-cancel`，返回契约 `agentkit.studio-native-child-control/v1`。查询指定 `agentId/sessionId`，操作还必须携带当前 `runId/childRunId/commandId`；发送指导额外提供 `text/expectedGoalRevision`。过期父 Run 和其他 Agent 的控制句柄会被拒绝。控制句柄只在当前 Native turn 激活期间有效，结束或卸载时释放。操作如未收到确定回执，保存原 Run、子任务、commandId 及原指导文本/修订号，只允许明确重试同一请求；刷新历史不会重发操作，也不会把请求绑定到新的父 Run。非活动父 Run 的控制恢复界面仍待接入。

指导须显式启用 `childInputPolicy=owned-child-input/v1`；停止需要已拥有子任务端口提供目标与唤醒能力。操作先入父任务持久命令队列，在父执行者的有效租约下核对原启动回执、完整因果归属、冻结配置与未结算预约，再把父命令消费和原子任务收件箱入队写入同一事务。目标修订号过期或父/子取消、策略撤销、改目标命令抢先时，指导不会投递。子任务应用指导时再次核对目标修订号。HTTP 接收回执只证明父命令已入队；面板随后显示等待投递、已投递或明确拒绝的状态。

Studio 父任务和已批准子角色的配置启用 `guidancePolicy=boundary-guide/v1`。多条指导按原收件箱顺序逐条应用，每条获得一次有文本或完整工具调用的任务模型响应后，下一条才可应用；模型重试、空响应、上下文溢出和摘要模型不算有效处理。已有工具批次及审批完整封口后再接收指导，前一次文本候选保留在协议历史，目标和验收契约不变。延后的指导不会遮蔽取消、审批或改目标命令，也不阻塞效果领取和只读探测。`input.guidance_applied`、`input.guidance_consumed`、`input.guidance_discarded` 分别记录应用、有效模型处理及未处理要求的结清；取消造成终态时，Store 在原事务内为其余已接收命令写入 `command.discarded`。指导身份及待处理状态随 SQLite 持久化，在压缩和 Host 上下文投影中强制保留；预算耗尽或未知副作用不会被指导绕过。

`packages/agentkit-harness-core/test/guidance-boundary.test.mjs` 对照 Python 固定参考的 `guidance.py`、`effect_receipts.py` 与 `test_inline_guidance.py`，验证两种存储、有效处理顺序、真实摘要请求、审批和抢占、预算耗尽、丢失写入领取及两处真实进程退出。真实 SDK 安装包验证增加 `--guidance-fifo`（与 `--promote --continue-child --history --child-controls` 一起使用），通过认证接口投递两条指导及同 ID 重试，核对不同 HTTP 模型请求逐条可见、两次不同的处理回执和一次原子任务用量结算。

Memory 与 SQLite 都执行上述事务边界；真实独立 Node 进程在事务内退出会回滚两边，提交后退出则保留同一子命令，恢复不重复投递或启动。停止仍由原子任务 Kernel 中断现有执行、封存结果并由原父任务结算，不伪造终态或用量。停止等待审批的子任务会撤销父任务中的对应审批，不能向受保护工具发送允许决定；Host 驱动会唤醒并中止过期的审批等待，迟到回复无权执行工具。

历史查询使用独立的 `sessions/native-child-history` 与 `sessions/native-child-result`，契约为 `agentkit.studio-native-child-history/v1`。Host 固定本地 scope，遍历同一父 Session 的终态祖先，按原冻结工具角色、启动回执、因果归属及预算凭据验证子任务。当前启动回执尚未提交时，活动拥有者可提供已认证的状态和转后台元数据，但不能据此公开交付结果。只有原父任务已提交安全终态结算凭据的结果才可读取；历史查询不需要活动执行句柄，不组装模型、执行工具或改变用量。分页固定任务身份清单，结果按 Unicode 字符分页并提供摘要。

本地 Harness 的会话头部增加“子任务”面板，绑定实际会话 preset 对应的本地 Agent；其他 runtime 和云会话不显示此入口。面板展示当前和历史轮次、续接标识、独立用量及结算状态，仅对当前拥有者允许的任务显示转后台、发送指导和停止操作。子任务结果按普通文本展示，不能执行其中的 HTML，也不代表父任务验收通过。面板状态和组件级验证已覆盖分页变化、切换会话、卸载取消、指导的原文本/修订号及三种操作丢失回执；完整浏览器端到端验收尚未完成。

提升可以打断审批决定已经送达后的父观察等待，不取消子任务。审批交付使用稳定的命令身份；重新观察时必须核对同一个已持久化的决定，不能从子任务阶段推断批准或再次发送审批。提升前已准备的前台等待会根据已提交的提升状态转为后台轮询，不能继续阻塞父任务。独立 Node 进程在提升事务后退出的测试验证：重开 SQLite 后恢复原子会话，仅在明确允许纯推理恢复时重试丢失的模型调用，实际子工具只执行一次，后代用量只结算一次。

`output_contract=parent` 必须同时声明 `output_format=json_object`，且父任务已经有固定的对象输出约束；Host 将该约束与角色自己的输出 Schema 合取，子任务仍使用独立目标和验收条目。恢复时重新核对父输出约束摘要，不能沿用已经变化的格式。`media` 最多接受 20 个 `{source:parent_user_input,index}` 引用；索引是本轮父用户输入的原始内容位置，文本、被 Host 省略的图片和上下文消息不会变成图片授权。Host 只向明确支持图片的子模型传入选中的已接纳图片，不接受模型提供的文件路径、URL 或字节。

正式的 `native_child_result` 与 `native_child_tasks` 通过同一工具管线执行，可并行读取。它们核实实际运行中的父工具意图、完整 Run 身份、原调用与定义、当前租约代次、有效工具范围和角色，再核对启动回执、原始因果绑定及配置摘要。任务列表支持状态、固定 inventory digest 和分页；结果按 Unicode 字符分页，原始文本使用 UTF-8 摘要。活动或结果未知的子任务可以查询状态，但 `result_available=false` 且不暴露未结算的交付文本；只有已封存、已结算且安全的原结果可以返回发现。查询不启动子任务、不调用模型，也不重复结算后代用量。原 Python 查询直接展示活动快照的文本，Node 额外区分状态与可消费交付；普通模型查询和控制保留直接子任务范围，产品历史查询通过上述独立 Host API 跨父轮次发现。

`node scripts/verify-studio-native-children.mjs --source <已构建的维护源码> --archive <Studio.tgz>` 经实际打包文件启动完整 `mountStudioHost`，走认证接口接纳 preset，由父模型启动独立角色模型，通过实际 DSH 工具管线读取真实文件、等待结果并并行查询原交付和任务列表；重启 Host 后的第二轮还沿用父 JSON 输出约束，核对正式结构化提交事件及 SQLite 中独立身份、模型、原始归属和单次预算结算。模型端为本地确定性 HTTP 服务，DSH 模型循环被设置为不可调用，PATH 仅含 Node。依赖图复用固定本地包，因此该验证不代表全新安装、图片端到端或完整 UI 验收。

新建的 Studio 父 Run 还保存 `agentkit.studio-native-recovery-binding/v1`：原 Agent 修订、可选 Frozen Build、模型路由、输出预算、原始 DSH 输入及原系统提示。它属于参与配置摘要的 Host 数据；核心只保存和校验 JSON 对象，不解释 DSH 对象或授予权限，不保存模型凭证和工具执行句柄。`readNativeRecoveryBinding` 核对配置摘要与原 Agent/Session/Run 身份，`assertNativeRecoveryPreset` 拒绝 preset、修订、Build 或 runtime 变化。`rebindNativeDshConfiguration` 再核对原 scope、Session、轮次、Build 及完整冻结配置；重新编译时使用原任务契约，不能重新授予预算或改成新任务。模型、工具、权限契约、输入、提示或预算变化都会在启动 worker 前拒绝。旧 Run 没有该字段仍可读取，但不能根据当前默认值猜测恢复绑定。

维护宿主通过 `dsh.external-turn-host/v1` 保留带 `turn/owner` 的原未结束轮次，并提供显式独占恢复；普通中断轮次仍追加 `interruptedTurnClosers`。Native 投影区分开放与关闭轮次，禁止向已关闭轮次继续投递。整轮 preset 提供仅进程内有效的 `agentkit/native-recovery-binding` 查询，可信 Host 通过官方 `agentEvents` 取得该 Agent 作用域已有的工具绑定，查询本身不启动执行。Studio 首次执行已写入完整归属并处理 Session 与 Native 两个存储之间的启动和取消窗口；Node 适配器可重建尚未创建的原 Run，或推进已存在的原 Run，恢复不会重编译原任务契约或重置预算。仍需生产 Host 重绑原 preset、恢复端点及 UI，不能将底层接口验收等同于全部产品恢复完成。

`node scripts/verify-native-owned-recovery.mjs --source <维护宿主构建目录>` 使用真实公开 Agent、JSONL 与 Native SQLite，在独立 Node 进程中直接退出，不执行清理或释放租约，再由新进程重开。五个故障点是归属刷新后且 Run 创建前、首个模型回执提交后、真实文件写入后但回执提交前、Native 终态投递后但 DSH 结束前，以及归属刷新期间取消。验证保留原日志前缀和完整执行身份、等待原租约到期、取得新 fence、模型回执不重复执行、未知写入不重跑、终态仅结束一次，以及持久取消恢复后零模型/工具调用。未知写入保持 `interrupted` 和开放归属，要求显式核对。端口为确定性测试实现；此验证覆盖实际进程和持久化边界，尚不覆盖生产 Host 冷恢复或浏览器 UI。

绑定阶段的三个相关模块在 Node 26 / 22 各通过 88 项。随后补充 Session/轮次拒绝及旧 Run 的同轮次重放兼容，只复验两个直接相关模块；兼容重放不向旧 Run 追加元数据，其他执行配置漂移或已有恢复绑定被替换仍会拒绝。打包后的实际 `mountStudioHost` 两轮子任务验证另核实这份绑定在 Host 重启和 SQLite 重开后仍保留原模型、修订与输入，且不含模型密钥。验证运行在仅有 Node 的 PATH 下，复用固定本地依赖图；不等于全新安装或冷恢复端到端验收。

活跃写子任务的打包 Host 冷恢复补充验证已通过：原父子模型请求等待中真实退出进程，等待租约自然到期，通过鉴权 SessionController 恢复原 Run，保留同一隔离目录，只写一次、只发布一次，重复恢复无新增调用。Node 26/22 均通过，相关 Host/模型 114 项各通过。详见 `native-child-workspaces.md`。普通且无扩展参数的 HTTP 推理绑定显式启用核心已有的 `pure-inference/v1`；有扩展参数的配置继续要求人工核对。丢失的推理尝试保留 uncertain 记录和用量不完整诊断，外部写入不会因此获得重试许可。

安装配置、默认切换和完整恢复操作说明将在对应产品路径实际验证后补充，当前不可将本说明作为已完成迁移的运行手册。

## 工具网关保留持久审批结果

下节另记录旧 runtime 的 Node 文件工具接入；本节的持久 Native 审批契约与其执行循环分别验证。

Native 工具的 `approval_required` 和原始 `interactionId` 现在通过生产 DSH 工具网关原样交给 Kernel，不能再被普通成功结果覆盖。DSH 后置策略明确拒绝结果时仍返回错误，不绕过宿主策略。

新增定向验证经过实际注册的工具网关、Kernel、Run SQLite 和 Memory SQLite：工具在真实写入前由确定性的 Host 边界要求审批；等待状态及原审批标识持久化后，另一 SQLite 连接和新 Kernel 重开，拒绝过期标识、接收允许或拒绝，也支持等待期间取消。允许后才进入真实 Memory 实现和账本检查；拒绝、取消及后置策略拒绝均零写入，重复命令不重复写入。该用例覆盖网关与账本，尚不代表完整桌面审批 UI 或进程重启后的全部 Host 重建。三个相关模块在 Node 26.5.0 和 Node 22.19.0 各通过 77 项测试，无失败或跳过。

## DSH Native 与 Codex 的 Node 文件工具

生产 Host 现为旧 runtime 注册 `agentkit.dsh-node-workspace/v1`，复用 Native 的十个工作区工具实现。DSH Native、Codex 的 builtin 注册器保留原执行上下文和完整 DSH 权限管线，并使用正式 Node 参数定义；受支持的文件工具直接调用 Node 端口。其他尚未接入的 builtin 仍走旧 Python 桥，因此整个桥尚未移除。

读取状态位于工作区外的 Host store，按 Agent、工作区和真实 Session 分隔；同会话可重开，其他会话或 Agent 不继承编辑读取许可。每次调用固定实际 DSH Agent、Session、callId、原取消信号、名称、函数参数及 `exec.arguments`，在审批等待、文件锁等待和异步解析后复查。Host 或注册作用域关闭后不能继续返回成功；写入后失权保留原回执和修改路径，并报告 uncertain。异步关闭校验不被当作布尔许可，拒绝会被观察。

`node scripts/verify-studio-node-builtins.mjs --source <已构建维护版 DSH> --archive <Studio.tgz> --keep` 解包真实发布包，启动生产 mountStudioHost，经鉴权接口准入 DSH Native 与 Codex 预设，用真实 SessionController 创建会话，再通过实际 DSH ToolRegistry 执行文件操作。Node 26.5.0 与 22.19.0 均通过：文件读取后编辑、跨会话未读拒绝、路径越界拒绝、Ruff WASM 解析、真实 read-only 策略拒绝、ApprovalService 的一次允许和下一次拒绝、等待审批时取消及迟到允许零写入；pre/post 管线均观察到调用。Host PATH 只包含 Node，Python 路径明确不可用。该验证的审批处于受信任测试轮次内，不发起模型请求；它不代表 Codex CLI/在线模型对话、全新依赖安装或整个旧 builtin 桥已验收。

适配器自身在 Node 26/22 各通过 28 项测试，包含新进程重开、真实共享文件锁等待后的撤权和异步解析关闭；相关 runtime bridge、preset 与适配器三个模块各通过 80 项。没有运行仓库全量测试。

## 后台命令完成通知的受控接纳

核心新增 `agentkit.background-notification-admission/v1`。Host 可通过 `admitBackgroundNotification` 将已完成源 Run 所拥有的后台命令结果，接纳为同一 Session、任务链和 Build 下的新通知 Run。接纳先核实原工具意图、已提交启动回执、正式工具策略及当前会话头部；读取实际启动回执指定的后端，不根据当前环境猜测后端。通知是带类型的不可信数据，不伪造新的用户目标，也不重新启动原命令。

新 Run、原始通知及去重标记在一次 Session 头部 CAS 事务中创建。稳定 Run 标识使重复接纳复用原记录；源 Run 保持终态且不修改。通知继续扣除源任务与已执行通知的模型、工具、后代用量、修复、续接和时间预算，观察耗时也计入剩余时间。原信号、完整观察请求或 Session 头部发生漂移，以及取消、超时、后端仍运行或结果未知时，均不接纳新通知。

接纳同时核对源与当前头部的副作用核对状态和子任务预算结算；存在未知写入或未结算子任务时不能启动新的通知推理。连续通知沿用当前头部实际目标、目标修订及已更新的任务契约，保留期间已接纳的 steering。补充的真实未知工具回执与通知轮次 steering 验证，使通知模块在两个 Node 版本下各通过 14 项；没有重跑全量。

新增独立 Node 进程验证在通知事务提交后直接退出，再由新进程重开 SQLite、推进原通知，第三个进程重复恢复不新增模型调用；该测试使用确定性的模型和工具端口。实际后台观察端口另核对原启动回执和后端选择。Store、历史、通知接纳与后台端口四个相关模块在 Node 26.5.0 / 22.19.0 各通过 58 项，无失败或跳过，契约类型检查通过。当前这是接纳和恢复的底层能力，生产 Host 的空闲监听、通知轮次归属与打包端到端唤醒仍待接入和验收。

## Native 工作区工具的运行包契约

固定为 Native 整轮引擎的 Frozen Build 可随运行包携带已接入 Node 的十个工作区 builtin 绑定。`agentkit.portable-native-builtin/v1` 清单固定引擎和实际工具名；导入时同时核对清单与内层 Build 的两份绑定，不能只凭外层归档摘要通过。畸形绑定、未知工具、引擎不符、清单缺失或多列工具均拒绝，包括重新计算内外归档身份后的篡改。

实际 Build → 导出 → 导入验证保留原工具绑定、模型/MCP/Skills 资源和文件权限；删除源 store 与 Skill 目录后，目标仍能读取独立资源，目标 Host 默认关闭 Native 时也保留原冻结引擎。运行包、导出路由、模型桥接和 Codex 状态四个相关模块在 Node 26.5.0 / 22.19.0 各通过 20 项，无失败或跳过。该证据尚不覆盖打包 Host 运行导入后工具、全新安装或所有 builtin 的可迁移执行；其他 runtime 的 builtin 导出契约仍待扩展验收。

## Native 组件状态工具

显式绑定的 `component_status` 已通过实际 Native Kernel、SQLite 工具权限和 Studio Host 执行，保留 `summary`、`skill_space`、`skill_runtime`、`sandbox`、`workspace` 分组。Host 按本轮实际模型、已启用资源、记忆服务、工作区和已挂载工具生成固定快照，并将其纳入恢复绑定摘要。服务目录中的条目不会使尚未挂载的执行服务显示为可执行；Skills 执行服务目前仍报告未启用。

端口核对完整作用域、会话、正式定义、原请求和信号；完成后重放、撤权、取消或请求漂移不会返回成功。共享 gateway 按会话持有和释放端口，不串用另一会话的模型和工具状态。端口 30 项测试在 Node 26.5.0 / 22.19.0 各通过；Host、gateway 及相邻集成共 98 项在两版本各通过，随后新增取消检查后的 Host 模块 4 项各通过，契约类型检查通过。未运行全量测试；打包 Host 的独立运行验证和正式 Skills 服务接入仍待验收。

## 正式 Native Skills 渐进披露

绑定的文件 Skill 已通过 Node 源适配器接入 `skill_catalog`、`skill_read_manifest`、`skill_read_instructions`、`skill_read_resource` 四个正式工具。Host 仅在上下文中加入有明确不可信数据标记的元数据预览，最多八项、4096 字节；预览转义标签，不提前注入完整 Skill 指令。实际源内容摘要参与 Host、记忆插件和冷恢复的绑定，后续源内容变化明确拒绝。

完整指令可直接读取；资源读取须由同一个 Run 的实际 SQLite 已提交指令回执授权，不能继承另一 Run 的披露状态。端口核对准备事件、正式定义、当前权限与原请求；资源限制为规范的包内相对路径，支持 UTF-8/base64 和 32768 字节上限。会话释放撤销自己的端口，不关闭共享父资源。父级审查另外复现并修复了最后一次权限回调替换信号后仍返回成功的问题，补充了真实 Kernel 对信号漂移、端口关闭和资源越界的验证。

Claude 固定快照的端口 27 项在 Node 26/22 各通过；父级补充后端口 30 项、文件源 31 项、gateway/原 Host 65 项、组件 Host 4 项及新增 Skills Host 3 项均已定向验证。六模块首次组合验证在两版本各为 132 通过、1 个失败；失败是测试误写了现有源漂移错误码，修正为准确的 `skill_source_content_changed` 后，仅重跑新增 Host 模块，两版本各 3 通过。契约类型检查通过，没有运行全量。子任务的正式 Skills 继承接入见下文；远程 Skill 执行服务、管理工具与打包 Host 的独立运行验收仍待完成。

## 可信 Host 上下文来源注册

`mountStudioHost` 支持由启动代码传入 `nativeContextSourceRegistrations`；同一宿主作用域内的插件也可通过 runtime bridge 的 `nativeContextSources.register` 登记只读来源，并在自身 effect 清理时调用返回的撤销函数。注册固定来源版本、内容摘要、明确的 Agent 列表、授权版本、每个来源的优先级、超时及字节和 token 限额。Agent 草稿和工具结果不能注册执行回调。

Host 将实际准入来源与本地记忆召回合并，核对重名，并将来源契约纳入运行配置及 Host 恢复绑定。读取在真实持久化 context 意图内执行，核对完整 scope、Session、实际 Revision/Frozen Build、当前租约、原信号、全部请求及 steering 后的有效任务契约。必需来源失败阻止模型调用，可选来源失败仅跳过该来源；来源数据由核心封装为不可信上下文，不授予审批、完成或执行权限。撤销注册和关闭 bridge 会撤销已有端口，不能通过端口公开属性恢复；关闭已撤销端口仍释放注册器持有的引用。

注册器、Host、记忆 Host 和 runtime bridge 四个模块在 Node 26.5.0 / 22.19.0 各通过 81 项；随后补充的同 Run SQLite 冷恢复用例在两版本各通过：在 context 提交、首个模型调用前停止，关闭原 bridge 和数据库，重新注册并重开同一个 Run，保留不可信贡献和原预算后完成。新增用例最初误用了状态名，改为实际 `requesting_model` 后仅重跑该用例；原失败日志保留。契约类型检查通过，没有运行全量。这仍待打包 Host 验证；视觉观察模型和源工作集的其余专项能力分别验收。

## 子任务借用正式 Skills

实际 Native Host 的子任务现在可在 `inheritSkills: true` 时借用父任务固定的文件 Skill 来源，自动获得四个正式披露工具及同一份有界、不可信元数据预览。`inheritSkills: false` 不暴露这些工具或预览。子任务不获得通用脚本执行权限；远程 Skills 执行服务仍须独立接入。

`agentkit.studio-child-borrowed-skills/v1` 绑定来源摘要、完整角色策略和实际 Build，参与子任务配置、恢复绑定及 Host 摘要。每个子任务使用自己的 scope、Session 和 Native 工具意图；父任务或同一子会话之前 Run 的指令回执均不能授权新 Run 读取资源。gateway 通过实际 DSH 注册工具入口派发，核对原始工具权限、租约和绑定；父 Session 释放时撤销其借用端口，不关闭共享 Skill 来源。

Host、gateway 与正式 Skills 三个相关模块在 Node 26.5.0 / 22.19.0 各通过 78 项，无失败或跳过；之后新增的 SQLite 子任务继续执行用例仅定向重跑，在两个版本各通过 1 项。同一子会话的两个 Run 保留相同来源和 Build，但第二个 Run 仍必须重新提交自己的指令读取回执。另验证父任务提前读取不授权子任务、完整角色或 Build 漂移拒绝、完成后重放拒绝，以及关闭继承时无工具和元数据。契约类型检查通过，未跑全量。该证据不等于子任务进程崩溃后整条 Host 冷恢复或打包 Host 验收；这些仍在整体交付清单中。

## 后台完成通知的宿主恢复绑定

`agentkit.native-dsh-background-turn/v1` 将已持久准入的通知 Run 与 DSH 数字轮次分别绑定。Native 的稳定 `wake_` 身份、原命令来源、剩余预算和配置不会因 DSH 重新分配交付位置而改变。序列化记录不携带新用户输入或执行端口；恢复必须重新核对真实账本，并复用核心准入的重复读取路径验证原始启动回执。缺失通知不能从归属记录重新创建；配置、完整身份或来源漂移会拒绝恢复。空闲轮次能力须同时提供 `dsh.external-turn-start/v1` 版本声明和实际方法。

新恢复绑定、原普通轮次归属及核心通知准入三个相关模块在 Node 26.5.0 / 22.19.0 各通过 53 项，无失败或跳过。新增用例包含两个独立进程重开同一 SQLite：首次推进既有通知，第二次无额外模型调用，原命令和源 Run 保持不变；另核对重复记录、预算、缺失记录、篡改拒绝，以及活动通知排斥竞争的新任务。首次新增模块的两个用例试图用真实 Kernel 替换活动 Session head，被正确拒绝；用例改为验证该实际互斥边界，保留失败日志。这些用例验证归属编解码与账本复核，不代表自动唤醒已启用。

通知执行适配器现复用普通 Native 循环，通过 `background()` 执行已拥有的通知轮次，通过 `resumeBackground()` 恢复其原 DSH 位置。可信 Host 必须重新解析原来源并提供精确的减额配置；缺少解析器、归属、原模型来源或完整身份，均不能开始执行。配置和预算不能重新编译。工具审批、取消、事件持久化、流式交付和资源释放复用原执行规则；端口重绑前或重绑期间的取消也记录原通知的持久命令，重启不能因此开始模型调用。竞争的通知执行者在分配第二份端口之前被拒绝。

会话交付仅为显式后台契约接受稳定的 Native `wake_` 身份，普通轮次仍须匹配数字轮次。通知不携带新的用户输入，而是展示一次带 `agentkit-native-background-notification` 来源和 `notice` 形式的原命令观察；后续答案、工具配对和用量按现有投影提交。原始任务和命令不重放。写入会话后、确认游标前失败时，重开数据库和消费者可补交付且不重复模型调用或通知。

五个直接相关模块先在两个 Node 版本各通过 129 项；随后仅重跑补充来源、早期取消和并发保护后的通知模块，两个版本各通过 24 项，无失败或跳过。类型和语法检查通过，没有运行全量。初始通知模块两个故障用例把第二次 flush 错当为模型已提交的位置；改为检查实际 `model.completed` 事件后注入故障，保留原失败日志。这些是实际 Native Kernel、SQLite 和故障可控会话消费者的执行证明；完整 DSH Agent 的空闲轮次接纳、生产 Host 调度与打包入口仍待集成，不作为自动唤醒已启用的证据。

Studio Host 现提供内部 `executeBackgroundTurn`，并通过现有会话恢复入口识别后台归属，调用 `resumeBackground`。状态返回原数字 DSH 轮次，不会把稳定 `wake_` ID 转成无效数字。每次恢复先复核真实通知账本，再通过可信 preset 查询和当前提示组装重建原模型、工具、Revision 或 Frozen Build 端口。通知来源本身也是通知时，沿已完成且同一 Session、Build、任务链和宿主绑定的祖先查找原始输入。完整原配置重新冻结并核对后，才能使用通知已经持久化的剩余预算；配置漂移拒绝执行并释放已分配资源，原用户输入和后台启动不重放。

新增八个 Host 用例覆盖 Revision、Frozen Build、嵌套通知、凭据刷新、配置漂移、原归属 flush 失败后的产品恢复，以及提示重绑期间关闭 Host。实际 Host、模型 HTTP 编解码、Native Kernel、SQLite 和规范回执参与执行；命令传输与 DSH Session 生命周期使用明确的测试替身。两个 Host/恢复模块最终在 Node 26.5.0 / 22.19.0 各通过 56 项，类型检查通过；未跑全量。初次两个正向用例直接读取 headers 对象的小写属性，改用真实 Headers 接口后通过，原失败日志保留。生产自动观察调度、完整 DSH Agent 空闲接纳与打包冷启动仍未完成，当前接线不表示自动唤醒已启用。

Host 的内部 `notifyBackgroundCompletion` 现消费版本明确的 DSH 空闲接纳接口。先通过只读 `backgroundObserver` 查询原启动回执指定的命令；尚未结束或状态未知时不创建轮次。确认结束后，才在 SDK 独占准入期间重新读取并持久接纳通知，随后由共享执行器落盘归属再执行模型。已经接纳但尚未拥有的通知沿用原稳定身份和减额预算；已有未结束归属走原轮次恢复。准入后、归属记录前的取消也写入原通知的持久取消命令，不能在重试时开始新模型调用。来源 preset 改变、缺少真实空闲接口、会话忙碌或并发准入均拒绝；关闭 Host 会取消等待中的只读查询，迟到返回不能创建通知。

Gateway 的只读观察入口携带正式观察契约版本，仅暴露 `observeCompletion`，不分配会话 Skills 游标，也不暴露命令启动、工具执行或模型端口。新增真实本地 supervisor、DSH 工具网关、Kernel 和 SQLite 回执用例，验证读取原命令输出以及跨 Agent、跨 Session 和关闭后拒绝。五个新 Host 空闲用例使用可注入故障的 SDK 生命周期替身，不能代替正式 SDK 的 JSONL 和进程重启证明。Host 模块在两个 Node 版本各通过 50 项，gateway 模块各通过 33 项；补充观察接口版本检查后，仅定向重跑新增六项，两个版本各通过六项。类型和语法检查通过，没有运行全量。首次 gateway 用例重复导入造成语法错误，随后同步拒绝断言误用异步断言；修正后通过。并发运行时还出现一次只读状态 `unavailable`，用例按正式观察契约在同一原句柄上有界重试，仍严格要求最终完成、正确输出和只启动一次。持久 watcher、生产启动调度和正式 SDK 空闲接纳的最终集成仍待完成。

持久 watch 的内部派发入口 `dispatchBackgroundCompletion` 现通过正式 SessionController 查找原 Session，再调用同一受控接纳路径。它在查找前核对本地完整 scope、来源配置摘要、Session 和源运行实际拥有的任务；登记数据不能指定其他工作区、用户、Agent 或替换任务。请求身份在异步查找前捕获，迟到返回或拒绝受 Host 关闭信号约束，不能开始新观察或模型调用。六个新增用例覆盖真实 Host、Kernel 和 SQLite，SessionController 与 SDK 生命周期仍为明确替身；相关 Host 模块在 Node 26.5 和 22.19 各通过 56 项，类型检查通过，没有运行全量。该入口尚待与持久 watcher 和生产启动生命周期连接，不代表自动唤醒已启用。

会话页的“运行与子任务”现显示 Native 原运行的合计用量：本运行计数加上工具内模型调用、已结算的子任务计数。只读恢复状态新增独立版本的 `accounting.contract = "agentkit.studio-native-usage/v1"`，包含 `own`、`descendant`、`total`、快照版本及统计完整性；旧恢复协议保持 v1，旧客户端可忽略新增字段。无未结束的 DSH 归属时，状态读取仍能从原 Session 的 Native head 查到已结束运行；没有 Native 记录时不构造虚假用量。

未知用量显示“统计不完整，显示已知用量”，运行中的已知累计显示“截至目前”；只有终态且供应商、后代计数均完整，才标记 `complete`。客户端拒绝协议版本、运行身份、数值范围、合计或完整性标记不一致的数据，保留前一次有效状态。该聚合不把其他模型的用量塞入父模型的 assistant 消息，完整工具内容、配置和凭据也不进入状态回包。

两项新增真实 Host + 模型 HTTP 编解码 + Kernel + SQLite 用例分别验证完整和部分工具资源用量；数据库关闭重开后，只读查询保留原计数与标记，不调用模型、工具或替换 prompt。DSH Session 生命周期和工具传输为明确替身，不代表真实 Vision 或整页浏览器端到端验收。相关三个模块最后各自的版本在 Node 26.5/22.19 各通过 Host 58、恢复 12、面板 10 项，类型检查和客户端构建通过；没有运行全量。最初客户端校验测试因 fixture 将总计与后代计数引用同一对象而失败，已拆成独立对象并只复验受影响模块，保留原失败日志。

## 正式 SDK 的空闲轮次准入

维护补丁 `051` 实现真实 `ReactLoopAgent.externalTurns.start(prepare, execute)`，并公开 `idleAdmissionContract = "dsh.external-turn-start/v1"`。准入同步独占真实空闲阶段；已有维护任务、排队输入或未结束轮次时拒绝，日志与队列保持原状。SDK 打开轮次、验证并记录精确归属，在同一运行阶段和取消信号下等待准备与执行结束，不添加用户消息或调用默认模型。外部执行器仍须在模型或工具副作用前刷新归属，归属记录本身不授予权限。

归属写入前失败会尝试关闭未认领轮次；如果结束事件也无法写入，保留未结束轮次与排队输入，并报告原错误和落盘错误。归属写入后失败则保留原归属供显式恢复。成功关闭后才允许排队输入继续；取消采用首个原因，释放期间的 `disposed` 不唤醒排队工作，`whenIdle()` 等待原活动真正结束。

新增真实子进程测试通过 Loader 加载已构建的 SDK，在准备阶段和归属写入后分别刷新实际 JSONL，再由父进程发送 `SIGKILL`。重开相同 Session 后，前者修复未认领轮次并可接纳下一轮；后者保留原归属、恢复原数字轮次并仅关闭一次。没有手工生成崩溃日志，没有以普通取消或 dispose 代替进程中断。夹具的执行结果为确定性外部引擎输出，不作为完整 Native Host 或真实模型调用证明。

相关五个模块在 Node 26.5/22.19 各通过 38 项；最后补充的释放后停放输入用例在两版本各通过一项，仅重跑该新增用例。SDK 官方构建、Host 类型检查、受影响文件 lint、双语配对和生成索引检查通过；原 TypeScript SDK 的 external-turn 快照回放通过一项。文档全检查先通过 42 项、失败一项过期事件索引，刷新后仅复验该失败项及受影响类型/配对。初次进程夹具缺少 workspace 声明依赖和测试类型问题均已修复，失败日志保留。Python SDK 未运行，此处的 SDK 证据不作为打包 Native Host 自动唤醒验收。

## 可移植 Frozen Build 的实际账本验收

`scripts/verify-studio-native-portable.mjs --source <已构建维护版 DSH> --archive <Studio.tgz> --keep` 通过实际打包 Host、模型 HTTP 编解码和 Node 工作区工具执行导入的 Frozen Native Build；运行进程只提供 Node PATH，原来源目录删除，归档解压内容检查不含来源路径和凭据。实际 SQLite 记录与 Session 的每个数字轮次、完整归属、配置摘要和 Build 精确对应；工具意图按 operationKey 和结果位置匹配已提交回执。首次读取、写入和回读，新 Host 继续相同 Session，以及策略拒绝和路径越界分别核验原回执、文件字节和用量。

固定 Studio `3b0ea26` 归档及 DSH `f4bccbf1` 基线在 Node 26.5/22.19 独立复验通过。此用例导入后移除目标侧 `portable-bundle.zip`，验证导入后的 Frozen 存储与实际执行；依赖使用固定本地图，不作为全新依赖安装、保留归档时的 Frozen HTTP 启动或最新全部功能的证明。后两项仍需独立验收；无人值守 HTTP 运行原有只读/禁止交互审批策略保持有效。

## 持久后台任务调度与 Host 启动

Host 通过 `bindNativeBackgroundRuntime` 在真实 Session、模型、预设及权限服务就绪后启动 watcher，无须新的用户输入。可移植运行还等待正式 Frozen 资源初始化完成；依赖更换时中断并等待旧 watcher 退出，再启动下一代。Host 关闭依次停止 watcher、等待自身活动、关闭私有注册库和 RunStore。

生产 SQLite 从已提交账本发现当前 Host 主体的 scope，精确过滤 tenant/workspace/user，返回分离的身份数据；可变 Agent 列表或已删除草稿不再隐藏已有账本。发现身份本身不授予恢复或执行权限，原 Session、预设、Build、源配置和命令回执仍由 Host 准入重新核验。扫描完成源 Run 可补齐“源 Run 已提交、尚未注册 watcher”期间的进程中断；旧 watch 即使目录扫描失败也会继续尝试，随后显式报告扫描失败。

`native-harness/background-watches/registry.sqlite` 使用独立私有目录、跨进程所有者锁和严格版本/行身份校验，仅保存必要身份与观察状态。`admitted` 保留待重驱动，原 notice Run 身份只能写入一次；确认终态后 `discarded` 不再调度。损坏库不清空或重置。关闭等待被中断的当前轮询收敛；非协作回调迟到返回或拒绝均被观察，不能继续写注册库。真实子进程持有已刷新的注册记录后被 `SIGKILL`，新进程可取得所有权并读回同一待处理任务。

此前分层验证包含 Host 61、watcher 31、生命周期 5、scope 2 项，分别在 Node 26.5/22.19 通过。Host 分层用例使用真实模型 HTTP 编解码、Kernel 和 SQLite，Session 控制器、SDK 空闲接口及命令运输是明确替身；真实 Cordis 生命周期与 watcher 跨进程锁分别另测。不能将这些分层测试视为全部端到端完成。

### 真实打包 Host 后台生命周期验收

`scripts/verify-studio-native-background.mjs` 使用真实 Studio 归档、维护版 DSH SDK、`mountStudioHost`、已认证的生产预设准入、SessionController、权限及审批服务。确定性 HTTP 模型调用正式 `run_command`，由实际 Node 子进程等待释放文件后完成；启动计数文件位于测试主目录，避免观察器自身改变工作区而触发候选结果重新验证。整个 Host 使用只含 Node 的 PATH，Python 路径不可用。脚本不发送替代用户提示、不手动调用 Native 通知接口、不预置崩溃数据库行，也不提供替代执行器。

四个独立边界在 Node 26.5/22.19 上通过：

- `--boundary warm`：当前 Host 自动发现真实完成结果并开启空闲通知轮次。
- `--boundary cold`：源 Run 和 SDK 轮次都已持久化、命令仍运行时强杀 Host，释放命令后仅启动新 Host，由其自动冷加载原 Session。
- `--boundary prepare`：包装真实 `SqliteRunStore.createNotification`，原事务提交后立即挂起，父进程发送 SIGKILL；新 Host 复用原通知 Run 和配置，SDK 修复无归属轮次后建立合法的新投递位置。
- `--boundary owner`：原 SDK 所有权通过真实 Session flush 落盘后挂起并强杀；新 Host 沿用完整原所有权和数字轮次，无需重新准入通知。

断言同时检查 Native 账本和持久 JSONL：唯一命令启动/工具回执、唯一类型化通知、原 source/task/operationKey/Build/taskChain/hostBinding、不重置通知配置、已知模型用量、模型实际收到完成输出，以及所有 SDK 轮次终态。Native 终态提交早于 SDK 轮次关闭，因此验证等待实际持久 turn/end 再关闭 Host，不用账本终态冒充宿主已空闲。早期验证在该间隔关闭 Host 导致缺失 turn/end 的失败日志保留，最终验证未放宽终态断言。

真实归档验证发现 macOS 正常临时主目录的 `/var → /private/var` 别名导致 watcher 以 `background_state_symlink` 启动失败。Host 现仅规范化可信配置根目录，仍拒绝其内部状态目录和文件中的软链接。两个针对性目录用例及完整受影响 Host 模块 63 项在两种 Node 版本通过，未跑全量。

可重复命令：`node scripts/verify-studio-native-background.mjs --source <built-maintained-dsh> --archive <studio.tgz> --boundary <warm|cold|prepare|owner> --keep`。`--frozen` 另外构建并固定原 Build，修改最新草稿且不设置 Native 引擎环境开关；在冷启动与 owner 强杀边界验证原 Build、系统指令和恢复绑定不变。这是本地已导入 Frozen 存储的交互式 SDK 执行验证；保留归档的 Frozen HTTP、无人值守权限与全新依赖安装仍有独立验收要求。

此轮归档 SHA-256 为 `afa7230047626877758b44a8953a30c20ededc7967d1fc2dd75b20ba221f751b`，DSH 固定 `570ad6033c4d0954451ad8822ab47bfb2160ed4c`。脚本仅复制独立观察 fixture 到归档安装目录，生产代码保持归档原样，并记录 fixture、归档摘要和 SDK 提交。普通依赖来自固定本地图，不能作为全新安装或全部迁移完成的证明。

## Frozen HTTP 完整响应的持久回放

实际保留 `portable-bundle.zip` 的打包验收发现：重复请求虽然没有重新执行模型和工具，但 Responses 丢失原工具输出项、输出项 ID 和创建时间。Frozen HTTP 现将完整响应及其公开 SSE 展示事件作为 `studio/runtime-response-projection` 扩展事实保存在原 DSH Session 日志，标记 `ignorable`，并等待公开 `sessions.flush` 明确成功后才发布完成。重复请求和 Host 重启后的回放保留原时间、输出项 ID、位置、工具结果、拒绝结果和用量。持久化失败或取消不得返回完成；已追加但 flush 失败的展示记录重试时必须再次确认持久化，不覆盖原记录。

展示记录绑定原 Session、Agent、Build、响应句柄及输入和模型的指纹，仅用于交付。回放仍先核对原请求历史；展示记录不能授权创建新 Session、调用模型或执行工具。若执行已完成而尚无展示记录，则从持久请求事实恢复展示，不重新执行。

真实故障验证进一步发现：SDK `whenIdle` 仅表示内存中的轮次已结束，响应展示追加前崩溃时 `turn/end` 可能尚未落盘，重启后返回 `CHANNEL_TURN_INCOMPLETE`。无人值守执行现必须在 `whenIdle` 后等待原 Session 的公开 `sessions.flush` 严格返回 `true`，才读取完成历史并开始交付。失败、未知返回值或取消不得报告完成，不合作的 flush 晚拒绝会被观察。

`scripts/verify-studio-native-response-crash.mjs --source <built-maintained-dsh> --archive <Studio.tgz> --boundary <before-append|after-flush> --keep` 对实际 Host PID 发 SIGKILL 并确认原进程退出，在两个展示边界恢复：追加前没有展示记录时重建并落盘，落盘后复用原完整响应。杀前核对真实 SDK 完成终态，杀后要求 HTTP 200、原完整 Native SQLite 记录不变、重复 JSON 与所有已持久 SSE 展示事实相等、模型和工具不重新执行。原候选将 HTTP 500 计为通过的断言已替换，不能以零模型调用掩盖无法交付的响应。该验证使用保留归档的 Frozen HTTP、正式 SDK 和固定本地依赖图，不代表全新安装或全部迁移完成。

`scripts/verify-studio-native-portable-runtime.mjs --source <built-maintained-dsh> --archive <Studio.tgz> --keep` 在 Node 26.5/22.19 的实际打包 Host 上验证：完整 JSON 暖/冷回放相等、暖/冷 SSE 相等、原 Native SQLite 记录不变、恰好两个 Run、每个 SDK 数字轮次与 Native 身份对应、工具意图/回执/公开调用按正式 Session delivery 身份配对、原 Build 的模型和权限不变。第一轮读、写入拒绝、回读共四次模型调用；重启后的新请求两次模型调用；回放零新调用。固定 DSH 为 `570ad6033c4d0954451ad8822ab47bfb2160ed4c`。五个受影响测试模块在两版本各 27 项通过；未跑全量。依赖仍来自固定本地图，不能作为全新安装、云端部署或全部迁移完成的证明。

## 可选视觉观察端口

`createNativeVisionBrowser` 对应参考 `browser_adapters/native_vision.py`，通过宿主绑定的独立图片模型描述已捕获截图。说明标为不可信模型输出，不能改变原浏览器结果、授予执行权限或宣告任务完成。模型必须明确接受 native 图片；当前工具预算不足、浏览器结果未知或需审批时不额外调用。缓存固定完整 profile、Run、Session、目标修订及截图内容；命中不新增模型用量。已知 token/cost 下界与“用量是否完整”分开记录，未知不能变成零；缓存命中保留原浏览器用量状态。说明及观察文本的长度按 Unicode 码点计算。

真实 Claude `4cf2f0a` 的底层端口及 `0ba5cec` 的宿主包装器经父级实际审查、修正后，接入 `createStudioNativeHarness`。在 Agent 的 `spec.bindings.visionModelProfileId` 显式填写图片模型的资源 ID；普通 `modelProfileId/modelProfileIds` 仍选择对话模型。观察模型的 Host profile 必须声明 `input: ["text", "image"]`，其凭证继续由 Host 解析。未指定观察模型时沿用原行为。这里只给 `browser_inspect_workspace` 增加截图说明，其他工具及原端口的恢复接口保持可用；说明不替代浏览器事实或 Host 验收结论。

观察 profile 的完整配置摘要进入宿主绑定及 Memory plugin lock，运行时每次重新解析凭据并校验模型配置；端点、协议或预算漂移不能改用新配置执行。接受 steering 后，从当前 Run 的 `goal/goalRevision` 构建观察上下文，同时验证任务契约摘要；不能用最初的验收目标替代用户已修改的目标。包装器固定完整 JSON 请求及原 signal，任一字段漂移后不调用观察模型、不发布迟到说明。关闭会取消自身工作，不关闭共享浏览器或模型端口；不合作的 Promise 晚拒绝仍被观察。浏览器已执行后发生身份丢失时，由真实 Kernel 将结果记为 unknown 并中断，不谎称未执行，也不自动重做。

每个 Session 的正式浏览器工具超时包含截图与观察模型耗时，并在 Kernel、DSH gateway 和 browser owner 使用同一份完整 formal；其他字段仍严格相等。最终交付模型保留从 1 次增加到 2 次，受显式总预算上限约束；观察用量作为原工具回执中的后代资源扣减。取消之后返回的说明不写入后续调用的缓存。Frozen 导出会额外捕获该图片 profile 及独立的目标凭证引用，但不把它加入对话模型选择列表；配置保存/重开保留协议、上下文窗口、输出预算、请求超时与模型参数，禁止悄悄恢复默认值。

定向证据包括实际 Host、NativeKernel、SQLite、ToolAuthority 和真实 ModelPort 的确定性 SSE 编解码；Revision/Frozen 入口分别完成主模型→截图工具→独立观察模型→主模型闭环，工具回执保存不可信说明与观察用量。包括请求漂移、关闭不合作 browser/model、晚拒绝、steering（含替换/不替换任务契约）、配置漂移、数据库重开后再次推进终态 Run、完整记录不变及 portable 导出/导入后删除源 store 的配置验证。测试中的 DSH Session 生命周期、registry 和截图 backend 使用明确替身；这些结果不代表实际 Chromium、完整打包 SDK 或在线图片模型验收。完整真实宿主和全新安装验收仍须补齐。

## Legacy DSH/Codex 的 Node Web 接入

宿主 builtin 环境组合原十个 Node workspace 工具与 `web_fetch`、`web_search`，复用共享网络实现，不生成伪造 Native Run 或另一执行循环。显式 Studio Web 绑定会移除标准预设内同名插件，避免正式 SDK 准入时重复注册；普通未覆盖的预设保留原环境。实际打包验证曾在两种 Node 上因该冲突失败，修复后两条 runtime 均经过真实 DSH 注册、pre/guard/around/post/result、HTTP 搜索/抓取、进行中取消及 Node-only PATH 验证；拒绝调用没有网络请求，后置策略的内容替换仍生效。原工作区安全、一次性审批及 Session 隔离验证保留。此验证不执行模型或 Codex CLI，不是全新依赖安装验收。

独立适配器定向验证还覆盖公开 schema 篡改、原调用身份在网络/正文读取期间漂移、重定向前复核、关闭/取消/注册退役与不合作网络 Promise 的晚拒绝。DSH legacy Web 现默认在工作区外保存超出展示预算的完整提取正文，原 Agent、Session、call、完整 JSON 参数和元数据绑定保存引用；正文和元数据一次发布，冷重开核对完整身份与正文摘要。两种 Node 的实际打包 Host、DSH Native 与 Codex 均已验证 Unicode 全文和隔离，定向文件用例包含真实并发与发布边界 SIGKILL。其余 builtin Python fallback、Frozen 导出分类及完整模型回归仍是未完成范围；完整目标保持不变。详见 `docs/native-web.md`。

## E2B Node 命令与监督进程

Node 层新增 `E2BCommandStore`、独立监督进程、正式 `sandbox_status/run_command/read_command_output/stop_command` 端口和已拥有命令的只读观察器。启动前持久化操作记录，重开同一操作只连接既有记录；监督进程丢失、流缺口或未证实的停止均明确报告未知，不能重新执行原命令。沙箱、Session、工作区及原操作键共同约束后续读取；后台启动回执保留原 Run、操作键和 task ID。取消权限使用 `sandbox:cancel`，与执行权限分开。

监督进程持有跨进程 SQLite 锁，以代次和恢复声明拒绝旧进程追加输出、覆盖终态或继续发起停止。正文按完整 UTF-8 字节写入并刷盘，再发布状态；重连使用原沙箱和剩余截止时间。已绑定沙箱身份在首次命令前落盘，重开不能替换；恢复和清理需要严格同步授权，异步授权失败会被观察并拒绝。清理只能接受远端明确确认，授权回调不能借修改参数或持久记录改变目标。

工具端口封存完整 JSON 请求，只排除原顶层 `AbortSignal`；审批、权限回调、沙箱创建、存储构造和输出边界均复核身份。非合作异步创建/启动也能响应原取消信号，未知结果保留已知沙箱和预先确定的 task ID。输出预算必须预留完整归属和有效远端 ID 的空间；不足时在创建/执行前拒绝。执行后的摘要可以缩短正文，不能截断归属或把未知副作用改成 `executed:false`。

四个直接相关模块在 Node 26.5 与 22.19.0 各通过 61 项；随后加强清理目标、读取后身份及传输配置封存，最后分别复验请求边界 9 项和存储边界 3 项，两个版本均通过。覆盖真实 Kernel、SQLite、ToolAuthority，两个实际 detached 监督进程 SIGKILL 边界，以及 UTF-8、并发恢复声明、旧代次、取消、未知结果与预算。故障测试的远端传输使用明确的本地子进程替身；这证明 Node 状态/进程边界，不代表线上 E2B 服务或实际打包 Studio 的 E2B 集成已验收。真实 E2B JS SDK 适配器和沙箱生命周期端口另有既有验证。

Studio 的 Native 工具组装现根据 Host 环境中的 `KSADK_SANDBOX_BACKEND` 固定选择后端，缺省继续使用 `local_process`。显式选择 `e2b` 时必须同时配置 `E2B_API_URL`（明确的 HTTPS 控制平面）、`E2B_DOMAIN`、`E2B_API_KEY` 和 `KSADK_SANDBOX_TEMPLATE_ID`；模板也接受既有 `KSADK_SKILL_RUNTIME_TEMPLATE_ID`。无效配置在注册工具前拒绝，不退回本地 shell。`KSADK_SANDBOX_TIMEOUT`（缺省 900 秒）、`KSADK_SANDBOX_TYPE`、`KSADK_SANDBOX_ALLOW_INTERNET_ACCESS` 和 traffic source 进入同一配置绑定；密钥只保存在 Host/监督进程的私有配置中，不写入 Build、工具回执或远程环境变量。

固定的配置摘要参与既有 Build 和宿主恢复摘要。每个完整 Native scope 与 Session 使用独立的沙箱所有权和后台目录；改变端点、密钥或模板后不能借用该 Session 的旧沙箱，也不能通过切换目录自动创建另一沙箱。显式调用的环境参数只传给远程命令，Host 环境不共享。前台超时上限使用固定沙箱期限，工具正式期限覆盖等待与收尾，后台缺省期限沿用该配置；Native 自身的取消与总预算仍然有效。

`sandbox_status/run_command/read_command_output/stop_command` 进入原 DSH 注册、权限与输出管线，由真实 Native 工具意图包围。后台观察端口只提供原回执拥有的非阻塞读取；Session 释放或普通 Host 关闭不会杀死持久远程命令。监督进程丢失仍报告未知，读取不会自动创建沙箱、重连进程或重发命令。远端已创建但 Host 权限随后失效时，已知沙箱身份保存在未知记录中，需要后续显式核对。组件状态仅在正式 E2B 工具和配置同时挂载时显示隔离执行及模板绑定；这不代表独立 Skills 执行服务已挂载。

接线定向验证使用真实 Studio Host/NativeKernel/SQLite/ToolAuthority，以及明确的 DSH registry 与远程 SDK 替身，覆盖环境配置固定、非零退出、权限拒绝、scope/Session 隔离、后台只读观察、数据库与 gateway 重开、配置变化拒绝和创建中关闭。超时接线修正后，五个受影响模块在两种 Node 各通过 44 项；先前本地命令和后台运行的相关回归也通过。完整打包 SDK 的 E2B 入口、线上 E2B、显式恢复/清理的产品入口、`run_code`、Frozen 配置导出和 legacy builtin 接线仍待验收或实现，不能据此移除所有 Python fallback 或宣布完整迁移完成。

## Legacy runtime 的 Node 本地命令接入

DSH Native 和 Codex 的默认 builtin 组合现在直接提供 Node `sandbox_status`、`run_command`、`read_command_output` 和 `stop_command`，与十个工作区工具及两个 Web 工具共用原注册入口。执行仍经过真实 DSH pre/guard/around/post/result，不额外启动 Native 执行循环，不伪造 Run、turn、scope 或 fence。正式输入 schema 与现有 Native 命令后端共用，公开 schema 副本不能修改内部准入条件。本地命令共享 Host 文件系统与网络，不是隔离沙箱。

每次变更调用绑定真实 Agent、Session、call ID、完整参数、正式定义及固定执行配置摘要。工作区外的私有记录用刷盘与原子发布提交意图和结果；每次调用的 SQLite 内核锁覆盖整个执行过程。意图先于启动或取消命令。重复调用返回原结果，原 call ID 改变内容会拒绝；执行者丢失而没有结果时返回明确的未知状态和预先确定的 task ID，不自动重跑。另一次仍持有锁的调用不能被判断成已经失联。配置摘要含允许传入命令的环境和资源限制，不将 Host 密钥写入调用记录。

前台调用使用现有独立 Node 监督进程，完整保存输出后提交终态；大输出仍保存完整 UTF-8 文件，只缩短模型展示。原调用取消、Host 关闭或身份漂移时，请求取消自己拥有的前台进程，并保留不确定证据。已接纳的后台命令继续独立存活。读输出不缓存观察结果，不延长命令期限；读取和停止必须解析原 Session 的已提交启动记录，裸 task ID、另一 Agent/Session 或变化的后端配置均不能授予访问权。状态目录和工作区不得互相包含。

`tests/dsh-node-command-tools.test.mjs` 在 Node 26.5 与 22.19.0 各验证 21 项，包括真实监督进程、重复调用、重开、UTF-8 游标和完整输出、一次性审批、原调用身份变化、非合作审批取消、前台取消，以及意图后/实际执行中两处真实 SIGKILL。前一边界验证生产调用记录，后一边界经过实际 DSH Node 命令适配器；它们不是整个 Studio HTTP 进程的崩溃验收。原 Native 命令、工作区、Web 及输出存储模块做定向回归，没有每次运行全量套件。

实际打包 Host 验收：先 `pnpm pack --pack-destination <archive-dir>`，再分别用两种 Node 执行 `scripts/verify-studio-node-builtins.mjs --source <built-maintained-dsh> --archive <Studio.tgz> --keep`。真实 Host、预设、SessionController 和 DSH ToolRegistry 在两个 runtime 各检查 29 个主 Session 调用，包含命令重复不再写入、后置策略替换、后台取消、12 万字节完整命令输出、Session 隔离及两次分别决定的审批。宿主 PATH 仅提供 Node，Python 路径不可用；这不代表模型/Codex CLI 或全新依赖安装已验收。

最终真实打包复查发现监督进程原子替换输出/记录时，读取 fd 与当前路径的 inode 校验存在竞态：命令已经完成，读取却报 `background_state_changed`。通过一次真实 rename 的确定性故障注入复现后，私有文件读取现最多尝试四次打开，每次重新核对私有目录、文件类型、权限、链接数及 inode；不重试写入、非法链接/权限或持续替换。七个独立进程用例分别覆盖窗口/全文/记录读取、持续替换上限、符号链接、公开权限和禁止重试写入，并核对 fd 无泄漏。

显式 E2B 选择不进入这个本地 Node 适配器，保留原后端，绝不悄悄改为本地执行。没有随包 POSIX launcher 的平台也保留旧桥接，避免让未绑定命令的 legacy runtime 因初始化本地命令目录而失败；这不是这些平台已完成 Node 命令迁移的证明。Legacy E2B、`run_code`、browser、Skills/A2A 等剩余 Python builtin 路径仍需替换。未知命令有持久记录与禁止重放语义，但产品中的显式核对/修复入口仍未闭环；不要以新 call ID 重新发同一未知命令。全部能力闭环前保留 Python fallback，不能宣布整个安装与运行已消除 Python 依赖。
