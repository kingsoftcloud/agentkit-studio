# Native Frozen Build 工具运行包

运行包保留 Frozen Build 的 Native 引擎、具体工具绑定及资源身份。工具能力清单参与运行包内容标识；导入时同时检查内部 Build 的两份绑定及外部清单，重新计算包标识也不能绕过工具、引擎或契约校验。

- `agentkit.portable-native-builtin/v1` 保持原有十种工作区工具；只绑定这些工具的新导出仍使用 v1。
- `agentkit.portable-native-builtin/v2` 允许参考版本 `355059d78e47ed764bbdb3606304cdf34e9838a3` 的 31 种普通工具及三种资源工具，覆盖工作区、组件状态、命令、代码沙箱、Browser、Skills、Web、A2A、知识库和记忆。名单取自具体 Node 端口目录，并与参考工具清单测试核对。
- Native 模型侧名称仍为 `run_code`。`sandbox_run_code` 是 DSH 注册器的传输名称，不能替换 Native 运行包中的正式名称。调度元工具和未知工具不在此契约内。

v2 是工具实现能力契约，不会给工具授予执行权限，也不会把可选服务自动配置到目标 Host。运行包继续携带已有的模型、MCP、Skill 文件和云资源绑定，敏感值通过目标环境凭证引用提供。E2B、搜索服务、远程 Skill Service、Browser 可执行文件等 Host 配置仍须在目标环境明确提供；当前导出器尚未自动迁移全部此类配置。未配置的服务必须按对应 Node 端口报告不可用，不能退回 Python。

Frozen HTTP 默认沿用无人值守的只读策略。因此，导出写文件或命令工具不代表它们会在部署环境获准执行。继续通过原有权限、工作区、审批及恢复边界执行。

可复现的相关验证：

```sh
node --test tests/portable-bundle.test.mjs tests/dsh-node-builtin-catalog.test.mjs
npm pack --pack-destination .artifacts/native-migration/portable-catalog
node scripts/verify-studio-native-portable-runtime.mjs \
  --source .artifacts/dsh-native-idle \
  --archive .artifacts/native-migration/portable-catalog/kingsoftcloud-agentkit-studio-0.0.2.tgz \
  --catalog --keep
```

`--catalog` 使用真实打包 Studio、维护版 DSH Host、保留的 portable archive 和 SQLite：读取文件、拒绝写入、再次读取原字节、使用显式 fake 搜索提供方、通过真实 HTTP 获取受控页面，然后关闭并重启 Host，验证原响应回放和第二轮继续执行。检查工具意图/结果、Session 投影、精确模型次数及页面只获取一次。测试 Host 的 PATH 只提供 Node，Python 配置指向不存在的位置；测试专门允许本地受控 Web 地址，产品默认 SSRF 策略不变。

不带 `--catalog` 仍验证原 v1 路径。上述测试不证明所有外部服务组合、线上 E2B/Skill 服务、Browser 安装、全新依赖安装或全部部署平台已完成验收。
