# AgentKit Studio 端到端验收：2026-10-07

本轮按真实用户流程验收。单元测试、目录可见和构建成功均不能替代实际运行。
结果使用“待测 / 部分通过 / 通过 / 已复现待修复 / 外部阻塞”，每个通过项记录直接证据。
新建测试数据使用 `e2e-20261007` 标识，现有用户 Agent 和云端资源保持原内容。

目录状态的含义及部署边界见 [资源状态、删除与部署](resource-status-and-deployment.md)。
下表资源绑定证据针对实际测试样例，不代表目录中每个资源或预发部署已通过。

## 构建 Revision 与异步操作补验

- 修复 builds/create 给旧 Revision 套用最新 Agent 内容的问题。现在读取本地不可变 Revision；缺失版本、无效版本以及无法读取的云端历史版本均在入队前拒绝。Prompt、模型和资源引用随完整快照交给后台操作。
- 修复相同请求并发受理两次、排队取消后仍调用 runner、并发构建丢历史，以及重复构建不校验已有损坏 ZIP 的问题。已开始操作保留真实结果，不能假报撤销；当前不支持撤销已开始的构建。ZIP 的 spec 必须与 manifest 一致，即使篡改者重算 CRC 也会被拒绝。
- 348 项全量检查通过，新增七项覆盖真实文件存储的历史 Revision、非法/缺失版本、并发去重、排队取消、已开始操作的真实终态、并发历史、克隆快照与产物篡改。tarball 203 个文件完整性通过。
- 真实网页 Host 先创建测试 Agent r1（含 glm 模型与秘塔 MCP），更新 r2 Prompt 并去掉 MCP，然后用四个并发请求构建 r1；只得到一个 operation。下载 ZIP 核对 r1 Prompt/绑定完全一致，r2 复用请求标识与不存在的 r99 均被拒绝。
- 在原生会话点击该 r1 Build 的“在新会话运行”，仅询问秘塔官方文档搜索。真实 glm-5.3-flash 四秒完成，返回仅在 r1 系统提示词中的随机 BUILD 标记，没有返回 r2 的 DRAFT 标记；原生 metaso_web_search 输入/输出可展开，total=46。用户消息没有身份描述或预填标记。截图为 .artifacts/e2e-historical-build-mcp-20261007.png。
- 此轮证明 Agent 定义与绑定引用的冻结，没有把引用资源的可携带配置、Skill 文件、云端权限或凭证迁移记为完成。预发部署仍需要可携带运行产物、上传与协议适配。
- 包含本节修复的新 DMG 为 501889205 字节，SHA256 `62a0f6672c91df81abe545e843a45d034aa2bace9e6232e9e71ad435da73ac49`。官方打包、包内运行时与 Office 转 PDF 冒烟、镜像校验和只读挂载均通过；四份相关运行时文件及客户端与当前源码逐字节一致。包内 Node v24.21.0、Codex 0.159.2 均可直接执行，Studio A 图标摘要一致。此次仅验收新镜像内容，没有替换或重启用户正在使用的桌面 App；当前交付镜像以本节摘要为准。
- 打包重建共享 DSH 前端目录再次触发开发网页热更新空白，重启开发 Host 后恢复。打包与开发服务的输出目录隔离仍待修复，不将手动恢复记为该问题已解决。

## Codex 原生工具卡补验

