# 前端模块化：实施与验收

阶段 3 的页面迁移、ES Module 构建切换和每次 `apply(ctx)` 的作用域组合已实现，`src/client-fragments/` 已删除。完整真实 Web 和 Electron 开发宿主流程均已通过。阶段整体仍为部分完成：当前 gzip 增长 6.85%，超过 5% 预算，[包体专项评审](refactor-client-budget.md)尚待确认。以下 3A、3B 数据保留对应批次的历史结果，当前结果见 3C。

重新安装复核发现启动恢复会等待新会话的模型目录校验，导致部分动态 preset 暂时缺失。现已修复：历史 Session 使用其持久化模型投影，恢复定义时不请求新会话模型目录；显式准入仍执行原模型校验。新增暂停目录查询的回归用例先失败后通过，真实 Web 和 Electron 各 23 项流程及完整插件 20 次加载卸载通过。原失败记录保留，没有修改旧会话日志。

## 3A 范围

- `remote/host-client.mjs` 保留现有 RPC/REST/SSE 选择、认证、错误 envelope 和请求取消合同；通过参数注入浏览器环境。删除重复但内容相同的 `putCredential` 定义，保留其最终行为。
- `state/connection.mjs` 持有当前连接，注册返回身份匹配的幂等清理函数。旧 scope 的延迟释放不能清除新连接。
- `state/conversation-agent.mjs` 保存现有显示缓存格式；持久化 preset 仍是执行归属来源。删除 `window.__AGENTKIT_STUDIO_CONVERSATION__` 写入，保留现有显示事件。
- `state/native-authoring.mjs` 管理待插入草稿、导航请求代次和所属 scope。卸载、取消和过期导航不能再发布绑定或草稿；失败导航清空待插入状态。
- `dsh/native-authoring.mjs` 注入宿主 React 和表单样式，在官方原生 composer 插入草稿，仍需用户确认才实际创建 Agent。
- 构建切换到 esbuild 模块打包，已迁移功能通过真实 imports 加载。3A 批次曾使用过渡 fragment 组合，当前路径已由 3C 删除。

## 3A 验证

| 项目 | 本地结果 |
| --- | --- |
| 迁移的状态、资源客户端、评测文件上传及 preset 解析 | 直接模块导出测试通过，不再用截取源码后的 `new Function` 或 `vm` |
| 旧连接释放、存储不可用、卸载后晚到导航、并发导航、订阅清理 | 新增 7 项行为测试通过 |
| 全量源码及发行输入检查 | 703 项通过，0 失败、0 跳过；当前/历史公开面、secret scan、Studio tarball 模块完整性通过 |
| 连续构建输出 | 字节一致，保持单脚本与原 ModuleLoader ID |
| gzip 预算 | 87,440 → 88,088 bytes，增长 0.74%，低于阶段 3 的 5% 预算 |
| 已迁移浏览器依赖图 | 没有 Node、provider、Host 或第二份 React 输入；剩余 fragment 不计为已完成的模块图 |
| 真实 Web 与 Electron 开发宿主 | 当前安装包的侧栏 12 项回归及原生创建草稿专项分别记录在本地证据中 |

验收证据位于忽略的 `.artifacts/refactor/stage-3/`。真实创建草稿验证只在原生 composer 插入一次提示词，不发送模型请求，也不创建 Agent。Electron 是当前隔离 DSH 构建上的开发宿主，不能当作安装更新或 Windows 原生证据。

## 3B 已迁移部分

公共展示组件、表单样式、资源弹窗、版本读取、设置页，以及 Agent 列表、创建/编辑表单和平台资源选择器通过显式模块工厂组合。3B 批次曾保留旧命令桥接；当前由 3C 的作用域操作接口取代。React 和展示组件经公共 `ui` 接口注入，Host 客户端与业务操作通过独立参数注入。

Agent 列表、模板、密钥显示和桌面设置行为测试已改为直接导入组件工厂。现有行为测试没有删减。全量源码和发行输入检查为 703 项通过，0 失败、0 跳过；419 文件的 Studio tarball 完整性检查通过。

真实 Web 和 Electron 开发宿主各完成两次验证，每次均通过侧栏 12 项、原生创建草稿 1 项，以及手动创建 Agent、编辑 Prompt 与默认模型绑定、持久化新 Revision、绑定原生会话和设置两次重开；均无未捕获的渲染错误。记录分别保存在 `client-pages-web-{workspace-ready,ready-repeat}.json` 和 `client-pages-electron-{catalog-ready,ready-repeat}.json`。这是已迁移部分的本地验收，不能替代其余页面及完整阶段 3 的验收。

此前失败记录保留在本地证据目录。源码复核确认：没有当前或最近工作区时，DSH 通用新会话入口回到首页而不持有 Session；验收改为从默认工作区的原生新建入口启动，并确认实际 Session ID 和取消工作区按钮已就绪。取消工作区后先确认选择器所属 Session ID 已切换，再执行下一次 Agent 选择。创建表单切换运行时后会异步刷新模型目录，验证等待目录就绪及两个实际模型选项，再读取绑定 ID。失败报告保留已完成的检查和点击轨迹。这些调整修正验收前置条件，没有改变产品流程或放宽行为断言。

