# AgentKit Studio 分阶段重构方案

按生命周期、原生会话列表收敛、前端模块化、Host 拆分、补丁收敛的顺序实施。每阶段交付可独立验证和回退的改动，上一阶段验收后再切换下一阶段的实现。

维护性的改善来自三个结果：状态有明确的所有者和释放时机，跨模块依赖通过接口表达，宿主修改有合同和退出条件。文件数量、单文件行数和补丁数量只作辅助指标。

## 基线与目标边界

方案基于 Studio 提交 `ae05571`，DSH `0.2.0-rc.2`，上游提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。架构检查的本地结果为 671 项测试通过、1 项跳过；31 个补丁能顺序应用到固定基线。涉及 130 个不同文件，包含文档和测试。上述结果不代表各阶段已经实施或桌面安装更新已经验收。

DSH 继续负责 Session、Agent 生命周期、持久化、工具注册和原生会话 UI。Studio 负责 Agent 编辑、资源绑定、构建、部署及产品页面。各 Runtime 适配器负责协议差异，凭证和进程保持在可信 Host。前四阶段保持现有 Session 格式、Agent Revision 和 Build 身份、公开包导出以及 RPC 路径；本轮侧栏不增加额外会话绑定查询。

| 阶段 | 优先级 | 主要交付 | 前置条件 |
| --- | --- | --- | --- |
| 1 生命周期 | P0 | 注册释放修复和 Host scope 内的 RuntimeBridge | 固定基线并记录现有行为 |
| 2 原生会话列表 | P0 | 取消自动 Agent 过滤，删除 007，完全复用 DSH 列表 | 阶段 1 验收 |
| 3 前端模块化 | P1 | ES Modules 源码及单脚本 DSH 入口 | 阶段 2 验收 |
| 4 Host 拆分 | P1 | 按领域组织的服务、路由及共享合同 | 阶段 3 验收 |
| 5 补丁收敛 | P2 | 补丁清单、产品配置接口及宿主兼容 CI | 阶段 4 验收 |

各阶段应同步增加自己的行为测试，宿主集成测试从阶段 1 开始建设，不能等到阶段 5 才验证。阶段 5 再把兼容性报告和上游升级流程完整接入 CI。

## 阶段 1 生命周期

### 改动范围

主要修改 [Host 入口](../src/index.mjs)、[Runtime 桥接](../src/providers/dsh-runtime.mjs)、[预设作用域插件](../src/providers/dsh-runtime-plugin.mjs)、[预设注册绑定](../src/preset-registry-binding.mjs) 和 [本地资源适配器](../src/local-resource-adapters.mjs)。必要时调整 Codex Runtime 的取消与退出衔接。

先做一个真实 Cordis scope 验证：确认 Host 提供的服务可被预设子作用域访问，并明确 Host、注册表和 Agent 子作用域分别拥有哪些注册。服务不可见或尚未就绪时返回明确错误，不回退到进程全局单例。

建议拆成两个 PR：

| PR | 实施内容 | 独立交付 |
| --- | --- | --- |
| 1A 注册清理 | 将 `setDshRuntimeAdapter`、`setDshResourceToolExecutor` 的 disposer 接入所属 `ctx.effect`；释放 Host 创建的资源适配器；处理初始化晚于卸载的情况 | 修复释放缺口，保持现有导出和调用路径 |
| 1B 作用域服务 | 增加 `src/host/runtime-bridge.mjs`，由 Host 提供 `studioRuntimeBridge`；将 adapter、工具执行器、session route 和请求取消归入对应 scope | 原有导出作为兼容入口转发至明确的所属实例，内部调用迁移到服务 |

RuntimeBridge 的每次注册返回幂等 disposer，记录作用域代次。旧注册的延迟清理不能删除新注册；旧异步任务也不能在卸载后重新发布状态。Session 路由按 Host 和 Session 隔离，Agent 子作用域只释放自己创建的路由。

迁移前盘点旧导出的调用方。兼容入口通过增量参数或所属 context 解析桥接实例；若旧签名只能在单 Host 下使用，应明确限制，多 Host 下无法确定归属时返回错误，不能静默选择某个全局实例。

