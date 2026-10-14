# 前端模块化：实施与验收

阶段 3 正在实施。3A 已将浏览器 Host 客户端、当前会话显示缓存、连接所有者及原生创建草稿迁入 `src/client/` 的 ES Modules；3B 已迁移公共组件、设置和 Agent 页面。其余页面和删除 fragment 拼接仍待 3B/3C 完成。

## 3A 范围

- `remote/host-client.mjs` 保留现有 RPC/REST/SSE 选择、认证、错误 envelope 和请求取消合同；通过参数注入浏览器环境。删除重复但内容相同的 `putCredential` 定义，保留其最终行为。
- `state/connection.mjs` 持有当前连接，注册返回身份匹配的幂等清理函数。旧 scope 的延迟释放不能清除新连接。
- `state/conversation-agent.mjs` 保存现有显示缓存格式；持久化 preset 仍是执行归属来源。删除 `window.__AGENTKIT_STUDIO_CONVERSATION__` 写入，保留现有显示事件。
- `state/native-authoring.mjs` 管理待插入草稿、导航请求代次和所属 scope。卸载、取消和过期导航不能再发布绑定或草稿；失败导航清空待插入状态。
- `dsh/native-authoring.mjs` 注入宿主 React 和表单样式，在官方原生 composer 插入草稿，仍需用户确认才实际创建 Agent。
- 构建切换到 esbuild 模块打包，已迁移功能通过真实 imports 加载。未迁移页面暂用明确的过渡 fragment 组合；3C 删除该路径。

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

公共展示组件、表单样式、资源弹窗、版本读取、设置页，以及 Agent 列表、创建/编辑表单和平台资源选择器已通过显式模块工厂组合。React、Host 客户端及页面组件依赖由调用方注入；已迁移页面的绑定和确认操作通过 `actions` 接口调用。入口中的旧命令桥接暂作兼容适配，3C 将它归入所属 scope。

Agent 列表、模板、密钥显示和桌面设置行为测试已改为直接导入组件工厂。现有行为测试没有删减。全量源码和发行输入检查为 703 项通过，0 失败、0 跳过；419 文件的 Studio tarball 完整性检查通过。

真实 Web 和 Electron 开发宿主各完成两次验证，每次均通过侧栏 12 项、原生创建草稿 1 项，以及手动创建 Agent、编辑 Prompt 与默认模型绑定、持久化新 Revision、绑定原生会话和设置两次重开；均无未捕获的渲染错误。记录分别保存在 `client-pages-web-{workspace-ready,ready-repeat}.json` 和 `client-pages-electron-{catalog-ready,ready-repeat}.json`。这是已迁移部分的本地验收，不能替代其余页面及完整阶段 3 的验收。

此前失败记录保留在本地证据目录。源码复核确认：没有当前或最近工作区时，DSH 通用新会话入口回到首页而不持有 Session；验收改为从默认工作区的原生新建入口启动，并确认实际 Session ID 和取消工作区按钮已就绪。取消工作区后先确认选择器所属 Session ID 已切换，再执行下一次 Agent 选择。创建表单切换运行时后会异步刷新模型目录，验证等待目录就绪及两个实际模型选项，再读取绑定 ID。失败报告保留已完成的检查和点击轨迹。这些调整修正验收前置条件，没有改变产品流程或放宽行为断言。

验证只清理 Studio 显示缓存，保留 DSH 的原生视图偏好。创建/编辑通过产品页面完成，持久化结果通过实际 RPC 核对；仅操作独立 Profile 内带唯一 `UI_REFACTOR` 标记的合成 Agent，没有发送模型消息。

当前 gzip 为 90,658 bytes，比阶段 3 基线增长 3.68%，仍低于 91,812 bytes 预算；连续构建的输出字节一致。后续页面迁移继续使用同一预算。

## 仍需完成

3B/3C 将其余资源、部署、自动化、评测、观测和渠道页面，以及模型目录桥接和插件挂载迁入显式模块，将组件依赖按 scope 注入。现有模块工厂中的共享组合也将移入每次 `apply(ctx)` 的组合函数。删除余下 `window.__AGENTKIT_CONFIRM__`、`window.__AGENTKIT_STUDIO_BIND_AGENT__`，消除 fragment 业务拼接和对应的源码截取测试，再验证创建/编辑 Agent、资源绑定、模型、Build、部署、自动化、设置及凭证引导的完整真实宿主流程。当前不能宣称阶段 3 整体完成。
