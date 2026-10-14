# Host 拆分：实施与验收

阶段 4 正在实施。4A 服务组装已经拆出，4B 领域路由与 4C 共享合同尚未完成；本记录不把入口变短当作完整阶段验收。

## 4A 改动范围

`src/index.mjs` 从 946 行缩至 73 行，仅挂载 Harness、延迟加载可信 Host bootstrap，并注入版本、启动会话信息和 favicon。公开插件名称、注入服务和导出保持不变。

`src/host/services/index.mjs` 为每个 Host 创建独立服务图。领域模块声明自己的依赖，晚到的模型、portable bundle 和 preset admission 通过明确的回调解析当前所属实例，没有新建进程全局服务。

| 模块 | 负责创建的服务 |
| --- | --- |
| platform | 全局配置、凭证服务引用、控制面及部署客户端 |
| agents | 本地 Agent/Revision 存储、Agent 目录、成功 Build 目标查询 |
| resources | Skill、本地 MCP、Probe 与受作用域管理的资源适配器 |
| builds | Build 存储及操作管理器 |
| deployments | 延迟创建的部署管理器，保留未配置云端时的本地使用路径 |
| automation | 本地计划、评测、观测、渠道及云端计划适配器 |
| authoring | 原生创作工具的进程内客户端 |

`src/host/bootstrap.mjs` 目前仍组装模型、Runtime、preset 和恢复过程，并保留原 RPC/HTTP 注册及业务请求分支。路由的认证、envelope、限额、下载和流式取消没有在这一批切换。下一批迁移这些路由，避免入口与新路由同时注册。

## 4A 验证

- 716 项源码及独立 Harness 源码测试通过，0 失败、0 跳过；公开面、当前快照及可达历史凭证检查、实际 Studio tarball 模块完整性检查通过。
- 新增服务图行为测试使用两套临时配置及真实文件存储，验证 Agent、配置、MCP 目录及凭证服务引用的隔离。其 Context 是受控测试对象；真实 Host 卸载单独验证。
- 同一真实 DSH Host 对实际安装的完整 Studio 连续加载卸载 20 次，监听器、路由和所属异步资源回到基线，重复卸载无异常。
- 真实 Web 已通过持久化历史、重开、完整原生列表、搜索、归档、缓存及重连等 13 项，原生创作草稿 1 项，完整产品页面 9 项，共 23 项，渲染错误为 0。
- 真实 Electron 开发宿主对同一安装插件完成上述 23 项复核，渲染错误为 0；原有持久化 Agent 会话可以在 Host 重启后重新打开。
- 原 RPC/HTTP 实现迁移前后归一化 import 相对路径后的内容哈希相同。这证明本批未重写分派及传输代码，不能代替下一批每个操作的合同对照测试。
- 浏览器 bundle 未变化，保持同一 SHA-256 和 5% 体积门禁；Host 模块未进入浏览器依赖图。

本地证据保存在忽略的 `.artifacts/refactor/stage-4/`：`services-release-check.log`、`services-isolation-check.log`、`services-lifecycle-20.json`、`services-web-23.json`、`services-electron-23.json`、`services-transport-parity.json` 和 `services-client-admission.json`。验收 UI 只操作独立 Profile 中带唯一标记的合成数据，不发送新模型消息或进行云端部署修改。Electron 为开发宿主，不能作为安装更新和 Windows 原生安装证据。

## 仍需完成

4B 将 77 个现有操作按领域迁移，直接导入路由行为测试，替换当前少量截取源码的测试。4C 统一 Node 和产品浏览器客户端的操作定义、参数、错误及取消合同，并验证四种启动状态、重启恢复、冻结 Build、工具续接与包加载。阶段 4 完整验收后再进入补丁收敛与宿主升级演练，最终交付可开源源码主分支。