- Codex 插件 MCP 和绑定动态工具现在写入 Studio 专属的非模型会话事件，经公开 Conversation Definition 投影为 DSH 原生工具卡。复用原生展开与输入/输出呈现，无私有状态注入或第二次工具执行。
- Host 重启验收发现仅有内存重放不足：未携带 ignorable 的外部事件会被官方磁盘读取拒绝。补丁 016 开放已有标记的写入选项，不修改 AgentLoop、静态事件清单或持久化类型。补充真实 zstd 文件写入、关闭、独立后端重开测试，成功、失败和取消三例均通过；DSH Session 79 项单测通过，持久化类型验证显示 changes 为空。
- 全量检查 341 项通过。固定 DSH 的真实 AgentLoop、Session 重放、Chat assembler 验证成功、失败和取消；每例 DSH 工具执行次数为零，结果单独加载的历史窗口也可恢复。该脚本的 Codex 输入流为测试数据。
- 网页真实 GPT-6-Astra 会话先用普通官方文档问题验证回复，再明确请求秘塔搜索。真实绑定动态工具 metaso_web_search 返回搜索参数、46 个结果的统计和网页摘要；原生卡可展开输入与输出。测试问题没有提示 Agent 身份或预填系统提示词答案。本项不外推为所有插件、全部富媒体或预发部署已验证。
- 再次在独立 CODEX_HOME 安装测试插件，真实 GPT-6-Astra 普通卡片查询调用 lookup_card(P7)；原生插件事件保留 cardId 和仅由 MCP 返回的随机校验值，最终答案一致，随后卸载。未修改个人插件或借助用户问题注入工具答案。
- 修复后新建无工作区 Codex Agent 会话，普通秘塔查询 18 秒完成；停止并重启网页 Host 后，原会话、Agent、GPT-6-Astra、回答和工具卡完整恢复。展开输入核对 q/scope/size/includeSummary，输出保留 total=46 和五条网页结果。截图为 .artifacts/e2e-codex-tool-restored-20261007.png。早期缺少标记的测试失败日志保留，未改写已有 Session。
- 16 个兼容补丁按顺序在固定基线的私有 Git 索引应用通过，未重置实际 DSH checkout；DSH 完整 lint、文档标准 21 项和 doc-sync 43 项通过。
- 包含本节修复的新 DMG 为 501855258 字节，SHA256 `a36df931b014c8f7ab403280b0eb6e70f5a293d0e485090ff16f186b26f29bee`。官方打包及包内运行时/Office 冒烟通过，镜像只读挂载校验通过；三份 Studio 运行时文件和客户端与源码逐字节一致，包内 Session 包含补丁 016。生产 manifest 正常裁剪开发脚本与 packageManager，DSH 客户端注入及 Codex 依赖保持一致。直接运行确认 Node v24.21.0、Codex 0.159.2，icns 与已目视验收的 Studio A 一致。此轮未替换或重启用户正在使用的独立桌面 App，不能将其当前窗口声称为新版本。
- 本阶段 Studio tarball 的 201 个文件完整性通过，16 个补丁格式通过。本文保留该产物作为历史证据，当前交付镜像以本文最上方最新补验摘要为准。

## Codex 插件执行与连接状态补验

- 复现原安装处理只检查进程退出、忽略 JSON 内容的问题。现在要求完整 pluginId 确认操作，保留授权策略和待授权连接器；异常结果只提示刷新检查，不自动重放安装或卸载。
- 官方固定 CLI 的真实 plugin/read 与 app/installed 查询确认：Gmail 可调用，Slack 未进入当前连接器运行快照。浏览器分别显示“可调用”与“未连接或未加载”，并提供官方授权/管理链接；未安装 Slack 或扩大任何连接器权限。
- 真实 GPT-6-Astra 在独立 CODEX_HOME 加载测试插件，用户只问“请查询测试卡片 P7 的当前状态。”，系统提示词不含身份、工具名或答案。MCP 服务端实际记录 lookup_card(P7)，模型回答包含工具生成的随机校验值；Studio 收到原生插件工具完成事件。插件安装、Skill 发现、实际执行和卸载全部通过，个人插件配置未改变。
- 修复 Codex 原生 mcpToolCall 开始/完成事件被 Studio 丢弃的问题；失败事件保留失败状态。本阶段先通过进度和 trace 展示；随后完成的独立原生工具卡见上节，不把两阶段证据混合。
- 本轮全量检查 338 项通过，新增覆盖连接器身份匹配、各类运行状态、读取失败、授权链接过滤、CLI 假成功和原生插件工具事件。网页截图为 .artifacts/e2e-codex-callable-20261007.png 与 .artifacts/e2e-codex-auth-required-20261007.png。上一轮 DMG 仍对应 c261a2a 的运行时代码，本节新增功能尚未重新打入 DMG。

## 运行资源与 Codex 目录补验

- 运行资源页原先先请求不存在的聚合 REST 接口，导致已经可用的分类 Action 也无法展示。现在通过 Host 汇总与 Agent 编辑页相同的五类目录；单类失败保留其他结果，并按类说明失败或截断。
- 浏览器实际显示模型 66、MCP 3、Skill 10、知识库 8、记忆库 10，未出现旧 REST 合同错误；保留 mcp_test 的真实探测失败状态，没有将目录读取成功当作全部资源可用。
- Codex 目录改为公开 App Server plugin/list，复用官方展示名称、图标、精选和安装限制。真实页面显示 27 个已安装、23 个精选；其余未安装目录 5391 项，首批 24 项，点击查看更多后变为 48 项。搜索 Slack 得到唯一条目，详情显示正确插件 ID、市场及版本。
- 本机截图为 .artifacts/e2e-runtime-catalog-20261007.png 与 .artifacts/e2e-codex-catalog-20261007.png。完整调用链、固定版本、包内依赖以及授权边界见 [Codex 插件与桌面依赖](codex-plugin-runtime.md)。
- 使用已有真实 DMG 内的 Codex 二进制和独立 CODEX_HOME，再次完成测试插件安装、已启用确认、App Server skills/list 加载与卸载。未修改个人插件，未把该测试外推为所有外部连接器已授权。
- Studio 全量 333 项检查通过。新增回归覆盖聚合目录部分失败、目录截断、正确的 Host 路由、CLI 可用插件参数与输出上限、官方元数据投影及安装限制。网页验收不代替桌面更新或预发部署验收。
- 随后完成包含 c261a2a 运行时代码的新 DMG：501811229 字节，SHA256 `defd96bb9353e924f84e403018cebe277e41e9ff5ada3e973f28c99fdfdb9f77`。官方打包流水线、运行时依赖与 Office 转 PDF 冒烟通过；只读挂载镜像校验通过。客户端和 7 个相关运行时文件与源码逐字节一致，Studio A 图标摘要保持不变；镜像内直接执行确认 Codex 0.159.2、Node v24.21.0。
- 桌面打包重建开发 Host 共用的 DSH 前端文件时触发热更新空白，重启开发 Host 并刷新后恢复；再次读取官方插件目录成功。正在使用的独立桌面 App 未重启、未替换，仍运行旧版；新 DMG 的此次验证不声称用户当前窗口已更新。