Host 退出先停止接收新任务，再取消自己拥有的请求，最后关闭 MCP transport、临时代理、监听器及子进程。沿用 DSH 的公开取消合同和 Codex 已有的退出逻辑，明确关闭超时与兜底处理。对 DSH 拥有的 Agent 不另建一套生命周期。

### 验收标准

- 在同一真实 Host 连续挂载、卸载 20 次。全部所属 scope 结束后，Studio 新增注册、路由、订阅、定时器和 transport 数量回到初始值；重复卸载无异常。
- 同时挂载两个隔离 Host，并创建相同 Session ID。adapter、工具执行器和路由互不覆盖。
- 验证旧 scope 在新 scope 建立后才清理、初始化在卸载后才完成、注册失败后重新启用三种时序；新实例仍可执行，旧实例不能复活。
- 请求执行中卸载插件，取消能传到该请求的 adapter、工具或子进程；待处理请求结束一次，资源最终释放，其他 scope 的会话不受影响。
- 重启后仍能恢复动态 preset；资源暂时不可用时保留历史会话并返回原有明确错误。
- DSH Native、Harness、Codex 的两轮对话、工具调用和取消通过适用的真实 Host 验证。受控 provider 只能证明 Host 集成，真实 provider 结果单独记录。

新增测试覆盖 scope 生命周期和异步竞争，复用 `preset-registry-binding`、`preset-recovery`、`dsh-runtime-continuation` 及 Codex 取消相关测试。真实 Host 校验必须经过插件加载和作用域销毁，单独调用 setter 不足以验收。

### 回退

两个 PR 保持同一持久化和导出合同，可分别回退。先保留 1A 的释放修复，再回退 1B 的服务迁移；禁止用取消释放或重新引入裸全局状态掩盖失败。

## 阶段 2 完全复用 DSH 会话列表

2026-10-14 按用户选择调整：默认完全复用 DSH 列表，取消按当前 Agent 自动过滤。当前会话的 Agent 执行绑定保持原有公开 preset 选择路径。原 2A/2B 的过滤版本、权威绑定查询和过滤缓存同步不再作为交付项。

### 改动范围

删除补丁 `007-sidebar-session-filter.patch`；从补丁 015 删除对应源码、双语文档和生成文档哈希变更。删除 Studio 选择器、原生创建入口及插件挂载中的自动过滤调用与全局状态。会话缓存可以继续服务于当前会话的显示兼容，不能改变列表可见性或替代执行绑定。

DSH 继续拥有分组、平铺、搜索、归档、排序、当前空白会话和 subagent 规则。保留 017 的未分组新会话和 018 的取消工作区保留 Agent 行为；这些补丁解决独立产品需求。本轮补丁由 34 项减为 33 项，保留历史编号。

### 验收标准

- 选择 A、B 或不使用 Agent，不会隐藏其他 Agent 的历史会话；不需要额外消息或刷新。
- 分组、平铺、归档和搜索结果遵守 DSH 原有规则；当前空白会话、无 Workspace、取消 Workspace 及已删除 Agent 历史可见性不受 Studio 缓存影响。
- 清空或伪造会话 Agent 的 localStorage、页面重开和断线重连，不改变列表成员；执行绑定仍来自 DSH 持久化 preset。
- Studio 不注册过滤 predicate，不读取缓存来过滤列表，不持有过滤全局 setter 或额外过滤订阅。
- 在固定 DSH 基线顺序应用剩余 33 个补丁，构建官方 Web/Host，并运行受影响 workspace/session 测试；验证真实 Web 和 Electron 开发宿主中的选择、历史列表、搜索及归档。

### 回退

可回退为上一版 Studio 包和配套补丁，但旧缓存不能被描述为权威归属。如未来确有多 Agent 检索需求，先设计用户主动开启的筛选入口，再评估是否能复用 DSH 的公共查询能力；不恢复选择 Agent 自动隐藏历史的行为。

## 阶段 3 前端模块化

### 改动范围

