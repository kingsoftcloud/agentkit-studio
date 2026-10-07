# 可迁移 Agent 运行包

构建页的“下载定义 ZIP”保留原有冻结 Revision 合同；“导出运行包”在指定 Build 上补充
**导出时**的模型配置、MCP 连接配置和完整 Skill 目录。运行包导入新的 Studio 数据目录，
继续使用官方 DSH Profile、Session、Loop、工具、历史和原生会话页。它需要已安装 Studio
插件的 DSH Host，不是独立可执行文件、容器镜像或已经发布的云端 Agent。

## 内容与边界

`agentkit.portable-bundle/v1` ZIP 包含 `portable.json`、原始 `agent-bundle.zip` 和
`skills/<resource-digest>/<index>/` 文件树。原始 Build ID、Agent ID、Revision、Prompt 和
绑定引用不变。资源内容另有完整 SHA256 摘要，运行包身份覆盖清单、文件摘要和执行权限。
同一内容重复导出复用原文件；资源内容变化产生新的运行包 ID，不改写已导出的运行包。
ZIP CRC、路径、数量、大小、文件摘要、Build 身份及 manifest/spec 一致性在导入前校验。
这些检查证明完整性，不代表发布者签名或代码审计。

| 资源 | 包含的内容 | 目标环境条件 |
| --- | --- | --- |
| 模型 | 实际模型名、提供商、Endpoint、主/备绑定、凭证引用 | 注入对应环境变量；Endpoint 可访问 |
| HTTP MCP | Endpoint、非敏感协议头、凭证引用 | 注入鉴权头需要的环境变量；服务可访问 |
| 本地 Skill / 云端 Skill Space | 已物化的完整 Skill 目录、脚本及执行权限 | 脚本所需的 Python、命令或库另行安装；不会在目标重新下载同一 Skill Space |
| 知识库 / 记忆库 | 资源 ID、控制面地址、区域与绑定策略 | 注入目标账户 AK/SK 等凭证；账户权限和网络可访问资源 |

凭证值不从模型配置、MCP 或云账户配置复制到包内。MCP 内联鉴权头改为生成的环境变量
引用；清单列出所需变量名，部署者自行从凭证系统注入。自定义请求头默认也作为环境变量
处理。带 URL 查询参数或账号的 Endpoint 暂不支持；Agent 定义里的内联凭证、Skill 目录里的
常见凭证文件、符号链接、超大文件均拒绝导出。Skill 文本/脚本仍是用户提供的内容，这些
检查不能代替对任意文件内容的秘密扫描。

目前接受本地 `dsh-native` 和 `harness` Build。Codex 登录及插件状态、其他扩展插件、外部
Python 内置工具运行时尚未迁移，遇到相应绑定会明确拒绝导出。不会用默认 Agent 替代。

## 导出与运行

1. 在“运行中心 → 构建与部署”选择 Agent 和已成功的 Build，点击“导出运行包”。页面展示
   模型、MCP、Skill 绑定数量及需要注入的变量名。Skill 数量按绑定数计算，一个 Space 可包含
   多个 Skill。导出过程中不修改 Agent 草稿或已有 Build。
2. 在安装了本版 Studio 的目标机器执行：

   ```sh
   node scripts/import-agent-bundle.mjs portable.zip --home ./runtime-data
   ```

   目标目录必须不存在。导入不覆盖现有配置；失败清理本次创建的目录，异常中断留下的
   导入标记会阻止启动。命令返回 Agent ID、Build ID、运行包 ID 和所需环境变量名称。
3. 为独立 DSH Profile 安装 Studio，设置 `AGENTKIT_HOME` 指向导入目录，注入清单中列出的
   凭证。不要复用个人 DSH Profile 或在命令行参数中填写凭证。
4. 设置 `AGENTKIT_RUNTIME_AGENT_ID` 和 `AGENTKIT_RUNTIME_BUILD_ID` 为导入命令返回的标识，
   注入至少 24 字符的随机 `AGENTKIT_RUNTIME_TOKEN`，再启动该 Profile。
   `AGENTKIT_RUNTIME_PORT` 默认 8080，`AGENTKIT_RUNTIME_HOST` 默认回环地址。

目标 Host 自动识别导入目录内的 `portable-bundle.zip`，不继承旧版全局 AgentEngine 配置，
缺少资源凭证或选择错误 Build 时拒绝启动运行入口。Skill 按包内文件物化到目标目录，MCP
按包内连接配置解析；知识库和记忆库继续访问远程服务。Agent ID 保留用于记忆分区，调用方
用户身份也需保持一致。记忆写入受理后仍可能等待云端异步索引，立即新开会话不保证可检索。

模型在 Host 启动时通过公开的 DSH Settings 服务注册，不依赖打开浏览器。注册等 Loader
完成后再执行，因为 Settings 写入会触发配置协调；在插件 apply 内等待协调会形成启动死锁。
运行入口只在注册和准入成功后监听，调用协议见[冻结 Build HTTP 入口](frozen-build-runtime.md)。

## 验收与尚未完成的工作

2026-10-08 在全新的 `DSH_HOME`、`AGENTKIT_HOME`、`CODEX_HOME` 中实测导入 66,046 字节的
资源运行包。浏览器点击下载成功，导入后的固定 Build 在打开目标浏览器之前完成：

- 实际调用 `metaso_web_search`，获得官方文档链接；432 个 SSE 事件中 420 个为模型流事件。
- 原生 `skill` 加载 JSON 检查器，`bash` 从目标物化目录执行脚本，返回节点数 7、null 数 1、
  无重复键。模型第一次猜错脚本路径，随后按 Skill 提供的目录纠正并成功；完整记录保留。
- 真实知识检索返回 `smoke_kb_test.md` 的 `SMOKE-KB-CANARY-2026`。
- 保留原 Agent 的旧记忆分区；新写入订单号的接口受理成功，第一次立即召回未命中，稍后的
  新会话召回 `ORDER-ec47818d`。没有把首轮未命中改写为即时成功。
- 原生会话页保持冻结 Revision、`glm-5.3-flash` 和无工作区会话，工具输入/输出可展开。
- 另一个全新 Profile 导入 DSH Native 的双模型运行包。在打开其浏览器之前，只发送
  “周末想去苏州玩两天，预算800元，帮我安排一下。”，约 2 秒返回合法 JSON，包含仅系统
  提示词规定的 `RIVER-29`、两个 days 和 `budget=800`。该目标只注入模型凭证。

单元测试另外删除全部源资源目录后再导入加载，验证文件权限、损坏与额外文件拒绝、重复
导出不可变、目标目录覆盖拒绝、凭证缺失、旧配置隔离以及模型路由冲突。真实临时 Profile
安装曾触发 pnpm `ENAMETOOLONG`；安装输入已移至目标 Profile 自身的摘要目录，复测成功。

**预发运行时部署仍未验收**：还需固定目标 Host 及其依赖的发布产物、AgentEngine
`/v1/responses` 协议适配、UploadCode 上传和 CreateAgentProduct/UpdateAgent 生命周期联调。
本地独立 Host 调用云资源成功，不能作为这些部署流程已完成的证据。
