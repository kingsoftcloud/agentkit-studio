# Native 迁移集中验收记录

状态：**已切换新 Revision / 新 Build 的默认 Native 引擎，尚未完成全部能力交付验收**。本记录区分集中检查、失败修复和
产品入口证明，不能将测试数量换算为迁移百分比。

## 固定版本与范围

Python 行为参考为 `feat-ksadk-harness-2` 的
`355059d78e47ed764bbdb3606304cdf34e9838a3`；参考仓库保持只读。
集中检查从目标分支 `feat-ksadk-harness` 的 `5d668a9` 启动，Node 26.5.0。
集中回归后未重新安装或重复多 Node 全仓回归。随后默认切换仅打包一次并验证两条受影响的完整 Host 路径，见下文。

## 实际执行

证据目录：`.artifacts/native-migration/final-acceptance-20261025/`。

| 检查 | 实际结果 | 记录 |
| --- | --- | --- |
| `node --run precheck` | Native 核心、浏览器包、MCP 包构建成功 | `build.log` |
| `node node_modules/typescript/bin/tsc -p tsconfig.contracts.json` | 通过 | `contracts.log` |
| `node scripts/check-portability.mjs` | 检查 1,543 个已跟踪文件，通过 | `portability.log` |
| 全仓现有测试，`--test-concurrency=4` | 6,196 项：初次通过 6,184，失败 10，跳过 2；用时约 424 秒 | `tests.log` |
| 原父目标抢占子任务指导失败场景 | 内存、SQLite 共 2 项复查通过 | `child-control-fixed.log` |
| 原真实进程工作区锁失败场景 | 1 项复查通过 | `workspace-lock-fixed.log` |
| 其余失败项及受影响的云记忆/上下文场景 | 15 项复查通过 | `failures-targeted.log` |
| 原条件跳过的 Node 22 文件读写 | 提供现有 `NODE22_BIN` 后，1 项通过 | `node22-workspace.log` |

全仓命令为：

```
node --test --test-concurrency=4 tests/*.test.mjs packages/agentkit-harness/test/*.test.mjs packages/agentkit-harness-core/test/*.test.mjs packages/expert-catalog/test/*.test.mjs
```

集中回归期间定位并修复了 Kernel；之后只复查受影响项，没有重新启动整套检查。
因此这些是“集中检查 + 定向修复验证”的证据，不能写成最终提交原样跑过一次
6,196/6,196。剩余原有条件跳过为 secret-scanner 集成，缺少 `GITLEAKS_BIN`；
没有安装扫描器或新增跳过。

## 失败的原因和处理

- **实际 Kernel 问题**：checkpoint 已取消当前 claimed effect，取消 Promise 在
  dispatch race 前拒绝，产生未处理的 `command_interrupt`。现在立即观察该
  Promise，原 race 仍接收同一拒绝；意图、回执、取消和未知结果语义没有改变。
- **进程测试生命周期**：工作区锁测试在竞争进程持锁后才准备基线，准备失败后
  遗留子进程。改为先准备，明确验证真实锁竞争、SIGKILL、退出和原合并结果。
  调度器测试原来只有未完成 Promise 和 unref timer，子进程会自然退出并释放锁；
  现在使用真实 Host 同类的存活句柄，保留原所有权拒绝和未知 occurrence 不重放断言。
- **测试服务不完整/越界**：通道续接夹具补齐实际 Session 持久刷新，并断言每次
  响应等待 flush；云记忆测试的 controller 仅按该夹具显式启用，保留缺失 controller
  必须拒绝后台恢复的用例。公共 Skills 夹具返回原配置的空间 ID，不修改生产边界。
- **过期断言**：全部 Python 原命令优先级和排序仍精确比较，Node 的
  `reconcile_tool: 75` 单独断言；空本地 manifest 按当前参考加载行为保留为空字符串，
  缺失和非字符串仍拒绝；已实现的工具结果清理不再作为“不支持配置”，未知配置仍
  在执行前拒绝；Skills 完整模型工具表明确包含三个既有只读 Artifact 工具。

原 Python oracle 没有改写，实际未知副作用、权限、持久化和锁断言没有删减。

## 与完整交付的关系

[参考能力表](native-reference-capabilities.md) 保留正式、可选和历史兼容分类，
本轮关闭其中六个过期接口疑问；它仍不能单独证明全部能力迁移完成。
[当前状态](native-migration-status.md) 和各专项记录保留实际产品证据与差异。

新 Revision / 新 Harness Build 已默认选择 Native；`legacy` 可回退新建默认策略，
旧 Frozen 引擎 pin 继续保留。配置及恢复边界见[默认引擎说明](native-default-runtime.md)。
最终产品组装验收、可选服务的线上证据及完整能力差异结论仍是交付事项。

## 默认切换的定向验证