将 `src/client-fragments/` 的顺序拼接迁移到 `src/client/` 的显式导入导出，修改 [构建脚本](../scripts/build-client.mjs)、[客户端入口](../src/client.js)、源码约束和相关测试。`dist/client.js` 继续是 DSH 加载的一个脚本，保持唯一 ModuleLoader 注册和当前 module ID。

目标目录为：

```text
src/client/
  entry.mjs           DSH ModuleLoader 与插件挂载
  dsh/                slots、模型目录和原生会话适配
  remote/             Host 客户端与传输适配
  state/              当前会话绑定、选择和产品导航状态
  components/         表单、确认框、表格及通用组件
  pages/              Agent、资源、部署、自动化及设置页面
```

建议分为 3A 状态与 Host 客户端、3B 公共组件和页面、3C 切换构建并删除 fragment 拼接三个 PR。每次迁移调用链，不同时改产品流程或视觉设计。暂存的兼容包装必须转发到唯一实现，不能长期复制两套逻辑。

用 esbuild 的模块构建能力打包。React 与 DSH UI 组件仍由宿主提供，明确 externals 到 ModuleLoader `require` 的映射，避免出现第二份 React。Node 专属依赖不能进入浏览器图。通过依赖注入传入 React、Host remote 和 DSH 服务。

### 验收标准

- 迁移后的所有功能通过模块导入运行；`build-client.mjs` 不再通过文件列表和 `sources.join` 组装业务源码。
- 页面层不直接依赖 Host 文件系统、provider 实现或发行脚本；依赖图无循环，业务共享状态不挂在 `window.__AGENTKIT_*`。宿主注入的只读启动信息可保留。
- 保持 `./client` 导出、module ID、DSH 注入列表和单脚本交付。连续构建两次的输出哈希相同。
- 以阶段 3 开始时的同配置压缩包为基线，客户端 gzip 大小增长不超过 5%；超过时单独评审原因与预算调整，不能仅用压成一行满足行数检查。
- 已迁移功能的行为测试通过真实 export 或组件接口执行，不再截取源码后通过 `new Function` 或 `vm` 注入私有变量。尚未迁移的测试按 PR 显式列出。
- 在真实 Web 和 Electron 宿主验证：创建 Agent、编辑资源绑定、进入原生会话、切换模型、创建 Build、查看部署、自动化 CRUD、重开设置和凭证引导；未知及失败状态保持可操作。调用真实云端的结果单独验收。

### 回退

按迁移 PR 回退代码和对应生成 bundle。先保持包导出及存储格式兼容，使旧 bundle 能继续使用现有 Host。前端重构与 Host 协议变更不在同一个 PR 里切换。

## 阶段 4 Host 拆分与合同统一

### 改动范围

拆出 `src/index.mjs` 中的服务创建、RPC 分派及 HTTP 注册。现有存储与业务实现可先留在原位置，由领域模块注入调用；provider 留在 `src/providers/`，Harness 保持独立插件。

目标依赖为前端调用合同客户端，Host 路由校验后调用领域服务，领域服务依赖存储和外部适配器；入口只组合这些依赖。可按以下结构落地：

```text
src/index.mjs                插件入口与作用域挂载
src/host/runtime-bridge.mjs  阶段 1 已建立的桥接服务
src/host/services/           agents、resources、builds、deployments
                            automation、channels、evaluation、observability
src/host/routes/             各领域 RPC 与 HTTP 注册
src/host/bootstrap.mjs       服务就绪、降级和生命周期组装
src/contracts/              操作定义、输入输出及错误合同
src/providers/              DSH、Codex 和云端协议适配
```

建议分为 4A 服务组装、4B 路由迁移、4C 合同及客户端统一三个 PR。将端点名称、输入输出校验、错误码和取消合同放到同一份操作定义中，客户端类型与操作映射从该定义派生。可以从 JSDoc 和 `checkJs` 开始，不要求全仓改成 TypeScript。

RPC 继续通过 DSH Connection 认证，HTTP 下载和 SSE 保持对应传输适配器。它们调用同一领域操作，但不能因统一客户端而改变流式取消、请求大小限制、凭证隔离或 admission。兼容 REST 入口若仍有调用者，保留为适配层并记录消费者及删除条件。

