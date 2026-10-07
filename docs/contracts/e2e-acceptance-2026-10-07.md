# AgentKit Studio 端到端验收：2026-10-07

本轮按真实用户流程验收。单元测试、目录可见和构建成功均不能替代实际运行。
结果使用“待测 / 部分通过 / 通过 / 已复现待修复 / 外部阻塞”，每个通过项记录直接证据。
新建测试数据使用 `e2e-20261007` 标识，现有用户 Agent 和云端资源保持原内容。

| 编号 | 用户流程与验收标准 | 状态 | 证据 / 问题 |
| --- | --- | --- | --- |
| S01 | 总览、Agents、资源库、运行中心和设置加载，刷新后无卡死 | 通过 | 最终网页 Host 重启后总览读取真实 22 个 Agent、运行时并显示 4/4 就绪，Agents/资源库/运行中心正常，Studio 设置显示已连接和产品/宿主版本。网页刷新、桌面退出再打开另有实际持久化证据。 |
| S02 | Agent 搜索、分页、详情与绑定数一致 | 通过 | 真实搜索空结果仍可清空恢复；19 个混合 Agent 的 10+9 两页无重复本地记录。Host 读取真实 Build 历史，r2 显示有历史构建、已构建 r1 正确显示已构建。 |
| A01 | 快速创建 Agent，保存 Prompt、运行时和模型后重新打开 | 通过 | 浏览器创建 E2E 20261007 资源助手，重新编辑保留 Prompt/Harness/glm-5.3-flash；原生会话使用正确身份和模型。 |
| A02 | 一键模板创建及编辑 Revision，重新打开保留修改 | 通过 | 研究模板创建后重新打开编辑页保留真实研究 Prompt；绑定本地 Skill 保存 r2 并实际执行。另一测试 Agent 的 r2 Prompt 编辑与冻结 r1 运行隔离已实测。 |
| A03 | 对话创建 Agent，先审阅再保存，草稿可恢复 | 通过 | 实际原生对话生成旅行清单 Agent 草稿；选择暂不创建后未产生 Agent。刷新历史后确认保存，ar-local-fe9cd01162c64944 保留审阅的 Prompt 与默认模型。 |
| C01 | DSH Native 使用选定 Agent Prompt，模型保持一致，无强制工作区 | 通过 | 现有小红书营销文案大师 r2 创建无工作区会话，真实 glm-5.3-flash 回答正确名称、营销职责和家居收纳标题；随后真实秘塔搜索返回 19 条结果及 docs.ksyun.com/products/272，原生工具轨迹可展开。 |
| C02 | 自研 Harness 使用原生会话，流式文本、可展开思考及工具调用 | 通过 | 原生对话真实执行 MCP、Skill/Bash；思考和工具节点可展开。长回答在未结束且停止按钮仍可用时已显示到第 24 条，正文逐步增长。 |
| C03 | Codex Agent 使用原生会话和 Codex Runtime，历史上下文正确 | 通过 | 真实 Codex App Server 搜索后重载历史会话，第二轮正确召回 E2E-CODEX-20261007-BETA；新的无工作区会话真实选择 GPT-6-Luna 并回复指定标记，刷新保留会话和模型。 |
| C07 | 原生回答中的中文相邻网址、加粗及流式链接 | 通过 | 真实 DMG 历史回答原先把中文括号与说明拼进 href；十一号补丁复用 GFM 解析修复。最终 DMG 重放同一 Session，45345、45163 和 directories/5028?type=1 三个链接目标均准确，中文说明位于链接外，加粗恢复；逐字流式更新与显式链接、Unicode 路径回归通过。 |
| C08 | 冷启动恢复旧会话的 Agent 名称，无需切页或发消息 | 通过 | 网页与最终 DMG 都直接恢复先前打开的 Session，预设恢复后名称自动更新；原始问题是动态目录注册无刷新通知，重新进入页面才恢复。事件传递与读取期间失效的回归先红后绿。 |
| C04 | 取消生成、重试、刷新与历史恢复，不误报成功或重复回答 | 部分通过 | 长回答停止与后续继续成功；编辑到 r2/r3、Host 重启后原 r1 Session 仍回复旧身份。原生“在新对话中分支”实际生成新 Session 并保留历史、Agent 和 glm 模型，分支继续使用原 r3 Prompt。独立重新生成按钮未在当前原生页暴露，未声称完成该按钮验收。 |
| M01 | 多模型配置、独立凭证、唯一默认模型及 Agent 默认模型 | 通过 | 真实创建三项独立配置；两个本地合成网关分别校验各自 Bearer 并返回独立 canary，原生会话实际通过。第三配置真实调用 glm-5.3-flash。绑定 Codex 后普通新会话仍使用原有 glm 默认，目录变更无须重启。 |
| R01 | MCP 创建、编辑凭证、探测、工具清单及错误提示 | 通过 | 秘塔真实探测 6 个工具；连接失败后连续保存只保留 mcp-local-03011b4c1b1e4de0 同一记录。云端 mcp_test 真正到达 Endpoint，证书链验证失败以 MCP_TLS_FAILED 持久化显示，未绕过 TLS。最终 DMG App 清空 envRefs，保留 KSC_AIPRO_API_KEY 引用名且不输入密钥，保存后同一 MCP ID 探测 ready 并显示六项真实工具；凭证值未改写。 |
| R02 | MCP 绑定到 Harness 后真实联网搜索，并显示调用与结果 | 通过 | 真实 metaso_web_search 返回 34 条结果；原生轨迹有实际 tool-call 节点，两条 docs.ksyun.com 官方文档链接进入回答。 |
| R03 | MCP 绑定到 Codex 后真实调用，支持后续工具轮次 | 通过 | 真实 Codex 连续调用 metaso_web_search 和 metaso_web_reader，读取 docs.ksyun.com/documents/45545；两个工具的开始、结束和实际内容进入原生轨迹，后续回答完整。 |
| R04 | 本地 Skill 发现、预览、导入、绑定及实际行为生效 | 通过 | 指定 Home 外目录扫描、预览 probe.py、导入 e2e-local-checker 并绑定到研究助手 r2；原生 skill/Bash 实际运行，stdout 含 E2E-LOCAL-SKILL-20261007，退出码 0。独立 App 的 Skill 目录为 0 项，未读取另一 AGENTKIT_HOME 的全局导入记录。 |
| R05 | 云端 Skill Space 绑定、下载及实际行为生效 | 通过 | 原失败会话加载原生 skill 后通过 Bash 运行云端 JSON 检查脚本，真实 stdout：valid=true、nodes=8、null_values=1、duplicate_keys=[]，退出码 0；12 个 Skill 完整文件已物化。 |
| R06 | 知识库绑定、真实检索、内容与来源进入回答 | 通过 | 真实 RetrieveKnowledge 内容进入回答，引用 smoke_kb_test.md 和 SMOKE-KB-CANARY-2026。 |
| R07 | 记忆库绑定、写入、新会话召回，Agent 隔离正确 | 通过 | 写入 e2e-memory-20261007-alpha 后新会话不含标记输入仍召回；相同实例的另一 Agent 查不到，真实查询原 Agent 2 条/另一 Agent 0 条。关闭记忆生成 r3 后不再调用记忆 API；实际回答明确长期记忆已关闭、知识库检索不属于 Memory。原 r1 会话保持原策略。 |
| R08 | 组合绑定 MCP、Skill、知识库和记忆库，无绑定丢失 | 通过 | 测试 Agent 同时绑定模型、秘塔 MCP、smoke 知识库、xiayu-test 记忆库及 Skill Center；分别真实搜索、检索、跨会话召回及执行 Skill 脚本，绑定未丢失。最终 DMG 退出再打开后，r2 会话 12 秒完成秘塔搜索（45 条）、知识库 canary 与真实记忆召回。 |
| P01 | DSH 插件安装、启停、失败提示和实际使用 | 通过 | 网页与独立 DMG App 经安装表单安装本轮无依赖合成插件 0.0.2，Host 热应用；原生模型实际调用 studio_e2e_echo 并显示 canary。错误的 0.0.1 插件被 Host 拒绝并回滚安装；Schedule 停用与重启用实际改变能力和入口。网页、桌面的本轮测试插件最终均卸载成功。此证据为本地插件包安装，未冒称 npm 新包发布。后续复验发现 Make 启动把 pnpm 11 注入 pnpm 10 的旧 Profile，实际出现 ERR_PNPM_UNEXPECTED_STORE；改为官方源码 CLI 后，同一 Profile 安装命令和网页安装表单均成功。 |
| P02 | Codex 插件安装、Skill 加载和卸载 | 通过 | 独立 CODEX_HOME 使用本机官方 openai-primary-runtime 市场，通过 Studio 同一适配器安装 documents，CLI 确认为 installed/enabled；实际 App Server skills/list 返回 documents:documents、enabled=true；卸载后目录不再标记安装。另在独立 DMG App 的 Codex 插件添加表单实际安装 documents@openai-primary-runtime；详情显示 26.909.12148 已启用，包内 Node/Codex 的 skills/list 再次确认加载，界面卸载成功。现有用户插件未变更。 |
| B01 | 本地 Build 打包、下载、历史及冻结版本运行 | 通过 | 真实生成 build_6b8bc89fd3966f21e524，Prompt 更新后原生会话仍运行冻结 r1。网页 Blob 下载稳定复现无文件；改为 DSH 已认证的 Fetch 文件响应后，IAB 下载事件返回 Downloads ZIP 路径，实际 13117 字节，解包 manifest 确认 Agent 与 Revision 1，SHA256 为 0f8b2b3c15221283f9aee2a1d40e090899dfb7026c6b184c74eac5b365f7c275。未认证请求返回 401，外源请求返回 403。最终 DMG 经 macOS 保存面板再次下载 2828 字节 ZIP，SHA256 82206458e5fbe04512aef825b11bb8da581c3cd52e63f9fc00e9872015d2e4d4，与原冻结包一致。 |
| B02 | 部署入口对应真实合同，失败清晰且不生成虚假就绪记录 | 通过 | 真实构建后部署按钮仍禁用并说明 AgentEngine Server 没有 Deployment Action；无新增虚假就绪部署记录。实际云端部署合同缺口仍存在。 |
| O01 | Studio 自动化创建、编辑、启停、手动运行和执行历史 | 通过 | task-d52e9177 手动运行成功并有原生 Skill stdout；实际 60 秒计划 task-92e195c3 在 13:38:49 触发，13:38:51 完成，occ_8dc6863fe1964b51914cb5f051008e15 与 Session/Run ID 一致。两项测试任务最终暂停。一次性空时间与时区编辑修复另有回归检查。 |
| O02 | DSH 原生自动化任务目录及任务详情 | 通过 | 独立 DMG App 通过官方 schedule_create 创建一次性提醒 schedule-ab20de53-eae3-4bf8-823a-d86582bcc431，14:18 实际投递 E2E-DSH-SCHEDULE-20261007；原生任务详情显示执行记录和结束状态，无循环任务残留。 |
| O03 | 运行后 Trace 列表、详情、筛选和导出可用 | 通过 | 真实 Trace 列表、详情、Agent/Run 筛选与合法 OTLP 投影已验证。桌面经官方 DSH Session 日志 API 和 macOS 保存面板导出 43250 字节、28 条合法 JSONL，SHA256 053a09b96607055cc57999f4b8b270ff3aa2c08f2a3bb562c6c7729772fa86e5。投影 Span 不是完整原生工具 Span；完整事实另由导出的 Session 日志提供。 |
| O04 | 评测集导入、目标选择、真实运行与结果详情 | 通过 | 真实导入 e2e-frozen-build-20261007，选择冻结 Build 并实际执行；eval_97cf683487014b0180e7f8390e5fd704 返回旧 r1 身份，两个断言通过，最终页面显示用例 1/通过 1/失败 0/断言 2。A2A 和本地源码目标仍明确未接入。 |
| O05 | Channels 配置、目录和错误处理；外发消息不作为默认测试动作 | 部分通过 | 真实打开未配置目录，显示 connector 不可用；关闭启用开关后提交测试连接也明确要求 serverUrl/accountId，没有伪造连接或外发消息。缺少真实渠道服务配置，联网渠道生命周期未验收。 |
| D01 | 固定 DSH 基线和兼容补丁、Studio 包及 Profile 完整性 | 通过 | 最终 Studio 282 项检查及 163 文件包完整性通过；DSH 桌面相关 177 项通过、1 项平台跳过，新增 Session 模型合同 26 项通过。十一个兼容补丁在固定基线干净 worktree 上逐个检查和应用成功；新增 Markdown 200 项相关检查（含逐字流式更新）通过，双语文档配对及 TypeScript 检查通过。 |
| D02 | macOS App 产物包含运行时、插件与依赖，无源码目录依赖 | 通过 | 真实 DMG 的独立 App 内置 Node24.18.1/Python/pnpm/Office；官方 DOCX/XLSX/PPTX→PDF、原生模块冒烟通过。修复根 manifest 插件解析锚点后，源码目录外 App 完整 Studio 页面与原生 Agent 运行成功。 |
| D03 | 离线 DMG 挂载、复制安装、无预装 Node/pnpm 冷启动 | 通过 | DMG 只读挂载并复制到源码目录之外；PATH 仅保留系统路径，失败代理下冷启动完整 Studio、创建本地 Agent、原生会话成功。外层 sandbox 与 Chromium sandbox 冲突的测试未作为证据；最终 DMG 又在新数据目录中仅系统 PATH、外部服务地址不可达环境启动，实际创建 ar-local-050eddcd95ed4273，并在无工作区原生会话通过本地合成模型验证绑定 Prompt。此处验证独立启动与本地运行，不等同云端资源离线可用或 OS 级断网测试。 |
| D04 | 干净数据目录首次配置、数据持久化、退出再打开 | 通过 | 独立 DSH/AgentKit 数据目录首次 Profile 包含 Studio，模型配置保留；实际创建的本地 Agent、绑定模型与原生会话回答在退出再打开后恢复。旧全局配置迁移仍读取 legacy-global，未声称干净系统账户。 |
| D05 | 桌面原生会话、资源绑定和浏览器已修复问题复验 | 通过 | 独立 DMG App 无强制工作区，真实 glm-5.3-flash 执行秘塔搜索、云端 JSON Skill 脚本和 smoke 知识库检索；全新原生会话实际召回 e2e-dmg-memory-20261007。资源绑定与记录在独立数据目录持久化。 |
| D07 | App 图标与包内 Codex CLI，不依赖系统 Node/Codex | 通过 | Info.plist 指向 icon.icns，实际包内图标为 Studio A；仅系统 PATH 的包内 Node 启动官方 CLI 返回 codex-cli 0.159.2，最终 DMG 的原生 Codex 会话 8 秒真实回复 E2E-FINAL-CODEX-DMG-20261007，未使用系统 Node/Codex。 |
| D06 | 签名、公证及 Gatekeeper 分发验收 | 外部阻塞 | 真实 desktop-check-package 因缺少 apps/desktop/.env.macos 失败；已询问现成配置路径。签名和公证未验收。 |

