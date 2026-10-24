# Native 迁移当前验收状态

目标仍是完整迁移、所有 Studio 执行入口贯通、安装与执行均无需 Python，保留 DSH
Native 和 Codex。没有历史 Python 数据只免除历史数据兼容；不免除当前能力和恢复验收。

先前报告的 85%–94% 没有完整、稳定且按工作量加权的分母，不能支持整体完成度。
现撤回精确百分比；测试通过率、已写代码量和某条路径成功均不换算成整体迁移率。
下面列的是当前确定的硬性缺口，不是完整逐项能力审计已经结束的声明。

活动 Native Turn 已补齐[远程终态回执的自动衔接](native-a2a-receipt-wait.md)：
远程输入/审批等显式控制确认任务结束后，自动入队原工具的只读核对，继续同一个 Run。
等待只读本地记录，结果未知不自动查询或重发。SQLite 重开和两个 SIGKILL 边界已专项
验证。自动问题等待、持久输入/审批决定及原始截止时间生命周期现已接入，见
[自动问答与恢复](native-a2a-question-waits.md)。Host 重启后也可从原入口显式接回
同一 Run 的本地回执等待器；接回本身不发新的远端请求，主动核对是独立动作。
冷启动发现已接入宿主就绪生命周期，并增加终态问答清理重放；原 turn 尚未关闭时，
清理游标不会阻止接回。仅恢复真实未归档 root 的原运行，子任务走独立待补路径。
完整挂载的冷启动类型化问答、真人及浏览器交互仍需单独验收。

A2A 已补充首次发送前的本地取消：`prepared` 与发送准入通过同一状态锁竞争，
取消先提交则不发远端请求；发送标记已提交则保留原远端取消和未知结果语义。
独立进程与 SIGKILL 专项验证覆盖两种先后顺序、丢失本地取消回执和发送标记后崩溃。
这不替代完整浏览器、真实远端服务及全部能力的验收。

E2B Skill 已增加可信宿主的可选输入文件通道，先固定工作区字节和持久清单再创建沙箱，
保留原调用与未知结果不重放语义。本地后端不搬运输入文件，与参考实现一致；
这不代表新增自动附件/工作区同步。边界、预算和验证范围见[Skill 输入文件](native-skill-inputs.md)。

A2A 可选内部控制面已接入原 Host 的发现、Prepare 许可、轮换 workload token、
外部凭据注入及远端任务绑定，保留原任务查询/继续/取消和未知结果不重发。
该路径已有两种 Node 版本的定向测试和真实打包 Host 整轮/历史恢复证据。
canonical 生命周期、普通消息/文件/数据/类型化工具内容和输入/审批提示已接入原子日志、
持久 outbox、后台重试和预设启动补投；内部路径以原任务 GetTask 确认远端终态，
不把流通知或 lastChunk 当作内容完成依据。公开工具活动扩展的出站调用消费现已接入，
包括稳定身份、重复过滤、终态冲突、敏感信息拒绝和单条/累计限额；远程观察不授予本地执行权限。
内部出站调用的 canonical 事件已通过独立消费游标接入 Studio 持久会话，
使用实际会话全局序号、落盘后确认及重启去重，并接入标准 Chat 和助理只读视图；
远程观察不进入模型历史，也不成为本地工具或审批权限。见 [会话事件接入](native-a2a-session-events.md)。
出站审批/输入决策事件归并和原 Native Run 的自动等待器已接入，
子任务等待器、订阅、入站注册/服务及线上认证仍未闭环，见
[内部 A2A](native-a2a-internal.md)和[自动问答](native-a2a-question-waits.md)。