## 资源状态与 MCP 删除入口补验

- 真实网页读取 3 个本地 Skill 和 7 个云端 Skill Space；分别显示“本地已导入”和“云端目录可见”，云端条目不再错误调用本地文件预览。
- MCP 页面真实显示秘塔“探测通过”、mcp_test“探测失败 / MCP_TLS_FAILED”、local_mcp_demo“云端运行中”；这三种状态不混同为工具执行成功。
- 本地条目显示“移除配置”，云端条目显示“删除云端 MCP”。实际打开云端删除确认并取消，原资源仍在目录中；没有删除用户现有云端资源。
- 删除处理通过真实本地 HTTP 服务测试验证 DeleteMCP 路由、Id 参数、账户与认证头、成功确认、失败不重试和缺失本地记录不回退云端。此证据不等于真实云端 DeleteMCP 已验收。
- 本轮资源界面变更已在网页运行；用户正在使用的桌面进程仍是上一版安装包，尚未包含这些新增标签和删除入口。

## 冻结运行入口的 DMG 补验

- 基于 76bc358 的官方离线打包流水线成功，DMG 为 501793311 字节，SHA256 为 `028f7bb3c7d73d49aae0e4225b6fb89a8158f82c056da46531c017f8f3494f58`。只读挂载后复制到源码目录外的独立安装目录，四个运行入口模块与源码逐字节一致。
- 包内 Node 实际为 v24.21.0，icon.icns 与已目视验收的 Studio A 一致。新 Profile、仅系统 PATH、外部服务不可达配置下仍打开完整 Studio 页面；不等同于干净系统账户或云端资源离线可用。
- 同一独立 App 联网后，冻结 MCP Build 经认证 HTTP 入口真实调用 metaso_web_search，原生会话为 runtime-f3a7cca6605dfb2cad8bd11b59c0fba3，返回官方 5028、45345、45163 文档链接。监听进程来自独立 App 包，非开发网页 Host。
- 该 DMG 不包含本轮随后新增的资源状态与删除界面修改；未将本机冻结运行入口记为预发部署通过。签名、公证及可携带云端部署仍未验收。