默认选择、实际归档、回退和 Frozen pin 的定向检查共 53 项通过；Host 服务检查
3 项通过。复用维护版 DSH `c7e4398390cdd0cf2604ce48acd40d84bd896068` 和现有依赖，
只打包一次，未重新安装或重跑全仓。两条完整挂载 Host 均不提供 Native 启用开关：

| 路径 | 实际结果 | 记录（相对证据目录） |
| --- | --- | --- |
| 普通 Revision，含 Trace | 通过；真实鉴权 HTTP、流式输出、权限拒绝和跨进程恢复 | `default-host/revision.log`、`default-host/revision-evidence.json` |
| Frozen Build，含 MCP 精确数值 Schema | 通过；真实 MCP 副作用、流式输出、权限拒绝和跨进程恢复 | `default-host/frozen.log`、`default-host/frozen-evidence.json` |

两条路径各发生 6 次本地模型 HTTP 请求。归档 SHA-256：
`26ac7d302ee5febe31f4a6d20203b72ac3246e7610c689f86e4bb643bede609f`。
汇总证据为 `default-host/reviewed-evidence.json`，Trace 路由证据为
`default-host/native-trace-route-proof.json`。这是实际打包 Host 的默认入口证明，
不等同于真实云模型、全部可选线上服务或浏览器渲染验收。

## 后续两处明确缺口的收尾

- A2A 事件投递状态现从原调用 journal 投影到任务控制回执及现有面板。真实 HTTP
  Host 检查永久失败、其他批次成功后失败仍保留、重新打开和终态读取不触发任务效果；
  客户端拒绝越界计数、未知代码、额外原文和不一致状态。两个相关测试文件 38 项通过，
  浏览器包构建成功。记录为 `a2a-delivery-view.log`、`a2a-delivery-client.log`。
- Skill GitHub ZIP64 已实现：本地/中央扩展字段、完整结束记录及 streamed archive；
  保留既有归档预算、路径、CRC 和执行 authority。五个 CPython 生成并回读的固定
  fixture 与 Node 字节一致。两个相关文件首轮 29 项通过 28 项；新增生产检查测试
  将底层 source 错写为上层 catalog 的 `ready` 状态，修正为真实 manifest 和文件
  字节断言后，仅重跑该项通过。普通 ZIP 的恰好 65,535 项目录边界另行定向通过。
  记录为 `skill-zip64.log`、`skill-zip64-inspection.log`、`skill-zip64-classic-limit.log`。

这些为当前缺口的定向证据，未再次全仓回归、双 Node 验证、安装或打包。
当前逐组实现、验证与剩余差异见[能力对照](native-capability-status.md)。

## 真实浏览器接入收尾

实际 Studio Web 操作确认对话、允许一次、拒绝、历史重开、流式刷新、取消、
原回合恢复收尾及取消后继续对话。修正 Native 每帧 revision 连续性和 Bridge
丢弃已持久取消 ending 两处接线问题；8 项流式和 6 项 Bridge 定向检查通过。
真实进程重启后，原取消回合收尾没有新增模型调用；新回合取消自动关闭 Session
ownership，不再误报可恢复。实际命令、测试策略、模块摘要及界面证据见
[Web 会话记录](native-web-session.md)。未重新全仓测试、安装或打包，远端问答等
未覆盖界面组合仍保留在能力主表中。

## 内嵌推理兼容收尾

补齐参考 `model_proxy.compat` 的正文投影及增量 projector；策略在新 Run 准入时
固定，旧 Run 无策略时不改变行为。端点选择优先于模型名，保留 Kimi Code 例外。
本轮仅运行核心编译，以及以下两个定向命令：

```sh
node scripts/build-native-harness.mjs
node --test --test-name-pattern 'inline reasoning:' packages/agentkit-harness/test/native-model.test.mjs
node --test --test-name-pattern 'managed binding reuses real Studio assembly' tests/studio-native-harness.test.mjs
```

编译通过，模型 9 项和 Host 2 项通过。真实本地 HTTP 覆盖普通/流式响应、标记跨
chunk、无标记正文、未闭合推理及中断不释放 pending 内容；Host 原配置恢复一致。
日志位于 `.artifacts/native-migration/inline-reasoning-{model,host}.log`。
未重跑全量、双 Node、安装或打包，亦未调用线上模型。厂商请求参数的完整兼容
不能从这项结果推定，剩余边界见能力主表。

## 厂商请求兼容收尾

正式 OpenAI request 的 effort/thinking、压缩用途、usage、回放清洗及工具选择
策略接入冻结配置；三协议配置开关进入实际请求。编译及 25 项相关检查通过，
包括 15 组实际 Python 纯策略固定结果、真实本地 HTTP 和原配置恢复。
具体命令、生成器及明确未闭环项见[模型请求兼容](native-provider-compatibility.md)。
未重跑全仓、安装或打包；长活动流的 idle 续期及独立 thinking 显示仍有具体差异。
