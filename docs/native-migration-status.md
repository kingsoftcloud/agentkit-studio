# Native 迁移当前验收状态

目标仍是完整迁移、所有 Studio 执行入口贯通、安装与执行均无需 Python，保留 DSH
Native 和 Codex。没有历史 Python 数据只免除历史数据兼容；不免除当前能力和恢复验收。

先前报告的 85%–94% 没有完整、稳定且按工作量加权的分母，不能支持整体完成度。
现撤回精确百分比；测试通过率、已写代码量和某条路径成功均不换算成整体迁移率。
下面列的是当前确定的硬性缺口，不是完整逐项能力审计已经结束的声明。

| 完成门槛 | 当前可确认状态 | 尚未闭环 |
| --- | --- | --- |
| 完整正式能力对应 | 独立 TS 核心、Node 多种端口及多个 Host 路径已实现和专项验证 | 对参考能力表逐项核对当前实现、事件及产品组装；不能用历史阶段日志代替当前完整审计 |
| 可选后端及服务能力 | 本地 Skills 工作流已打包执行；E2B 命令有持久监督及拒绝边界证明；A2A 有真实 HTTP 执行和历史恢复 | E2B Skills 后端当前明确未挂载；E2B 成功执行/重连/清理验收，run_code、A2A 继续/取消/内部控制面等仍有实现或接线缺口 |
| 全部恢复产品流程 | 意图/回执、lease/fence、实际进程中断与不盲目重放已有专项；多个实际 Host 重启路径已验证 | 各后端结果未知时的显式核对/清理/继续，以及全部审批和恢复界面闭环 |
| Studio 所有执行入口 | 本地对话、历史、部分 Frozen/后台通知路径已有真实 Host 证据 | 自动化、定时、Frozen HTTP/部署和完整浏览器消费的全部组合验收 |
| 安装和执行不依赖 Python | 多条打包验证在受限 PATH 和无效 Python 配置下成功 | dsh-runtime-plugin 仍保留实际 Python builtin fallback；完整替换以及全新无 Python 安装/启动/执行未通过 |
| DSH Native 与 Codex 保持正常 | 工作区、Web、本地命令的部分正式工具管线已验证 | 两种 runtime 的完整模型/CLI 回归及其余 builtin 迁移 |
| 默认切换及最终交付 | Native 仍通过显式版本开关启用 | 所有前置验收闭环后切换默认；最终能力差异表、配置恢复说明和最终验证记录 |

直接反证“只剩少量验收”的当前代码：

- `src/providers/dsh-runtime-plugin.mjs` 的 `createBuiltinExecutor` 在未覆盖的工具上仍调用 Python。
- `src/providers/native-skill-runtime.mjs` 的设置对 `e2b` 明确返回 `e2b_skill_runtime_not_mounted`。
- 主迁移文档仍明确默认 Harness 沿用原路径，需要完整验收后切换。

最近已完成的具体推进是 `5631729`：本地 Skills 工作流、原调用的持久记录、命令监督、
精确产物交付及本地/远程资源组装。八模块曾在 Node 26.5.0/22.19.0 各通过 144 项；
随后只针对实际微调复验受影响模块，包括新增的请求尺寸和同步定位反例。

新打包验证 `scripts/verify-studio-native-skill-workflow.mjs` 在两个 Node 版本均通过：
真实生产 Host/preset/ToolRegistry/SessionController、HTTP 模型/目录、HTTPS 包下载、
真实脚本、SQLite/JSONL、文本及二进制原始字节、实际旧 PID 退出/新 PID 历史恢复。
精确次数为模型 2、目录 1、下载地址 1、HTTPS 1、脚本 1；恢复后不增加。
这仍复用固定依赖图，不能支持全新安装、线上服务或全部产品入口完成的结论。

完整参考清单见 [native-reference-capabilities.md](native-reference-capabilities.md)，
实现和历史验证详见 [native-harness-migration.md](native-harness-migration.md)。后续进度
应报告已闭环能力和未闭环验收项；只有逐项审计建立完整分母后才能给出可解释的比例。
