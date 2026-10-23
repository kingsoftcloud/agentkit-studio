# Native 迁移当前验收状态

目标仍是完整迁移、所有 Studio 执行入口贯通、安装与执行均无需 Python，保留 DSH
Native 和 Codex。没有历史 Python 数据只免除历史数据兼容；不免除当前能力和恢复验收。

先前报告的 85%–94% 没有完整、稳定且按工作量加权的分母，不能支持整体完成度。
现撤回精确百分比；测试通过率、已写代码量和某条路径成功均不换算成整体迁移率。
下面列的是当前确定的硬性缺口，不是完整逐项能力审计已经结束的声明。

| 完成门槛 | 当前可确认状态 | 尚未闭环 |
| --- | --- | --- |
| 完整正式能力对应 | 独立 TS 核心、Node 多种端口及多个 Host 路径已实现和专项验证 | 对参考能力表逐项核对当前实现、事件及产品组装；不能用历史阶段日志代替当前完整审计 |
| 可选后端及服务能力 | 本地 Skills 工作流已打包执行；E2B Skills 已接入独立沙箱、逐命令监督和产物交付；Node 隔离代码片段已接入 Native 与独立 DSH 工具名；A2A 有真实 HTTP 执行和历史恢复 | 线上 E2B 成功执行/解释器/重连/清理验收；Skill 输入文件和完整专用事件；A2A 继续/取消/内部控制面等仍有实现或接线缺口 |
| 全部恢复产品流程 | 意图/回执、lease/fence、实际进程中断与不盲目重放已有专项；多个实际 Host 重启路径已验证 | 各后端结果未知时的显式核对/清理/继续，以及全部审批和恢复界面闭环 |
| Studio 所有执行入口 | 本地对话、历史、部分 Frozen/后台通知路径已有真实 Host 证据 | 自动化、定时、Frozen HTTP/部署和完整浏览器消费的全部组合验收 |
| 安装和执行不依赖 Python | 多条打包验证在受限 PATH 和无效 Python 配置下成功 | dsh-runtime-plugin 仍保留实际 Python builtin fallback；完整替换以及全新无 Python 安装/启动/执行未通过 |
| DSH Native 与 Codex 保持正常 | 工作区、Web、本地命令、component_status、五个 Skill 读取及本地 execute_skills 已打包验证；E2B 工作流已接入 Node 并验证实际 SDK 拒绝连接后的跨进程恢复 | 两种 runtime 的完整模型/CLI 回归；其余 builtin 迁移；交互 E2B 的线上验收和空闲/容量回收 |
| 默认切换及最终交付 | Native 仍通过显式版本开关启用 | 所有前置验收闭环后切换默认；最终能力差异表、配置恢复说明和最终验证记录 |

直接反证“只剩少量验收”的当前代码：

- `src/providers/dsh-runtime-plugin.mjs` 的 `createBuiltinExecutor` 在未覆盖的工具上仍调用 Python。
- 主迁移文档仍明确默认 Harness 沿用原路径，需要完整验收后切换。

最近已完成的具体推进是 `5631729`：本地 Skills 工作流、原调用的持久记录、命令监督、
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
线上 E2B、空闲/容量回收、其他 Python builtin 及全新安装等缺口仍保留。

完整参考清单见 [native-reference-capabilities.md](native-reference-capabilities.md)，
实现和历史验证详见 [native-harness-migration.md](native-harness-migration.md)。后续进度
应报告已闭环能力和未闭环验收项；只有逐项审计建立完整分母后才能给出可解释的比例。
