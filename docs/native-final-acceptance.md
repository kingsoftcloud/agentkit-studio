# Native 迁移集中验收记录

状态：**尚未完成最终交付，未切换默认引擎**。本记录区分集中检查、失败修复和
产品入口证明，不能将测试数量换算为迁移百分比。

## 固定版本与范围

Python 行为参考为 `feat-ksadk-harness-2` 的
`355059d78e47ed764bbdb3606304cdf34e9838a3`；参考仓库保持只读。
集中检查从目标分支 `feat-ksadk-harness` 的 `5d668a9` 启动，Node 26.5.0。
本轮没有重新安装、打包或重复多 Node 全仓回归。

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

当前仍由 `host/bootstrap.mjs` / `host/services/builds.mjs` 的显式版本开关选择
Native；未启用的新 Revision 仍走旧 Harness。旧 Frozen 引擎 pin 必须继续保留，
不能为了默认切换而重解释旧包。默认切换、最终产品组装验收、可选服务的线上
证据及完整能力差异结论仍是交付事项，本次没有宣称完成。