## 验收矩阵

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
| C04 | 取消生成、重试、刷新与历史恢复，不误报成功或重复回答 | 部分通过 | 长回答停止与后续继续成功；编辑到 r2/r3、Host 重启后原 r1 Session 仍回复旧身份。原生“在新对话中分支”实际生成新 Session 并保留历史、Agent 和 glm 模型，分支继续使用原 r3 Prompt。网页已实测连续两次 503 后同一轮恢复，原生页面显示重试次数。独立重新生成按钮未在当前原生页暴露，未声称完成该按钮验收。 |
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
| B02 | 部署入口对应真实合同，失败清晰且不生成虚假就绪记录 | 通过 | 本地构建后云部署按钮禁用，无新增虚假就绪记录。后续源码复核确认 Server 已有 CreateAgentProduct/UpdateAgent 部署能力；本地 Studio Build 尚未完成产物转换、上传与部署适配，页面改为说明这一实际限制。此行只验收禁用与错误边界，不代表云端发布通过。 |
| O01 | Studio 自动化创建、编辑、启停、手动运行和执行历史 | 通过 | task-d52e9177 手动运行成功并有原生 Skill stdout；实际 60 秒计划 task-92e195c3 在 13:38:49 触发，13:38:51 完成，occ_8dc6863fe1964b51914cb5f051008e15 与 Session/Run ID 一致。两项测试任务最终暂停。一次性空时间与时区编辑修复另有回归检查。 |
| O02 | DSH 原生自动化任务目录及任务详情 | 通过 | 独立 DMG App 通过官方 schedule_create 创建一次性提醒 schedule-ab20de53-eae3-4bf8-823a-d86582bcc431，14:18 实际投递 E2E-DSH-SCHEDULE-20261007；原生任务详情显示执行记录和结束状态，无循环任务残留。 |
| O03 | 运行后 Trace 列表、详情、筛选和导出可用 | 通过 | 真实 Trace 列表、详情、Agent/Run 筛选与合法 OTLP 投影已验证。桌面经官方 DSH Session 日志 API 和 macOS 保存面板导出 43250 字节、28 条合法 JSONL，SHA256 053a09b96607055cc57999f4b8b270ff3aa2c08f2a3bb562c6c7729772fa86e5。投影 Span 不是完整原生工具 Span；完整事实另由导出的 Session 日志提供。 |
| O04 | 评测集导入、目标选择、真实运行与结果详情 | 通过 | 真实导入 e2e-frozen-build-20261007，选择冻结 Build 并实际执行；eval_97cf683487014b0180e7f8390e5fd704 返回旧 r1 身份，两个断言通过，最终页面显示用例 1/通过 1/失败 0/断言 2。A2A 和本地源码目标仍明确未接入。 |
| O05 | Channels 配置与平台消息链路 | 部分通过 | WPS 发布机器人使用用户提供的凭证完成真实消息收发，OAuth、WebSocket 入站、原生会话执行与平台回复均通过。相同普通问题的 Harness / DSH Native / Codex 系统提示词盲测及绑定即时切换通过，见下方补验；本地续聊、重启去重、超时取消和离线拒绝已有直接证据。飞书、企业微信的外部消息收发未验收。 |
| O06 | Channels 控制面创建、编辑、连接地址与删除 | 通过 | 浏览器连接独立 SQLite 的真实 Channel API；创建飞书测试配置 44d31039f1174823，编辑 Agent、保留空白凭证输入对应的原值，读取连接地址并删除后目录回到 0。无渠道 Worker、无外发消息，占位平台凭证仅用于控制面合同验证。 |
| D01 | 固定 DSH 基线和兼容补丁、Studio 包及 Profile 完整性 | 通过 | 最终 Studio 303 项检查及 176 文件包完整性通过；14 个兼容补丁在固定基线私有索引按顺序应用成功。最新桌面启动、语言与 Profile 测试共 180 项通过、1 项平台跳过，相关源文件 lint、桌面 Host TypeScript 和 1158 对双语文档配对检查通过。早先 Session 模型合同 26 项、Markdown 200 项（含逐字流式更新）也通过。六项既有 DSH 文档同步失败已在后续补验中修复，最新全量 43 项通过，详见下方。 |
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

- DMG：`AgentKit-Studio-0.0.1-mac-arm64-local.dmg`，501827352 字节（478.58 MiB）；SHA256 `ab0342881f996aecd53018823225b2bde75f862fa37f564cbbf409d829ddd626`。这是本机 arm64 未签名验收包。
- 最终 App 已由 DMG 只读挂载后复制到源码目录之外。包内 local-runtime 源码与本轮最终源码 SHA256 一致，303 项检查与 183 个跟踪文件的可分发路径检查通过；最终 tgz 的 176 文件包完整性通过。
- 最终包恢复旧 r1 对话后继续返回 E2E-DESKTOP-PERSONA；r2 资源会话与包内 Codex 的实际续问成功。用户已有 Agent 配置未被测试改写，测试自动化均已暂停或结束。
- 实际图标从最终 App 的 icon.icns 导出，品牌为 AgentKit Studio A；旧版已安装应用不会仅因更新源文件自动改变。本轮保留旧版 0.8.5 的 AgentKitStudio.app，另将已验收的新包安装为 AgentKit Studio.app。
- 未完成项：飞书和企业微信真实消息收发、本地 Build 的云端产物与部署适配，以及 macOS 签名和公证配置；部署适配是 Studio 实现缺口，不能归为缺少独立 Deployment Action 的外部阻塞。内嵌浏览器 ZIP 下载已补验；原生重新生成按钮仍未验收。

## 原生链接与插件流程补验

- 新 DMG 经完整官方 build:official、release:pack 和桌面流水线重新生成，包内网页 index.html 与当前构建产物完全一致；重新挂载、复制和启动后重放真实回答验证链接修复。
- Codex 插件空目录的“添加 Codex 插件”实际打开安装表单；DSH 搜索不存在名称显示“没有匹配的插件”，清空搜索恢复真实列表。
- 网页旧 Profile 插件安装与卸载均经界面成功，Host 显示测试插件 0.0.2 已加载；测试插件已卸载。Profile 的同版本开发包通过官方 CLI 强制刷新，安装后的 dist/client.js 与当前打包文件 SHA256 一致。
- 本次补验前矩阵为 35 项：31 项通过、3 项部分通过、1 项外部阻塞。后续下载与冷启动补验记录见下方。