近期已接入 Node 的模型工具还包括 Browser、Skill 发现/安装/绑定，以及
`search_knowledge_base`。知识库保留完整查询、来源与答案，Native 使用实际意图和
执行 fence，DSH/Codex 使用原 Agent/Session/call 的独立持久记录。定向测试和真实
打包 Host 的跨 PID 回执恢复已有证据。维护版无 Python 的全新安装、完整 Host 挂载及
确定性 Native 整轮执行已在 macOS arm64 的 Node 22/26 通过，见
[Node 安装验证](native-node-installation.md)；真实模型/CLI 和全部产品验收仍待完成。
配置与剩余差异见 [知识库工具](native-knowledge-tools.md) 和
[Skill 管理](native-skill-management.md)。`load_memory` / `save_memory` 也已接入
Node local/HTTP/SDK 服务、真实 Native/DSH 所有权及提前持久化的写 DTO；详情和限制
见 [长期记忆工具](native-legacy-memory.md)。配置差异、真实云服务及完整产品组合
仍待验收，不能以模块通过或已有上下文注入代替整体完成。

| 完成门槛 | 当前可确认状态 | 尚未闭环 |
| --- | --- | --- |
| 完整正式能力对应 | 独立 TS 核心、Node 多种端口及多个 Host 路径已实现和专项验证 | 对参考能力表逐项核对当前实现、事件及产品组装；不能用历史阶段日志代替当前完整审计 |
| 可选后端及服务能力 | 本地 Skills 工作流已打包执行；E2B Skills 已接入独立沙箱、逐命令监督、产物交付及可信宿主可选输入文件；Node 隔离代码片段已接入 Native 与独立 DSH 工具名；A2A 有真实 HTTP 执行、原任务查询/继续/远端取消、忙碌时持久取消及历史恢复 | 线上 E2B 成功执行/解释器/重连/清理验收；Skill 完整专用事件；A2A 真实人机/浏览器验收及内部控制面等仍有实现或接线缺口 |
| 全部恢复产品流程 | 意图/回执、lease/fence、实际进程中断与不盲目重放已有专项；多个实际 Host 重启路径已验证 | 各后端结果未知时的显式核对/清理/继续，以及全部审批和恢复界面闭环 |
| Studio 所有执行入口 | 本地对话、历史、部分 Frozen/后台通知路径已有真实 Host 证据 | 自动化、定时、Frozen HTTP/部署和完整浏览器消费的全部组合验收 |
| 安装和执行不依赖 Python | 普通工具目录的 31 项及平台额外 3 项已有 Node 端口，Python fallback 已删除；维护版 Host 在 macOS arm64 的 Node 22/26 全新正常安装、挂载、Native 整轮执行及恢复均通过 | 名称覆盖不证明全部后端/行为；自定义 executor 和资源 authority 扩展仍需审计，Desktop Node Office 编写、资源离线安装与原生操作已专项验证；完整 Electron 与其他平台仍待闭环 |
| DSH Native 与 Codex 保持正常 | 工作区、Web、本地命令、component_status、五个 Skill 读取及本地 execute_skills 已打包验证；A2A 已增加真实 DSH 身份的 Node 端口与独立持久记录；E2B 工作流已接入 Node 并验证实际 SDK 拒绝连接后的跨进程恢复 | 两种 runtime 的完整模型/CLI 回归；所有工具的完整行为对照；交互 E2B 的线上验收和空闲/容量回收 |
| 默认切换及最终交付 | Native 仍通过显式版本开关启用 | 所有前置验收闭环后切换默认；最终能力差异表、配置恢复说明和最终验证记录 |

当前仍不能判定“只剩少量验收”：

- 普通 builtin 的 Python fallback 已删除；缺少端口会明确失败，不代表缺少的后端能力已补齐。
- Desktop 已默认使用 Node Office 资源和工作流；实际三格式创建、编辑、重开、原生转换/渲染/重算，以及无 Python 的资源准备、离线安装和跨 PID 查询通过。完整 Electron、全部文档特性和其他平台仍待验收；详见[Node Office](native-node-office.md)。Native Harness 的最终默认开关仍待全部验收。
- 主迁移文档仍明确默认 Harness 沿用原路径，需要完整验收后切换。

先前阶段提交 `5631729` 完成了本地 Skills 工作流、原调用的持久记录、命令监督、
精确产物交付及本地/远程资源组装。八模块曾在 Node 26.5.0/22.19.0 各通过 144 项；
随后只针对实际微调复验受影响模块，包括新增的请求尺寸和同步定位反例。

