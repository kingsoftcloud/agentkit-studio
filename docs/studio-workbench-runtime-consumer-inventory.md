# Studio Workbench Runtime 消费者盘点

这份清单用于审计 Studio 对话工作台改造涉及的旧 Harness、Plugins、Teams 和
`resource_runtime` façade。它记录当前仍存在的内部消费者，不把兼容入口误写成已经删除。

## 当前消费者

| 层 | 入口/实现 | 当前职责 | 结论 |
|---|---|---|---|
| Runtime factory | `ksadk/runtime/executor.py`、`ksadk/runtime/registry.py`、`ksadk/studio/kernel_registry.py` | 按 Build 创建 `RuntimeAdapter`，由 Kernel worker 持有 live adapter/handle | Studio Session command 已走 durable Kernel；旧 `StudioTurnCommandService` 仍作为嵌入测试适配器保留 |
| Kernel host | `ksadk/kernel/worker.py`、`ksadk/kernel/bootstrap.py`、`ksadk/kernel/execution_host_ingress.py` | FIFO admission、控制命令、Teams trusted host 和跨进程恢复 | Kernel 是本地命令的唯一执行入口；Teams host 仍是独立的受信边界 |
| Harness | `ksadk/harness/*`、`ksadk/plugins/providers/harness_dsh.py`、`ksadk/studio/run_support.py` | Managed Harness 事件、工具和 legacy provider 适配 | 仍有真实内部消费者，不能删除 façade；能力声明保持 fail-closed |
| Plugins | `ksadk/plugins/host.py`、`ksadk/plugins/composition.py`、`ksadk/studio/plugin_runtime.py`、`ksadk/studio/dsh_lifecycle.py` | plugin lock、权限、DSH profile 和 provider 生命周期 | Studio 构建/启动仍依赖这些路径 |
| Teams | `ksadk/kernel/teams_runtime_bootstrap.py`、`execution_host_ingress.py`、`teams_host_http.py`、`teams_tool_runtime.py`、`ksadk/plugins/teams/*`、`ksadk/studio/teams_*` | Teams session、stream、material、effect、callback 和节点运行 | 不是普通 Session command 的别名；继续保留双 permit 和独立 session 约束 |
| Resource runtime | `ksadk/resource_runtime/*`、`ksadk/cli/runtime_bootstrap.py`、`tests/resource_runtime/*` | memory/knowledge/skill resource worker、snapshot、lease、IPC 和 operation ledger | CLI 和资源工具仍直接消费；未做删除或 façade 收敛 |
| Tests | `tests/studio/test_legacy_harness_product_entry.py`、`test_plugin_runtime.py`、`test_scheduler_dsh_harness_product.py`、`tests/plugins/test_teams_runtime.py`、`tests/kernel/test_teams_*`、`tests/resource_runtime/*`、`tests/e2e/test_teams_studio_e2e.py` | 锁定旧入口兼容、Teams session/stream/queue/reconnect 和 resource worker 行为 | 这些回归是后续收敛前置条件 |

## 已执行的定向回归

使用 Python 3.13 项目 uv 环境执行了本地 Kernel/Studio 相关回归：

```text
tests/studio/test_session_kernel_admission.py
tests/kernel/test_worker.py
tests/kernel/test_execution_grants.py
tests/test_sessions_service.py
```

结果为 `193 passed, 1 skipped`（核心 Studio admission/Session 回归）。这些结果证明新的
Studio admission、FIFO、取消和 Session 持久化没有绕过 Kernel；它们不等价于 Teams 或
resource runtime 的全量回归。

另外执行了以下 Teams/resource runtime 定向集合：

```text
uv run --frozen --extra dev pytest -q -rs \
  tests/kernel/test_teams_execution_context.py \
  tests/kernel/test_teams_host_ingress.py \
  tests/kernel/test_teams_runtime_bootstrap.py \
  tests/kernel/test_teams_materials.py \
  tests/kernel/test_teams_tool_runtime.py \
  tests/plugins/test_teams_runtime.py \
  tests/e2e/test_teams_studio_e2e.py \
  tests/resource_runtime/test_memory_worker.py \
  tests/resource_runtime/test_worker_process.py \
  tests/resource_runtime/test_langgraph_resources.py \
  tests/resource_runtime/test_memory_recall_snapshot.py \
  -k 'not preprod'
```

结果为 `76 passed, 48 skipped, 5 warnings`。跳过项是环境门槛：部分 Teams 测试缺少
`pgserver`，Teams e2e 需要 `KSADK_DSH_TOOLCHAIN_E2E=1`，resource worker/langgraph
测试需要 pinned 官方 DSH/Cordis 安装或 `KSADK_TEST_DSH_NODE_MODULES`。这些跳过不计作
云端 provider、Server 或预发链路验收。

Teams/resource runtime 的完整真实云端链路仍需要对应 provider、Server 和预发凭证；在
定向 Teams session/stream/reconnect/queue 回归和预发环境证据齐全前，RFC 验收矩阵第 16
项保持“未验收”，也不删除旧 Harness/Plugins façade。
