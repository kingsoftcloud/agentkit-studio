# 前端模块化：实施与验收

阶段 3 正在实施。3A 已将浏览器 Host 客户端、当前会话显示缓存、连接所有者及原生创建草稿迁入 `src/client/` 的 ES Modules；页面迁移和删除 fragment 拼接仍待 3B/3C 完成。

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

## 仍需完成

3B/3C 将公共组件、全部页面、模型目录桥接和插件挂载迁入显式模块，将组件依赖按 scope 注入。现有模块工厂中的共享组合也将移入每次 `apply(ctx)` 的组合函数。删除余下 `window.__AGENTKIT_CONFIRM__`、`window.__AGENTKIT_STUDIO_BIND_AGENT__`，消除 fragment 业务拼接和对应的源码截取测试，再验证创建/编辑 Agent、资源绑定、模型、Build、部署、自动化、设置及凭证引导的完整真实宿主流程。当前不能宣称阶段 3 整体完成。
