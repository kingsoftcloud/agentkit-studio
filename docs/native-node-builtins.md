# Node builtin 接线

参考版本为 KsADK `feat-ksadk-harness-2` 的
`355059d78e47ed764bbdb3606304cdf34e9838a3`。
`ksadk/toolsets/__init__.py` 的 `_TOOLSET_DESCRIPTORS` 定义 31 个普通工具；
platform factory 另外为 descriptor registry 添加知识库查询和两个旧版记忆工具。
本仓库以 `agentkit.dsh-node-builtin-catalog/v1` 记录这 34 个具体名称。

`dsh-runtime-plugin.mjs` 已删除 Python 脚本、参考仓库/虚拟环境/解释器查找、
Python 子进程和旧工作区读取状态桥接。所有 builtin 调用只进入已接纳的 Node
port，继续保留完整 DSH registry 的权限、审批、pre/around/post 策略、回执和展示。
工作区的读取状态由现有 Node 适配器持久保存；本任务没有旧 Python 数据需要迁移。

缺少 Node port 时明确返回对应的 `*_NODE_PORT_UNAVAILABLE`；未知具体名称或
工具组返回 `BUILTIN_TOOL_UNSUPPORTED`。原 `pythonRoot` / `pythonExecutable` 和
Python 环境变量不再被该执行器读取，也不会因此启动别的执行器。
保留目录暂不可用时的具体工具绑定恢复，调用失败不会伪装成工具执行成功。

与参考构建规则一致，`tool_search`、`tool_dispatcher`、
`agentengine_tool_dispatcher` 在 builtin 注册前拒绝，防止触达 Agent 锁定范围外
的工具。DSH 原有 PTC 的 `run_code` 保留，旧 KsADK snippet 在 DSH 注册为
`sandbox_run_code`。Native 的正式名称不受影响。

| 工具组 | 数量 | 实际 Node 端口 |
| --- | --- | --- |
| Workspace | 10 | dsh-node-workspace-tools |
| Component | 1 | dsh-node-component-tools |
| Sandbox command | 4 | dsh-node-command-tools / dsh-node-e2b-command-tools |
| Isolated code | 1 | dsh-node-code-tools / dsh-node-e2b-command-tools |
| Browser | 1 | dsh-node-browser-tools |
| Skill reads / workflows / management | 5 / 1 / 3 | dsh-node-skill-tools / dsh-node-skill-workflow-tools / dsh-node-skill-management |
| Web | 2 | dsh-node-web-tools |
| A2A | 3 | dsh-node-a2a-tools |
| Knowledge / legacy Memory | 1 / 2 | dsh-node-knowledge-tools / dsh-node-legacy-memory |

构造器按已绑定工具、平台和后端前置条件组装端口。缺少服务连接、关闭 Skill
workflow、或不支持本地进程的平台，不会因为目录里有名称就获得可用执行器。
本地 snippet 仍明确要求隔离后端；线上 E2B、空闲/容量回收等仍需独立验收。

定向测试将固定参考清单与真实 Node 端口组装逐项比较，并经组合端口实际写文件；
两种 legacy runtime 的缺失端口、未知名称/工具组及元调度器拒绝也有覆盖。
打包验证检查实际 Host/Agent/Session/ToolRegistry 中全部 34 个名称，继续执行既有
真实 HTTP/HTTPS、命令、脚本、浏览器、工具策略与跨进程恢复断言。
这些验证使用固定已安装的 DSH 依赖图和受控服务，不请求真实模型/Codex CLI。

本清单不是完整迁移验收：用户上传的自定义 executor，以及 platform resource
authority 的 `update_memory`、`delete_memory`、`memory_status`、`read_skill_resource`
等扩展契约，仍需逐项确认对应产品路径，不能用普通 builtin 名称覆盖代替。
工具的完整行为/事件、线上服务、恢复界面、全部入口、全新安装和默认切换仍见
[当前验收状态](native-migration-status.md)。完整 Desktop 开发资源检查还要求宿主的
Python/Office 资源；这条安装依赖边界也未由删除 builtin fallback 解决。