### 验收标准

- `src/index.mjs` 中没有业务请求分支和存储操作，只负责导入、依赖组合和挂载；每个现有端点都能映射到合同及所属领域。
- 所有现有 RPC/HTTP 操作的参数、返回 envelope、错误码、认证与取消语义有迁移前后对照测试；新增只读查询有独立合同。
- `src/host-remote.mjs` 与实际浏览器客户端共享操作定义，没有两个分别维护的端点清单。浏览器图不含 Node 模块及 Host 凭证解析。
- 本地配置可用、仅模型可用、云端未配置、资源不可用四种启动状态行为明确；可选领域失败不能使原生会话或其他独立领域失效。
- Agent/Revision/Build/Session/Run 绑定不变；重启恢复、工具续接、流式输出、取消和冻结 Build 的模型选择通过真实 Host 验证。
- Studio tarball 和 Harness 独立 tarball 的实际模块图及导出可加载；Web、macOS、Windows 的适用打包检查通过。独立包不能只在源码目录里验证。

### 回退

先迁移实现、后切换入口，每个 PR 维持既有导出与端点。旧导出转发新实现，不能由两个入口同时注册同一路由。由于没有存储迁移，可用上一版本 Studio 包回退；实际桌面发布另遵守更新和回滚门禁。

## 阶段 5 补丁收敛与宿主兼容治理

### 改动范围

修改 `patches/`、`cordis.patch.yml`、Makefile、补丁和桌面构建脚本，以及 GitHub 工作流。保留固定 commit、隔离构建、内容哈希和实际 archive 模块图检查。

建议拆成三个 PR：

| PR | 实施内容 | 独立交付 |
| --- | --- | --- |
| 5A 清单与兼容门禁 | 增加机器可读补丁清单和补丁依赖校验；对相关 PR 构建 patched DSH 并运行受影响宿主测试 | 每项补丁都有风险、合同、依赖和退出条件 |
| 5B 产品配置接口 | 将品牌、产品版本、App ID、更新源、bundle 默认项和平台打包输入归入统一产品配置接口 | Studio 与 DSH 默认配置均可通过验证 |
| 5C 通用修复与维护来源 | 逐项复核通用修复，准备上游提交或薄宿主分支；验证等价行为后逐项删除补丁 | 固定宿主提交及可重建差异报告 |

补丁清单至少记录 `id`、`category`、`baseCommit`、`dependsOn`、`affectedPackages`、`contracts`、`risk`、`maintainerRole`、`upstreamStatus`、`removeWhen` 和 `verification`。已有 README 的删除条件迁入清单并保持可读说明；上游状态必须区分尚未提交、等待合入、已合入未发布和已进入当前基线。

品牌和产品打包配置优先收敛，通用缺陷修复保留独立提交。会话和持久化扩展单独评审，尤其是 016 的 informational event 恢复合同。配置收敛必须保持 DSH 默认产品行为，不能把 Studio 条件散布到更多宿主核心文件。

若长期所需 API 仍未进入上游，采用固定 upstream commit 加少量独立提交的薄宿主分支。以分支提交为唯一修改来源，patch 自动导出并检查同步；不能同时手改两套实现。

版本号相同也可能缺少 patched API。启动握手应表达宿主基线、兼容合同版本和所需能力；构建报告额外记录 patched tree 或 patch digest。缺少关键能力时阻止受影响功能并给出错误，不能仅凭 `requiredDsh` 判断可用。

### 验收标准

