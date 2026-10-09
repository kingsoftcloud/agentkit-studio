# Studio 官方精选插件真实安装验收

本记录验证 Studio 插件市场的官方 DSH 精选 Bundle 能通过真实 Host 安装、启用并完成能力检查。
验证基线为 DSH `dsh-v0.2.0-rc.2`，Studio 使用 `scripts/verify-dsh-plugin-market.mjs`，
profile 和 `DSH_HOME` 必须由调用方指定为隔离环境。

## 命令

```sh
AGENTKIT_DSH_ROOT=/path/to/deepseek-harness \
AGENTKIT_DSH_HOME=/tmp/studio-plugin-market-dsh \
pnpm verify-dsh-plugin-market --execute --all
```

脚本通过 DSH `runProfile` 启动真实 Web Host，再调用 Studio 的
`createStudioPlugins().installDsh()`。它不自动批准依赖构建脚本；出现 pending build 时应先由操作者
显式批准，再重试验证。

## 2026-10-09 真实结果

四个精选 Bundle 均返回 `application=applied` 和 `verification.state=ready`：

| Bundle | 实际检查 |
| --- | --- |
| `dsh-experimental-agent-team-profile` | `agent-team`、`tool-agent-team`、`ui-agent-team` 全部 `active`；`agentTeams.listMembers/spawnTeammate/createTask` 存在 |
| `dsh-experimental-schedule-bundle` | `time-context`、`schedule`、`ui-schedule` 全部 `active`；真实调用 `schedule.catalog()` 返回空任务目录 |
| `dsh-experimental-voice-input-bundle` | 四条语音行全部 `active`；真实调用 `speechToText.snapshot()` 返回状态 |
| `dsh-experimental-auto-review` | `auto-review` 为 `active`；`permissionPresets.current/registerAuto/set` 存在 |

安装成功但行未激活、Host 服务缺失或 probe 调用失败时，Studio 返回
`DSH_PLUGIN_NOT_USABLE`，页面显示“能力验证失败”，不会显示“已验证可用”。

Teams 的 teammate 创建、消息和任务板完整行为仍需要在真实 Session 中执行；安装阶段不伪造用户 Agent，
也不触发模型调用或写入用户任务。