## 下载与开发安装补验

- 网页 ZIP 使用 DSH 公开 `connection.fetch.register` 的 GET/HEAD 文件响应；保持异步 RPC 预检，浏览器实际下载成功，确认问题来自 Blob 下载路径。没有新建旁路服务或放宽认证。
- 同版本、同路径 tarball 的官方安装曾返回成功却保留旧客户端 SHA256；内容摘要路径安装后逐文件与 tgz 核对通过，新增回归拒绝同版本旧内容。
- 十二号兼容补丁为公开预设目录增加变更事件，并处理事件发生在列表读取期间的情况。179 项相关测试通过，完整客户端 TypeScript 编译通过；网页停止 Host 后重新启动，打开原会话无需切页即显示正确名称。最终 DMG 从只读挂载复制到源码之外，启动时同一旧会话先显示 ID，恢复完成后自动变为 E2E DMG，仍使用 glm-5.3-flash。

- 当时矩阵为 36 项：33 项通过、2 项部分通过、1 项外部阻塞。部分通过为独立重新生成按钮和真实 Channels 连接；签名、公证与云部署合同仍保留明确限制。

- 新 DMG 在仅系统 PATH 的独立安装目录中，资源 Agent 续问用时 8 秒，展开原生工具轨迹核对 `metaso_web_search` 的真实输出 total=41、size=10；回答同时包含本轮 Knowledge 的 SMOKE-KB-CANARY-2026 与 Memory 的 e2e-dmg-memory-20261007。新包图标 icns 与此前已目视验收的 Studio A 图标逐字节一致。

## 模型故障恢复补验

- 最小复现经过真实 DSH AgentLoop、Session、llm-retry 和 Studio 传输：503 后原先只请求一次，未记录重试。原因是 Studio 丢失错误分类，并在公开流扩展层抛异常，绕过模型失败结束事件；文本 Agent 又按资源数量切换到了旧路径。
- 本地 Harness 统一使用原生模型步骤，Studio 保留有界错误事实并输出公开 LlmFailure；仍由 DSH 执行策略、退避、取消和持久化。不对云端 RunAgent、Codex 或独立整轮适配自动重放。
- `node scripts/verify-dsh-runtime-retry.mjs` 的 8 个合成故障场景通过：503 恢复、401 终止、429 配额终止、等待重试时取消、独立整轮不重放、重试上限、工具后续请求恢复、失败半截输出隔离。其中工具执行后 503 再恢复，工具只执行一次；全部重试保留同一用户轮次。
- 网页真实创建 E2E 故障恢复 Agent，选择本地合成网关模型后发消息，页面显示“正在重试模型请求（1/5）”，两次 503 后第三次请求成功，Agent 和模型未改变。合成故障注入只证明恢复机制，不是云端可用率证据。
- 新 DMG 重新挂载、复制到独立安装目录，在仅系统 PATH 下创建 ar-local-a077760db8cf4803（AgentKit Harness）。实际请求记录为 503、503、200，原生页显示已重试 2/5、同一轮完成；展开“已完成分析”可见模型的测试推理文本。四个变更运行时模块与包内 asar 逐字节一致，icns 仍为已验收的 Studio A。
- 网页和 DMG 均在 8 秒退避期间点击“停止生成”，页面显示“模型请求重试已取消”，网关计数各为 1；网页 401 只请求一次并显示 AUTH。刷新网页后成功、取消和认证失败记录仍保留，未被重写为成功。
- 同一最终 DMG 的全新资源会话使用 E2E DMG r2 和真实 glm-5.3-flash，17 秒完成秘塔搜索。展开原生工具输出确认 total=45、size=10、首条官网文档为 `https://docs.ksyun.com/documents/45345`；真实记忆召回 `e2e-dmg-memory-20261007`。本次 Knowledge 命中两个 smoke_kb_test.md 片段但未包含指定 canary，回答如实说明没有命中；本轮未调用绑定的 Skill，Skill 的实际执行证据仍以上述脚本验收为准。
- 全量检查中捕获原有耗时 fixture 的 1 毫秒竞态，改为用同一时间基准计算开始与结束；没有放宽时长断言。


## 正常桌面安装与升级补验