- 每个 patch 都在清单中，依赖无环，顺序与依赖一致；存在未说明的宿主修改、缺少验证或不同基线混用时门禁失败。
- 从干净固定 DSH checkout 构建，顺序应用补丁、运行受影响宿主测试及阶段 1 至 4 的关键集成测试；以实际打包文件验证模块可加载。
- 品牌、产品版本、App ID、更新源和默认 bundle 从产品配置取得；新 Profile 与已有 Profile 迁移均正确，用户主动禁用的 bundle 不被重新启用。
- 删除任何补丁前，在上游等价实现或替代接口上跑原补丁的行为用例。不能为了降低数量删除测试、混合不同领域或合成一个大补丁。
- 会话扩展验证旧日志重开、未知 informational event、插件停用和再启用、资源缺失后的恢复；不得重写已有日志使其勉强通过。
- 桌面发行变更通过 macOS 和 Windows 的适用安装包验证；触及 updater、签名或 feed 时，执行真实安装更新、数据保留及可用回滚验证。签名通过、静态 feed 或 mock 下载不能代替安装证据。
- 至少完成一次候选 DSH 基线升级演练，输出需保留、已等价可删除、需重做三类差异及耗时。候选升级失败不自动变更产品基线。

### 回退

宿主 commit、patch 清单、产品配置和 Studio 包作为匹配组合固定。先生成候选构建，再切换基线；回退恢复整组输入。发布和 feed 切换仍使用现有发行门禁，不能由重构 PR 自动触发。

## 每阶段的共同交付与检查

每个 PR 说明行为变化、保留的合同、回退组合及适用验收。阶段交付至少包含实现、行为测试、真实宿主结果和兼容说明。阶段状态使用待实施、部分完成、已完成；无法取得所需真实 provider、云端或安装证据时列出缺项，不能用模拟结果标为已完成。

先运行变更涉及的测试，再执行 `pnpm check`。产品包或工作流改动执行 `make release-check`；所有改动执行 `git diff --check`。补丁改动还需在固定基线运行补丁应用、受影响宿主测试和构建。真实 DSH 验证使用隔离 Profile 和 `DSH_HOME`，不修改正在使用的开发 checkout 或用户数据。

现有 `verify-dsh-runtime-adapter`、`verify-dsh-runtime-retry` 和 `verify-dsh-node-store` 可作为集成检查的一部分。它们使用受控模型或事件时，只证明所测试的真实 Host 合同，不能替代完整插件加载、浏览器交互或真实 Runtime 验证。生命周期和原生会话列表的完整宿主测试入口需在阶段 1、2 新增。

本地验收证据存于忽略的 `.artifacts/refactor/<stage>/`。报告记录 Studio commit、DSH commit、patch digest 或 patched tree、插件包指纹、场景、预期、实际结果和证据类别。证据类别区分源码测试、真实 Host 加受控 provider、真实 provider、安装桌面和真实云端。报告不含凭证值或用户会话正文。

源码交付以 GitHub `kingsoftcloud/agentkit-studio` 的 `main` 为主分支。完成各阶段后整理 README、开发和贡献说明、许可证、补丁来源及适用验收结果，重新运行公开面、当前快照和可达历史的凭证扫描、构建与包完整性检查。以最终待合并提交运行真实 DSH 回归，再通过正常分支合并流程更新 `main`；同步镜像后核对精确提交，不改写已有分支历史。源码主分支交付与安装包、更新 feed 的发行分别验收。

## 维护性如何衡量

| 指标 | 阶段目标 | 记录方式 |
| --- | --- | --- |
| 生命周期泄漏 | 20 次加载卸载后，所属资源回到基线；旧代次不能影响新代次 | scope 行为测试和真实 Host 结果 |
| 侧栏正确性 | Agent 选择和缓存不改变 DSH 原生列表成员 | Web 与 Electron 场景测试 |
| 前端依赖 | 显式模块依赖，无顺序拼接和业务全局桥接，无第二份 React | 构建图、行为测试和包图 |
| Host 边界 | 入口无业务分派；所有操作有领域、合同和生命周期归属 | 路由清单及合同对照测试 |
| 宿主差异 | 补丁全部有归属和验证，产品配置集中，核心修改不无说明地增长 | 补丁清单和基线差异报告 |
| 升级成本 | 第一次演练建立耗时基线，后续升级比较冲突定位、重做和验证耗时 | 每次候选升级报告 |

优先完成阶段 1 和 2，可以先降低重载与会话展示问题的定位成本；阶段 3 和 4 降低日常功能改动的影响范围；阶段 5 降低跟进上游和发行时的重做成本。以这些行为和成本指标判断成效，不预先承诺固定的补丁数量或维护工时降幅。