验证只清理 Studio 显示缓存，保留 DSH 的原生视图偏好。创建/编辑通过产品页面完成，持久化结果通过实际 RPC 核对；仅操作独立 Profile 内带唯一 `UI_REFACTOR` 标记的合成 Agent，没有发送模型消息。

3B 批次 gzip 为 90,658 bytes，比阶段 3 基线增长 3.68%；当前 3C 输出使用同一基线与预算继续检查。

## 3C 实施与当前验收

- `entry.mjs` 保留原 ModuleLoader ID 和注入合同，从宿主取得唯一 React；每次 `apply(ctx)` 调用 `app.mjs` 创建独立页面图、连接所有者、命令、确认弹窗和原生草稿状态。组合结束后冻结展示接口。
- 资源、部署、自动化、评测、观测、渠道、模型设置和凭证引导均迁入显式模块。`build-client.mjs` 直接构建入口，不再拼接业务源码或使用 `toString()` 注入函数。
- `state/actions.mjs` 和 `dsh/session-entry.mjs` 取代两个业务全局函数。旧注册清理不会覆盖新注册，卸载后晚到的准入、模型目录和导航不得继续发布；模型同步保留原设置和凭证写入合同。
- 确认弹窗随所属实例关闭，取消待确认操作。样式和图标由文档资源租约管理，重叠挂载和替换 bundle 共用资源，最后释放才清理；不存储连接或业务状态。
- 新增 8 项作用域与异步行为检查，保留已有测试。前端行为测试直接导入模块；Host 路由中剩余的源码截取测试留待阶段 4 随路由迁移处理。
- 组件工厂通过参数直接声明依赖，单组件工厂直接返回组件。三组静态样式保持单一 CSS 模块来源，由 esbuild 压缩后注入所属文档；源模块也能由行为测试直接导入。

| 项目 | 当前本地结果 |
| --- | --- |
| 模块图 | 61 个输入，无循环、Node、Host/provider、第二份 React及业务全局变量；一个 ModuleLoader 注册 |
| 源码及发行输入门禁 | 712 项通过，0 失败、0 跳过；公开面、历史和快照凭证扫描、包完整性检查通过 |
| 真实 Web 与 Electron 开发宿主 | 同一安装 bundle 各通过侧栏及历史重开 13 项、原生草稿 1 项及完整页面 9 项，共 23 项；无未捕获渲染错误 |
| 完整插件生命周期复核 | 同一真实 DSH Host 加载卸载完整 Studio 20 次，所属路由、监听器、异步资源回到基线，重复卸载无异常 |
| Codex 工具卡片 | 真实固定 DSH loop 与 Chat assembler 的 6 种受控结果通过，磁盘重开和下一轮上下文保留，工具没有重复执行；此项未调用真实模型 |
| gzip 专项门禁 | 87,440 → 93,430 bytes，增长 6.85%；超过 91,812 bytes 上限，未通过 |

机器结果保存在忽略的 `.artifacts/refactor/stage-3/`：`recovery-fix-full-web-23.json`、`recovery-fix-full-electron-23.json`、`recovery-fix-lifecycle-20.json`、`recovery-fix-release-check.log`、`optimized-deterministic.json`、`optimized-module-graph.json`。Codex 受控工具卡片结果保留在 `codex-cards-modules.log`。模块与大小专项使用 `node scripts/verify-client-modules.mjs <baseline.json> <report.json>`；基线记录阶段 3 开始前的源码 commit、bundle SHA 和 gzip 大小。大小失败不由已有 `release-check` 的成功抵消。

完整页面验证通过产品 UI 创建唯一合成 Agent，编辑 Prompt、默认模型及模型白名单，再进入官方原生会话并切换模型。资源页验证类型切换、本地来源和搜索空状态；Build 通过真实本地 Host 创建，核对冻结的 Revision 并查看部署页面。自动化验证空执行时间的错误、创建、编辑、暂停、启用及删除，用一周间隔避免验收中触发模型执行，并核对实际存储结果。设置重开两次，凭证引导显示已配置状态，密钥输入保持空白，没有写入凭证。没有发送模型消息或创建云端部署。

失败记录保留。原生新会话测试先观察持久化历史已恢复，再触发工作区导航；历史重开验证 DSH 原生会话的 ID 和原有合成消息，并等待归档恢复的可见状态；搜索使用当前完整标题，避免 marquee 的可见片段和重开后的标题刷新。自动化测试用最近的语义容器定位任务，避免匹配包含同名任务的外层区域，并兼容含选项或 textarea 内容的原生 label。每次失败都会按本次唯一任务名称和目标 Agent 核对、清理合成任务；此前的一个遗留合成任务已通过实际 Host 删除，记录在 `owned-task-cleanup.json`。

## 仍需完成

先把 gzip 收敛到 5% 预算，或完成方案允许的独立预算调整评审，再进入阶段 4 的 Host 服务、路由和共享合同拆分。阶段 5 的补丁治理、升级演练和最终开源源码主分支交付仍待实施。当前不能宣称阶段 3 整体完成。上述 Electron 结果属于开发宿主，不代表安装更新或 Windows 原生安装验收；查看部署页面也不代表真实云端部署成功。