- 将最终 DMG 安装到 macOS Applications，再通过系统应用启动，不使用测试启动脚本、不额外注入模型或 MCP 凭证。原先只显示 DSH 插件入口；已有 Desktop Profile 只有基础 bundle，初始化没有补入 Studio。十三号补丁为已有 Profile 加入首次遇到的产品默认项，并记录已应用的默认项，保留后续用户或恢复操作的禁用选择。
- 真实旧 Profile 升级后出现 Studio 总览、Agents、资源库与运行中心。原依赖声明、pnpm workspace 和锁文件保持不变；Studio 加载后的原生模型/界面设置同步会更新用户 patch，未将此文件声称为全程逐字节不变。升级阶段保留用户 patch 的行为由真实 DesktopProjectManager 回归覆盖。
- 正常启动后选择小红书营销文案大师，真实 glm-5.3-flash 在 2 秒内回复正确名称、职责和收纳标题；续问通过 metaso_web_search 返回 total=35、size=10，原生思考、工具输入和输出均可展开。
- 本地 Make 打包现在自动导出 Studio 命名的 DMG、SHA256 文件和 JSON 摘要。实际完整流水线成功后，导出文件与官方产物摘要一致；挂载时磁盘镜像校验通过，安装后的 icns 与已目视验收的 Studio A 图标一致。
- 补丁检查改为在私有临时索引中依次应用，14 个补丁在固定基线全部通过，工作目录和暂存内容不变。Make 回归复现并修复了旧下载包、缺失产物误报成功，以及依赖前序改动的补丁被误拒绝的问题。
- DSH Profile 测试 39 项通过、1 项平台跳过，启动、语言、品牌与打包阶段测试 141 项通过；相关源文件 lint、桌面 Host TypeScript 编译、937 个 Client UI 文件的文案检查及 1158 对文档配对检查通过。全量 doc-sync 为 37 项通过、6 项失败：旧补丁对应的事件图、Cordis 目录、持久化目录及历史未同步，已有 SessionFilter 导出缺少 JSDoc，调试备份目录触发仓库引用检查。本次双语配对、Markdown 链接、文档预算通过；未把全量文档门禁记录为成功。

- 最终品牌复验发现 Electron 的 app.name 仍是内部包名，而官方 build:official 会重置客户端标题。十四号补丁将产品名经桌面专用构建值传到现有原生语言字典；不修改 Electron 数据目录。最终 asar 主程序与构建输出 SHA256 一致（a84638231404fc44be7a017de7eedf80aeefd1ab3cf9423c6fe5d0b231f42689），产品名已固定为 AgentKit Studio。
- 从最后一版 DMG 重新安装后，通过系统正常启动，实际菜单显示“关于 / 隐藏 / 退出 AgentKit Studio”，“关于”窗口同时显示 Studio A 图标和产品名称。旧会话、Agent 名称及 glm-5.3-flash 模型恢复；再次搜索 2 秒完成，展开原生 metaso_web_search 记录得到 total=29、size=10，回答链接为 docs.ksyun.com/directories/5028?type=1。
- Web 重启后总览读取 23 个 Agent、4/4 就绪；选择总览再刷新仍停留在总览。最终桌面截图保存在本机 .artifacts/e2e-applications-brand-20261007.png 和 .artifacts/e2e-final-applications-mcp-20261007.png。

## 兼容合同与渠道控制面补验

- 十五号补丁补齐 SessionFilter/registerSessionFilter 的 JSDoc 和双语使用说明；事件图、Cordis API 目录和持久化目录均由官方生成器更新。62 个持久化根类型摘要逐一相同，没有改写冻结的持久化历史。原先的调试构建备份移出 DSH 文档扫描范围并保留。
- 官方 `pnpm run test:docs` 21 项、`pnpm run doc-sync` 43 项全部通过；`pnpm run lint:contracts-ready` 全量通过。相关 ui-workspace 测试 69 项、tool-cordis Host 测试 1 项通过；15 个补丁在固定基线私有索引按顺序应用成功。
- 接通真实 Channel API 后，原表单创建会因缺少 AppId/AppSecret 返回 422，错误文案退化为对象字符串；不存在的渠道返回 HTTP 200/Code 404，却被旧代理当作成功。本轮补齐必填凭证、业务错误码和响应格式校验，校验错误只显示字段名。
- 连接不再强制工作区，保存后自动刷新目录；凭证已有状态读取正确。编辑不发送空白密钥和不支持修改的渠道身份字段；创建不再发送服务不支持的 Enabled 字段。浏览器完成实际新增、编辑、连接地址读取、删除，独立数据库确认密钥未被空白覆盖且删除为服务的软删除。
- 最新 Studio 检查为 306 项通过。矩阵扩展至 37 项：34 项通过、2 项部分通过、1 项外部阻塞；未把控制面验收等同于外部渠道消息投递。
- 复核服务端当前源码及已有 cloud-api-gap.md：CreateAgentProduct/UpdateAgent 能触发 Code/Container/ManagedRuntime 部署，缺少独立 Deployment Action 不等于没有部署能力。已修正页面归因；本地 Build 到云端产物的适配仍未完成，本轮没有创建云端计算资源。
- 最终本机 DMG 再次通过完整官方流水线，包内 Node 24.18.1、原生模块及 Office 转 PDF 冒烟通过。实际从 DMG 更新 Applications 内的产品 App，Channels 创建 8f617266dc0b4837、编辑并删除成功；已有小红书会话与模型恢复。安装后的客户端和渠道模块与当前源码逐字节一致，图标摘要与已验收的 Studio A 相同，原生“关于”显示 AgentKit Studio。