## 验收边界

离线包应能独立安装和启动；云端模型与资源调用在联网环境验证。
本机测试包与已签名、公证的分发包分开记录。外部 API、第三方授权或签名资料缺失时，
记录实际失败和缺少的条件，并继续完成不依赖该条件的验证。

## 最终本机产物与复验

- DMG：`AgentKit-Studio-0.0.1-mac-arm64-local.dmg`，501722949 字节（478.48 MiB）；SHA256 `0659c0dbdfeced14bd9f61a9d837754eba2b72081279752a9c2a90ade4bf7a58`。这是本机 arm64 未签名验收包。
- 最终 App 已由 DMG 只读挂载后复制到源码目录之外。包内 local-runtime 源码与本轮最终源码 SHA256 一致，284 项检查与 174 个跟踪文件的可分发路径检查通过；最终 tgz 的 167 文件包完整性通过。
- 最终包恢复旧 r1 对话后继续返回 E2E-DESKTOP-PERSONA；r2 资源会话与包内 Codex 的实际续问成功。用户已有 Agent 配置未被测试改写，测试自动化均已暂停或结束。
- 实际图标从最终 App 的 icon.icns 导出，品牌为 AgentKit Studio A；旧版已安装应用不会仅因更新源文件自动改变。本轮未覆盖旧版 0.8.5 安装。
- 未完成的外部条件：渠道服务连接配置、Deployment Action，以及 macOS 签名和公证配置。内嵌浏览器 ZIP 下载已补验；原生重新生成按钮仍未验收。