新打包验证 `scripts/verify-studio-native-skill-workflow.mjs` 在两个 Node 版本均通过：
真实生产 Host/preset/ToolRegistry/SessionController、HTTP 模型/目录、HTTPS 包下载、
真实脚本、SQLite/JSONL、文本及二进制原始字节、实际旧 PID 退出/新 PID 历史恢复。
精确次数为模型 2、目录 1、下载地址 1、HTTPS 1、脚本 1；恢复后不增加。
这仍复用固定依赖图，不能支持全新安装、线上服务或全部产品入口完成的结论。

后续 E2B Skills 已补齐基础生产接线，详见 [Skills 的 E2B 后端](native-skills.md#node-e2b-工作流后端)。
它复用实际 SDK 适配器、生命周期所有者和命令监督器，单次 Native 调用独占一个沙箱；
未完成调用和未确认清理不会自动重试。定向用例包含真实脚本、二进制产物、取消、
超时、并发、真实 Host SIGKILL 后冷恢复，以及 NativeKernel/SQLite 网关和组件状态。
E2B SDK 控制面/文件 API 在这些测试中是明确替身；不能据此宣称线上 E2B 或远程 OS
边界已经验收。完整 Skill 事件、输入文件、显式核对和全产品入口仍在原目标内。

DSH Native / Codex 的 E2B 工作流现已使用真实 Agent/Session/call 的独立持久契约，
不构造 Native Run/fence。实际安装 SDK 的拒绝连接、旧 Host 退出与新 PID 恢复已有
打包证据；控制面替身下另有真实脚本、精确产物和 SIGKILL 验证。证明范围见
[DSH E2B Skills](native-skills.md#dsh-native--codex-的-e2b-skill-工作流)。
交互式 E2B 命令也已接入原 DSH/Codex 正式工具管线，保留独立 DSH 身份与持久任务
归属；见 [E2B 命令](native-e2b.md#dsh-native--codex-的交互式-node-命令)。
线上 E2B、空闲/容量回收、完整行为审计及全新安装等缺口仍保留。

完整参考清单见 [native-reference-capabilities.md](native-reference-capabilities.md)，
实现和历史验证详见 [native-harness-migration.md](native-harness-migration.md)。后续进度
应报告已闭环能力和未闭环验收项；只有逐项审计建立完整分母后才能给出可解释的比例。

## 当前 DSH/Codex A2A 实现

三项 A2A builtin 已由 Node 端口接入两种 legacy runtime，固定实际 Agent/Session/call、
Agent revision、Frozen Build 和服务绑定，独立 DSH 意图/远端记录不伪造 Native Run。
只绑定 A2A 的 Agent 也会组装完整预设；缺少 Node 端口不会调用 Python。真实 HTTP+
SSE、并发去重、权限、取消/超时/Host 退役和 SIGKILL/新 PID 恢复已有定向证据。
实际打包 Host 的恢复扩展验证保留了最初冷启动失败记录；进一步复现得到明确错误
`Unknown agent preset`：Host 挂载完成时，异步注册的历史会话预设尚未恢复完成。
现增加注册作用域的显式就绪信号，Host 在已有 registry 时等待恢复完成；注册失败或
途中退役会拒绝启动就绪，catalog-only 配置仍不强制依赖 registry。两个 Node 版本
各通过 138 项受影响模块测试，含故意延迟注册的反例。修复后的实际安装包在两个
Node 版本各通过本地 DSH/Codex、E2B 拒绝连接恢复、Native 完整回合 A2A 三条验证；
均用真实新 PID 冷恢复原记录，未增加远端调用。E2B 验证不代表线上成功执行；DSH/
Codex 工具管线验证不代表模型或 CLI 回归。扩展 executor/资源能力审计、产品恢复操作、线上服务、全新安装、
完整模型/CLI/入口组合和默认切换仍是实质门槛。

普通工具目录及 Python fallback 删除的具体范围见
[Node builtin 接线](native-node-builtins.md)。这不把平台 resource authority 的扩展操作或
用户上传的自定义 executor 静默排除在最终能力审计之外。

## A2A 原任务控制的新进展

共享 Node Host 已实现原任务查询、补充输入和远端取消；Native 与独立 DSH 归属均有
真实 HTTP 验证。完整命令在副作用前持久化，重复命令、丢失响应及真实 SIGKILL 后
不会重发；补充输入保留原任务、上下文和原绝对截止时间。远端取消需再查询确认。
Studio Native 的认证控制接口和“运行与子任务”面板已接线，写操作要求独立的明确
审批；确认已有命令不重复审批。JSON 输入原文通过 Host 精确解析，保留不安全整数。

这还没有闭合完整 A2A 生命周期：远端完成后必须通过原运行的独立回执核对，不能把远端
界面状态直接当成 Native 工具成功回执。结构化输入/远端审批已有显式原任务控制，
真实人机审批/浏览器验收，以及
内部 broker、入站协议与编排仍待闭环。新面板的状态/渲染测试不等于真实浏览器或 Electron 已验收。
契约、操作说明、验证范围及剩余项见 [A2A Node 接入](native-a2a.md#explicit-original-task-controls)。

独立核心现已实现显式的原工具回执等待与核对：以新只读意图追加确认结果后继续同一
运行，保留原未知回执并禁止重发原副作用。真实 HTTP、SQLite 和三处 SIGKILL 验证
覆盖核心行为；Studio 的 A2A 正式适配、认证操作和等待界面现已接通，定向实际服务/
SQLite/HTTP 测试确认补充输入后继续同一 Run，并拒绝伪造结果与迟到回执。完整挂载
Host 的真实 SessionController/认证路由已在 Node 22/26 通过等待时与查询中 SIGKILL
后的原回合恢复：原 Send 始终一次、重复核对命令不重查、原账本和历史归属保留。
这使用已有依赖图与确定性本地 HTTP 服务；线上后端、真实审批/浏览器及全部 A2A
生命周期仍待验收。详见
[原工具回执核对](native-tool-recovery.md)。

DSH Native/Codex 现已接通认证的原任务清单与查询、补充输入、取消界面，保留原
Agent/Session/call/revision/Build 身份及原工具回执。历史会话审批通过宿主既有的
外部回合启动/恢复接口持久化，不调用模型；审批时进程中断后显式恢复原审批回合并
重新请求同一操作的授权。原运行尚未结束时借用其审批日志，回合在等待中关闭则丢弃
授权。远端命令仍由独立账本保证未知结果不重发。真实挂载 Host 的验证范围及仍需
验收的真实浏览器/人机/线上服务见 [DSH/Codex 任务控制](native-a2a.md#studio-controls-for-dsh-and-codex-tasks)。

忙碌取消已补齐独立取消锁、短状态事务及未知 task 时的持久排队。实际独立发送进程
继续运行时，取消进程在排队或 HTTP 投递中 SIGKILL，新进程只对尚未投递的原命令
重新批准后投递，已进入发送的命令不重发。旧流和迟到读取无法抹掉取消命令或覆盖
已确认终态。完整挂载 Host 的认证控制、UI 状态和实际 ApprovalService 已通过
确定性 HTTP 人工应答器验证；这仍不等同于真实浏览器/人机审批或线上后端。

内部出站 A2A 的显式远端审批控制已进一步接入真实 Host 审批日志：严格匹配实际
Session 的 asked/decided 审计对并落盘后，将人的决定、原命令副作用意图、canonical
事件和 outbox 在同一次原调用发布中持久化。支持批准继续、明确拒绝后请求远端取消，
以及普通取消；重复命令和重启不重用决定来重发未知副作用。实际维护版审批/会话服务
与真实进程 SIGKILL 的验证边界见 [Host 审批决定](native-a2a-host-decisions.md)。
自动等待器、显式审批过期事实、入站/订阅服务和完整产品验收仍待闭环。
