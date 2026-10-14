# AgentKit Studio 生命周期重构实施与验收

阶段 1 已实现 Host 作用域内的 RuntimeBridge、注册释放、旧 scope 竞争保护、资源适配器关闭和 Codex 子进程退出兜底。阶段 1 的完整验收状态为部分完成：真实 DSH 生命周期门禁通过，Codex 工具结果跨轮恢复未稳定通过，Electron 开发宿主场景尚未验收。阶段 2 至 5 尚未实施。

## 实施基线

实施从 Studio `9b20aee` 开始，使用固定 DSH `0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84` 和该实施基线的 34 个补丁。它包含架构分析基线 `ae05571` 之后的桌面引导、更新和图标改动。

Studio 在独立工作树修改，DSH 在独立 checkout 应用补丁并完成 `build:official`。真实 Web Profile 使用打包后的 Studio，运行时源码指纹必须与当前工作树一致。验收不使用正在服务日常开发的 checkout 或用户 Profile。

## 改动范围

| 模块 | 改动 |
| --- | --- |
| `src/host/runtime-bridge.mjs` | Host 提供的作用域服务；adapter、工具执行器、路由和取消信号归属明确；无 context 的兼容调用在多 Host 时明确报错 |
| `src/index.mjs` | 注册返回的 disposer 接入 Cordis 生命周期；资源初始化前登记清理；退出前停止所属请求 |
| `src/providers/dsh-runtime.mjs` | 保留已有导出，增加可选 owner；生产路径显式使用所属桥接实例 |
| `src/providers/dsh-runtime-plugin.mjs` | preset scope 持有自己的路由 disposer；按 scope 代次拒绝旧回调覆盖新路由；卸载后不能重新写入 |
| `src/local-resource-adapters.mjs` | 关闭已连接和正在初始化的 MCP client；禁止关闭后重连；MCP 请求传递取消信号 |
| `src/providers/codex-runtime.mjs` | 正常退出超时后强制终止自己的子进程，默认宽限期 5 秒；退出后清除计时器 |
| 验证脚本和测试 | 增加生命周期、真实模型及完整 Studio Web Profile 验证；修正旧验证夹具的模型 route 和 cwd 合同 |

真实 DSH 测试发现两个 scope 短暂重叠时，旧请求钩子可能在新钩子之后写入路由。仅按注册值比较 disposer 不足以避免这种覆盖，因此路由额外绑定创建 scope 的代次。子进程拒绝正常退出的测试先复现失败，再验证超时退出修复。

## 验收结果

| 场景 | 结果 | 证据范围 |
| --- | --- | --- |
| 同一 Host 加载卸载 20 次，每次 3 轮请求，旧 scope 延迟清理 | 通过 | 官方构建的 DSH 服务，生产 RuntimeBridge 和 preset 插件，受控 provider；未把它称为完整 Studio 插件 20 次重载 |
| 两个 Host 使用同一 Session ID | 通过 | 各自真实 Agent/Session/LLM 服务独立执行，卸载一侧不影响另一侧 |
| 模型执行中卸载、资源初始化晚于卸载 | 通过 | 取消信号传递、单次结束和所属资源归零 |
| MCP 初始化过程中关闭、关闭后禁止重连 | 通过 | 真实 MCP SDK 加受控 HTTP transport |
| App Server 拒绝正常退出 | 通过 | 回归测试验证子进程最终退出，正常退出不留下兜底计时器 |
| 完整 Studio Web Profile 启动及 Host 操作 | 通过 | 官方 CLI、真实 cookie 认证、打包插件指纹匹配、凭证状态和设置 RPC |
| DSH retry 及工具续接 | 通过 | 8 个真实 DSH 循环场景，包含取消、失败分类、重试上限及工具不重复执行；provider 受控 |
| 独立 Harness 包加载、卸载和持久化恢复 | 通过 | 官方 DSH 服务及实际 npm tarball，3 项检查 |
| Codex 工具展示、JSONL 重开及原生节点组装 | 通过 | 6 组受控工具事件与真实持久化，官方节点组装器检查；不代表真实 Codex 多轮执行 |
| Harness 真实配置模型 | 通过 | 两轮对话、一次工具执行、取消结束和资源释放 |
| DSH Native 资源桥接真实配置模型 | 通过 | 同上；不扩展为所有 DSH Native 入口的验收 |
| Codex 真实 App Server 与配置模型 | 未稳定通过 | 有一次完整通过，随后复测在第二轮工具结果回忆失败；保留成功和失败两份证据 |
| Electron 开发宿主和安装包升级 | 未验收 | Web 和 Node Host 结果不替代桌面结果 |

公开面、完整 Git 历史及 Gitleaks 当前快照检查属于源码与发行输入门禁。`make release-check` 的成功不代表签名发行、云端部署或真实安装更新通过。

## Codex 待解决项

复测中第一轮已执行工具，但最终回答没有包含工具值；第二轮仍返回第一轮的完成文案，没有取得工具值，也没有再次执行工具。当前 adapter 每轮创建新的 ephemeral thread，并通过 user/assistant 文本重建上下文；原始工具事实属于展示事件，没有进入该文本上下文。这是需要验证的上下文恢复边界，不能以一次通过判为连续会话验收完成。

后续先用同一场景对照重构前的 adapter，再区分文本上下文续接与原生工具历史恢复。涉及原生线程引用或恢复合同的变更需保留 DSH 的会话和持久化所有权，不能把原本标为 informational 的事件直接当作必需模型历史。

## 复核入口

运行前将 `DSH_ROOT` 指向固定版本、已应用补丁并完成官方构建的隔离 checkout：

```sh
make verify-dsh-lifecycle DSH_ROOT="$DSH_ROOT"
make verify-dsh-live-runtime DSH_ROOT="$DSH_ROOT"
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-dsh-runtime-retry.mjs
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-agentkit-harness-plugin.mjs
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-dsh-codex-tool-cards.mjs
make release-check
```

真实模型脚本使用 Host 配置，凭证不进入输出或报告。只运行 Codex 时可设置 `STUDIO_VERIFY_RUNTIMES=codex`。机器报告和日志保存在忽略的 `.artifacts/refactor/stage-1/`，区分源码测试、受控 provider、真实模型和完整 Web Profile。完整 Web 启动脚本额外要求隔离的 `--home`、`--agentkit-home` 和已安装当前 tarball 的 Profile。
