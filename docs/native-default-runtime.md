# AgentKit Harness 默认 Native 引擎

Studio Host 的新本地 `runtime.type = "harness"` Revision 和新构建默认使用
`agentkit.native-dsh-turn/v1`，无需设置环境变量。产品入口继续叫 AgentKit Harness。
`dsh-native` 和 `codex` 的执行引擎选择保持各自的原路径。

## 配置和回退

| Host 配置 `AGENTKIT_STUDIO_NATIVE_HARNESS` | 新 Revision / 新 Harness Build |
| --- | --- |
| 未设置或空字符串 | Native |
| `agentkit.native-dsh-turn/v1` | Native，兼容原显式配置 |
| `legacy` | 原 Harness 执行路径 |
| 其他值 | 启动/构建时明确拒绝，不静默降级 |

配置通过 Host 启动时的可信环境提供；修改后重启 Host，让动态预设重新准入。
回退命令示例：

```sh
AGENTKIT_STUDIO_NATIVE_HARNESS=legacy <原 Studio 启动命令>
```

该回退只选择新 Revision 和新 Build 的默认引擎，不转换运行记录，不改变已构建包。
已有 Native Run 恢复仍须使用原 Session、Run、配置和版本化 ownership；不能用旧
执行循环替代原 Native Run。恢复入口和未知结果处理见[迁移说明](native-harness-migration.md)
及[云记忆核对](native-cloud-memory.md)。

## Frozen Build 与部署

Build 清单固定执行引擎、turn contract、Run schema 和 JSON codec。
旧的无 pin 或显式 legacy Build 继续使用原引擎；Native Build 在 legacy 默认配置下
仍使用其固定的 Native 引擎。相同 Revision 的两种构建产生不同 Build ID。
模型、Skills 和 MCP 的 Native 选择都遵循实际 Build pin，不能仅根据当前环境开关
重解释同一个包。导出的 portable bundle 保留这个 pin。

低层 `createStudioBuild` / `DshPresetAdmission` 接口仍允许调用者显式传入原选择；
产品 Host 的默认策略由 `nativeHarnessHostContract` 统一提供。

Native 依赖维护版 DSH 的完整回合 ownership 接口及对应契约，不支持时明确失败，
不会回退为模型调用拦截或 Python 子进程。Node 安装及维护版依赖准备见
[无 Python 安装说明](native-node-installation.md)。

## 验收范围

默认选择、真实 Build 归档、回退与 Frozen pin 的直接检查记录于
`.artifacts/native-migration/final-acceptance-20261025/default-selection.log`。
完整 Host 的无开关执行与重启验证结果记录于[集中验收](native-final-acceptance.md)。
默认切换不是所有可选线上服务和完整无损迁移已经验收的声明。
