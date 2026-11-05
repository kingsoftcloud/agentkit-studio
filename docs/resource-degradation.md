# 绑定资源不可用时的降级策略

Agent 的 MCP、Skill、知识库等绑定资源在会话建立时需要恢复成运行时能力。恢复失败（MCP 连不上、工具目录 500、Skill 快照读不到）时有两套策略：

## 默认：降级运行

- 失败的绑定**不进工具集**，其余资源与模型对话照常；
- 不可用资源写进系统提示词，明确告诉模型「请勿声称已调用或已读取」，避免模型凭空编造工具调用；
- 运行时日志一行 warning：

  ```
  [agentkit-studio] preset resource snapshot unavailable during recovery:
    agentkit-studio-agent-<id>-r1 MCP_CONNECT_FAILED (tool:jinshan-sap) | degraded
  ```

适用于绝大多数场景：一个 MCP 抖动不应该让整个 Agent 不可用。

## 严格：`AGENTKIT_STRICT_RESOURCES=1`

要求「资源不全就不许跑」的部署可以显式开启：

- 预设装配阶段直接失败，冻结运行时报告 unavailable；
- 每一轮请求都会拒绝执行，报错带资源与错误码，例如
  `此会话的 Agent 资源恢复失败：MCP/Tool jinshan-sap（MCP_CONNECT_FAILED）`。

设置方式：

- 云端 Agent：`Advanced.EnvironmentVariables` 增加 `AGENTKIT_STRICT_RESOURCES=1`（或写进 runtime manifest 的环境变量）；
- 本地 Studio：进程环境变量 `AGENTKIT_STRICT_RESOURCES=1`。

## 相关实现

- 采集与降级判定：`src/agent-preset-admission.mjs`（`unavailableResources`、`strictResources`）
- 每轮拦截：`src/providers/dsh-runtime-plugin.mjs`（`assertResources`）
- 开关读取：`src/host/bootstrap.mjs`（`AGENTKIT_STRICT_RESOURCES`）