## WPS 真实接入准备

- 已在用户授权的 Chrome 登录态中通过 WPS 官方快速应用页面创建“AgentKit Studio 验收助手”，后台确认应用存在，头像为 Studio A。当时查看 App Secret 触发平台验证码，尚未取得密钥；随后用户直接提供凭证，真实消息验收结果见下方。
- Channel 源码复核发现 WPS 企业 ID 被用作 AgentEngine 租户 ID，服务端又在精确匹配失败时跨账号兜底。两个账号具有相同渠道标识时可复现选错配置。本地修复让适配器使用配置所属账号，显式账号只允许精确匹配，无账号的旧调用仅允许唯一结果。
- Channel 的六个新增回归覆盖事件身份、外部字段覆盖、跨租户重名与旧调用唯一性；修复前五项失败，修复后包含飞书、企业微信和网关在内全量 278 项通过。此处仍为隔离 SQLite/ASGI 验证，不能替代新机器人的真实消息测试。


## 本地渠道与原生会话补验

- 对照独立 Channel Gateway v1 和 DSH 公开 Session API 后，补入 Node 出站连接，不复制 Worker、原生循环或聊天界面。新增 `ws` 依赖随插件和桌面 package set 打包；账号、工作区、Agent 注册身份严格校验，凭证仅保存在 Host 的 0600 配置文件中。
- 隔离 Channel API 使用真实 WebSocket 路由，真实 DSH Web Host 执行两条输入：同一原生 Session 保留 E2E 故障恢复 Agent 与 e2e-desktop-local 模型，页面显示两轮两步。模型为本机故障注入网关，此项不作为外部模型或 IM 平台成功证据。
- 重复第一条请求没有新增轮次。停止并重新启动 Web Host 后再投递同一请求，仍返回第一轮答案，页面保持两轮；结果读取依据持久化 requestId，未错取最近一轮回答。
- 三秒截止时间中止真实 DSH 正在等待的八秒模型退避；网关返回 HTTP 409 / deadline_exceeded，原生会话显示“已停止”和“模型请求重试已取消”。UI 停用连接后，网关返回 HTTP 409 / no live connector，不创建替代云端运行。
- 通过网页表单创建隔离测试渠道，服务数据库确认 ConnectorWorkspaceId 自动保存为配置的逻辑工作区；测试行最终经 DeleteChannel 软删除。本地 Agent 下拉与列表名称展示避免用户复制内部 ID；工作区 ID 不绑定文件目录。
- 315 项 Studio 检查通过，新增回归覆盖心跳并发、取消、过期请求、断线不重放、HTTP 认证拒绝不重试、原生历史分页和冻结身份、配置隔离以及连接凭证切换清空。这一步只验收本地网关；后续获得凭证后的真实 WPS 结果单独记录在下方。

- 从本轮 DMG 更新 Applications 下的 App 后，使用界面选择“小红书营销文案大师”。无效凭证实际显示“连接失败 / 凭证无效或已过期”；替换为隔离网关的有效凭证后恢复“已连接”。真实 Gateway 交付一条输入，包内 Node 执行真实 glm-5.3-flash，三秒返回正确助手名称与家居收纳标题。桌面原生会话显示该 Agent、原模型、只读权限，并位于未分组；没有要求绑定文件目录。此项使用真实模型，仍未经过 WPS 平台消息服务。
- 安装版渠道编辑器通过名称选择填入正确本地 Agent ID。验收结束后两个本机测试连接均已通过界面停用，没有保留自动接收消息的测试连接。部署页禁用按钮的旧“等待云端合同”文案也改为“云端发布未接入”，与已有接口和实际实现状态一致。

- 最终 DMG 摘要已更新到上方产物记录；从只读镜像更新 Applications 后，五个运行时模块和 `dist/client.js` 均与当前源码逐字节相同，包内 `ws` 为 8.21.0。icns 保持已验收的 Studio A。完整官方打包与运行时冒烟、Studio release-check（315 项测试、15 项补丁格式、183 个包文件）通过；本机包仍未签名和公证。

## WPS 真实消息与系统提示词盲测补验

