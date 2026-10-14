# AgentKit Studio 生命周期重构实施与验收

阶段 1 已实现并通过适用的本地验收：Host 作用域内的 RuntimeBridge、注册释放、旧 scope 竞争保护、资源适配器关闭、Codex 子进程退出兜底和跨轮工具上下文恢复。完整 Studio 插件在同一个真实 DSH Profile 中连续装卸 20 次；真实配置模型的多轮、工具及取消检查通过，Electron 开发宿主的原生入口和 Host RPC 通过。阶段 2 至 5 尚未实施。桌面安装更新、Windows 原生运行和真实云端尚未验证。

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
| `src/providers/codex-history.mjs` | 从所属 DSH Session 的已有 informational 工具记录生成有界只读上下文，区分完成、失败和结果未知；不生成可执行 tool call |
| 验证脚本和测试 | 增加生命周期、真实模型及完整 Studio Web Profile 验证；修正旧验证夹具的模型 route 和 cwd 合同 |

真实 DSH 测试发现两个 scope 短暂重叠时，旧请求钩子可能在新钩子之后写入路由。仅按注册值比较 disposer 不足以避免这种覆盖，因此路由额外绑定创建 scope 的代次。子进程拒绝正常退出的测试先复现失败，再验证超时退出修复。

## 验收结果

| 场景 | 结果 | 证据范围 |
| --- | --- | --- |
| 同一 Host 加载卸载 20 次，每次 3 轮请求，旧 scope 延迟清理 | 通过 | 官方构建的 DSH 服务，生产 RuntimeBridge 和 preset 插件，受控 provider |
| 完整 Studio 插件在同一真实 Profile 装卸 20 次 | 通过 | 官方 Profile boot、实际 tarball；监听器、HTTP 路由、所属计时器、注册和请求回到基线；实际观测到 20 个所属计时器的创建和释放 |
| 两个 Host 使用同一 Session ID | 通过 | 各自真实 Agent/Session/LLM 服务独立执行，卸载一侧不影响另一侧 |
| 模型执行中卸载、资源初始化晚于卸载 | 通过 | 取消信号传递、单次结束和所属资源归零 |
| MCP 初始化过程中关闭、关闭后禁止重连 | 通过 | 真实 MCP SDK 加受控 HTTP transport |
| App Server 拒绝正常退出 | 通过 | 回归测试验证子进程最终退出，正常退出不留下兜底计时器 |
| 完整 Studio Web Profile 启动及 Host 操作 | 通过 | 官方 CLI、真实 cookie 认证、打包插件指纹匹配、凭证状态和设置 RPC |
| DSH retry 及工具续接 | 通过 | 8 个真实 DSH 循环场景，包含取消、失败分类、重试上限及工具不重复执行；provider 受控 |
| 独立 Harness 包加载、卸载和持久化恢复 | 通过 | 官方 DSH 服务及实际 npm tarball，3 项检查 |
| Codex 工具展示、JSONL 重开及原生节点组装 | 通过 | 6 组受控工具事件与真实持久化，重开后上下文一致、下一轮不重执行；官方节点组装器通过 |
| Harness 真实配置模型 | 通过 | 两轮对话、一次工具执行、取消结束和资源释放 |
| DSH Native 资源桥接真实配置模型 | 通过 | 同上；不扩展为所有 DSH Native 入口的验收 |
| Codex 真实 App Server 与配置模型 | 通过 | 修复后连续两次：第一轮工具值未出现在助手文本，第二轮仍能正确回忆；工具只执行一次，取消终态为 aborted，子进程归零；修复前失败证据保留 |
| Electron 开发宿主 | 通过 | 原生 Electron 44.0.0、工作树内构建的 DSH、实际安装的 Studio；原生 Agent 入口可见，凭证状态及设置 RPC 成功，renderer 无错误 |
| 桌面安装包升级、Windows 原生运行、真实云端 | 未验收 | 当前改动未触及发行配置；开发宿主结果不替代安装或云端证据 |

公开面、完整 Git 历史及 Gitleaks 当前快照检查属于源码与发行输入门禁。`make release-check` 的成功不代表签名发行、云端部署或真实安装更新通过。

## Codex 上下文边界

修复前，第一轮已执行工具，但工具值未进入助手文本，第二轮无法取得工具值。实际 App Server 请求的回归测试复现了缺少工具事实的问题。修复后，从所属 DSH Session 的已有工具记录补充只读观察，最多保留最近 20 个 turn、64,000 字符，并标注截断和未知结果。DSH 的 `deriveMessages()`、事件格式、工具执行和持久化所有权不变；JSONL 重开能重建相同观察。

adapter 仍按轮创建 ephemeral thread。这是 DSH 历史重建后的上下文续接，不是 Codex 原生 thread/resume，也不表示运行中任务能跨进程恢复。没有工具事实的旧日志仍可打开；缺失、截断或结果未知不能被当作成功证明，不能为了回忆结果自动重放旧调用。

## 复核入口

运行前将 `DSH_ROOT` 指向固定版本、已应用补丁并完成官方构建的隔离 checkout：

```sh
make verify-dsh-lifecycle DSH_ROOT="$DSH_ROOT"
make verify-dsh-live-runtime DSH_ROOT="$DSH_ROOT"
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-dsh-runtime-retry.mjs
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-agentkit-harness-plugin.mjs
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-dsh-codex-tool-cards.mjs
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-studio-plugin-lifecycle.mjs
make release-check
```

真实模型脚本使用 Host 配置，凭证不进入输出或报告。只运行 Codex 时可设置 `STUDIO_VERIFY_RUNTIMES=codex`。完整插件脚本另需隔离的 `DSH_HOME`、`AGENTKIT_HOME` 和已安装当前 tarball 的 Profile。机器报告和日志保存在忽略的 `.artifacts/refactor/stage-1/`，区分源码测试、受控 provider、真实模型、完整 Web Profile 和 Electron 开发宿主。

Electron 复核使用 `scripts/prepare-studio-desktop-dev.mjs` 和 `scripts/verify-studio-desktop-dev.mjs`，显式指定隔离 DSH root、homes、真实 Electron 可执行文件和已准备的 primary runtime。开发运行使用独立 user-data 目录，加载工作树内构建的 DSH 与当前 tarball；本次复用已有 Electron 44 引擎和已准备解释器，只读取它们，未重用旧产品插件或旧 DSH Host。