## 原生链接与插件流程补验

- 新 DMG 经完整官方 build:official、release:pack 和桌面流水线重新生成，包内网页 index.html 与当前构建产物完全一致；重新挂载、复制和启动后重放真实回答验证链接修复。
- Codex 插件空目录的“添加 Codex 插件”实际打开安装表单；DSH 搜索不存在名称显示“没有匹配的插件”，清空搜索恢复真实列表。
- 网页旧 Profile 插件安装与卸载均经界面成功，Host 显示测试插件 0.0.2 已加载；测试插件已卸载。Profile 的同版本开发包通过官方 CLI 强制刷新，安装后的 dist/client.js 与当前打包文件 SHA256 一致。
- 本次补验前矩阵为 35 项：31 项通过、3 项部分通过、1 项外部阻塞。后续下载与冷启动补验记录见下方。

## 下载与开发安装补验

- 网页 ZIP 使用 DSH 公开 `connection.fetch.register` 的 GET/HEAD 文件响应；保持异步 RPC 预检，浏览器实际下载成功，确认问题来自 Blob 下载路径。没有新建旁路服务或放宽认证。
- 同版本、同路径 tarball 的官方安装曾返回成功却保留旧客户端 SHA256；内容摘要路径安装后逐文件与 tgz 核对通过，新增回归拒绝同版本旧内容。
- 十二号兼容补丁为公开预设目录增加变更事件，并处理事件发生在列表读取期间的情况。179 项相关测试通过，完整客户端 TypeScript 编译通过；网页停止 Host 后重新启动，打开原会话无需切页即显示正确名称。最终 DMG 从只读挂载复制到源码之外，启动时同一旧会话先显示 ID，恢复完成后自动变为 E2E DMG，仍使用 glm-5.3-flash。

- 最终矩阵为 36 项：33 项通过、2 项部分通过、1 项外部阻塞。部分通过为独立重新生成按钮和真实 Channels 连接；签名、公证与云部署合同仍保留明确限制。

- 新 DMG 在仅系统 PATH 的独立安装目录中，资源 Agent 续问用时 8 秒，展开原生工具轨迹核对 `metaso_web_search` 的真实输出 total=41、size=10；回答同时包含本轮 Knowledge 的 SMOKE-KB-CANARY-2026 与 Memory 的 e2e-dmg-memory-20261007。新包图标 icns 与此前已目视验收的 Studio A 图标逐字节一致。