- 使用用户提供的现有 WPS 应用凭证，OAuth HTTP 200，官方发布审批已通过。凭证仅存在本机私有验收配置中，报告和测试源码不包含密钥、Token 或个人会话 ID。
- 三个独立测试 Agent 使用不同系统提示词标记与运行时；用户输入固定为“周末想去苏州玩两天，预算800元，帮我安排一下。”，不出现角色名、标记、JSON 格式或任何自我介绍要求。只有系统提示词规定 route_tag、两项 days 和整数 budget。早期让模型自报身份的记录仅保留为历史行为证据，不能单独作为系统提示词生效证明。
- Harness A 实际回复 PINE-73、两天行程和 budget=800；DSH Native B 实际回复 RIVER-29、两天行程和 budget=800。均由 WPS 原生客户端发送，通过真实 Channel Worker / API 到 DSH 原生 Session，再由真实 GLM 返回并通过 WPS 回复 API 投递。
- 重现并修复渠道改绑后仍沿用旧 Agent ID、消息被跳过的问题。Worker 对配置变化重建平台连接；每条事件还携带服务配置 ID 与可信租户，服务端即时解析最新绑定，避免等待下一次轮询。2026-10-07 20:34:37 入站、20:34:40 收到新 Agent 回复，20:34:55 才发生连接轮询，证明保存后立即生效。
- Codex 首轮原生会话 73 秒完成，输出独有 MAPLE-61，但渠道客户端沿用 30 秒 HTTP 超时，提前向 WPS 返回错误。已统一执行预算与 HTTP 读取期限，保留 CRUD 的短超时，并用实际延迟 HTTP 服务验证。修复后再次发送完全相同的问题，Codex 原生页显示 47 秒完成；20:39:13 入站、20:40:01 Gateway 成功返回、20:40:02 WPS 回复 HTTP 200 且 outbox=delivered。原生页与 WPS 同时显示 MAPLE-61、两项 days、budget=800，模型保持 GPT-6-Astra。数据库中的三种标记回复均可解析为合法 JSON。
- Channel 新增即时绑定、信任边界、配置重载和超时回归；全量 302 项通过（9 项依赖弃用或已有 mock 警告）。此处 Channel 为独立服务修复，未向离线 Studio App 增加 Python 依赖。

- 收尾实际复现“停用渠道后目录变为 0 条”。Channel 将停用与软删除分成独立状态；网页重新验收 disabled 仍列出、同一行重新启用成功，最后停用但保留配置。迁移保留旧库原来隐藏的记录，不自动恢复以前删除的机器人；SQLite 旧表升级与二次启动回归通过。最终三个盲测连接均由界面停用，会话和消息证据保留。

## 冻结 Build HTTP 运行补验

- 新入口通过公开 DSH Session Controller 和 AgentLoop 执行冻结 Build，HTTP 只负责认证、请求身份、事件转发和取消。使用说明与部署边界见 [运行合同](frozen-build-runtime.md)。
- 盲测用户消息只有“周末想去苏州玩两天，预算800元，帮我安排一下。”，不提示身份或输出标记。测试 Agent r1 仅在系统提示词规定 BUILD-47；构建后草稿 r2 改为 DRAFT-92。运行 build_c7e0124273a8f0b155d4 仍返回 BUILD-47、两项 days 和整数 budget=800，原生页面显示 Revision 1、原绑定 glm-5.3-flash，无文件工作区。
- 实际 SSE 共 233 个事件，其中 226 个原生 AssistantStreamFrame；首帧 88 ms，完成 3449 ms。重复请求返回同一持久化 runId 和相同答案，原生页仍只有 1 轮；同一 requestId 改内容返回 409。
- 收到真实模型片段后调用取消，HTTP 终态为 RUNTIME_CANCELLED，无 run.completed；随后同一会话新请求成功，仍使用冻结 Prompt。原生页面可展开运行详情及模型返回的分析内容。
- 资源 Build 启动实际复现 Duplicate agent preset：恢复和准入同时越过缓存检查，各自探测资源后重复注册。增加同一 preset 的进行中注册共享，失败释放以允许重试；回归先失败后通过，真实 Host 重启后入口启动成功。
- build_7e3930d82249af527bf4 实际执行 metaso_web_search，返回 total=33、size=10，包含 docs.ksyun.com/directories/5028?type=1、documents/45345、documents/45163；工具结果和回答均写入原生历史。网页展开工具输入/输出成功；截图保存在本机 .artifacts/e2e-build-mcp-native-20261007.png 和 .artifacts/e2e-build-frozen-blind-20261007.png。
- 325 项全量测试通过。新增范围包括 HTTP 认证与大小限制、流式与取消、失败脱敏、已有请求精确历史定位、重复/冲突以及并发资源注册。
- 本项证明已有 Host 能消费冻结 Build；单独携带 DSH 的云端产物、配置注入、上传和部署生命周期仍未接通。没有因此创建云端付费资源或虚假部署成功记录。
