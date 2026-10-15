# Host 拆分：实施与验收

阶段 4 正在实施。4A 服务组装和 4B 全部 77 个操作及传输注册已通过本地验收，4C 共享合同与客户端统一尚未完成；本记录不把入口变短当作完整阶段验收。

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

4A 交付时，`src/host/bootstrap.mjs` 组装模型、Runtime、preset 和恢复过程，并保留原 RPC/HTTP 注册及业务请求分支。随后 4B 将请求分支和传输注册迁入领域模块，入口与新模块没有同时注册同一路由。

## 4A 验证

- 716 项源码及独立 Harness 源码测试通过，0 失败、0 跳过；公开面、当前快照及可达历史凭证检查、实际 Studio tarball 模块完整性检查通过。
- 新增服务图行为测试使用两套临时配置及真实文件存储，验证 Agent、配置、MCP 目录及凭证服务引用的隔离。其 Context 是受控测试对象；真实 Host 卸载单独验证。
- 同一真实 DSH Host 对实际安装的完整 Studio 连续加载卸载 20 次，监听器、路由和所属异步资源回到基线，重复卸载无异常。
- 真实 Web 已通过持久化历史、重开、完整原生列表、搜索、归档、缓存及重连等 13 项，原生创作草稿 1 项，完整产品页面 9 项，共 23 项，渲染错误为 0。
- 真实 Electron 开发宿主对同一安装插件完成上述 23 项复核，渲染错误为 0；原有持久化 Agent 会话可以在 Host 重启后重新打开。
- 原 RPC/HTTP 实现迁移前后归一化 import 相对路径后的内容哈希相同。这证明本批未重写分派及传输代码，不能代替下一批每个操作的合同对照测试。
- 浏览器 bundle 未变化，保持同一 SHA-256 和 5% 体积门禁；Host 模块未进入浏览器依赖图。

本地证据保存在忽略的 `.artifacts/refactor/stage-4/`：`services-release-check.log`、`services-isolation-check.log`、`services-lifecycle-20.json`、`services-web-23.json`、`services-electron-23.json`、`services-transport-parity.json` 和 `services-client-admission.json`。验收 UI 只操作独立 Profile 中带唯一标记的合成数据，不发送新模型消息或进行云端部署修改。Electron 为开发宿主，不能作为安装更新和 Windows 原生安装证据。

## 4B 首批路由

`routes/resources.mjs` 处理资源目录和 MCP 的 6 个操作，`routes/credentials.mjs` 处理凭证写入，`routes/builds.mjs` 处理 Build 与 operation 的 6 个操作。保留原参数、返回 envelope、错误码、资源删除范围和 Build 身份。异步调用在原分派错误边界内等待，异常继续转换成原 RPC 失败 envelope。

四个对应测试文件改为直接导入实际路由工厂，不再读取并截取业务源码或使用 `new Function`。77 个允许操作的集合与迁移前相同，没有增加或删除端点。

本地源码及发行输入检查为 716 项通过，0 失败、0 跳过。真实 Web 和 Electron 开发宿主各通过既有 23 项流程，以及凭证名称无效、凭证值为空、MCP 更新不存在、MCP 删除 ID 无效、Build 下载 ID 无效这 5 项失败合同，共 28 项。负例验证 HTTP 状态、RPC ID、错误码和凭证值不回显，没有执行凭证写入或资源删除。

失败记录保留。第一次创建流程缺少两个可选模型，检查确认隔离目录的模型配置缺失；补入现有模型配置后继续验收，没有复制云端凭证。另一个失败是新增负例把空 ID 的 MCP 更新预期写成了 `MCP_ID_INVALID`；真实存储的迁移前后对照均为 `MCP_NOT_FOUND`，因此修正测试预期，保留产品合同。产品页面验证增加模型目录前置检查，失败报告保留已完成的页面结果。

本批机器记录位于同一证据目录：`routes-first-release-check.log`、`routes-first-operation-parity.json`、`routes-mcp-error-parity.json`、`routes-failure-code-{red,green}.json`、`routes-first-web-final-28.json`、`routes-first-electron-28.json` 和 `routes-first-lifecycle-20.json`。之前的失败报告不覆盖。

## 4B 全部路由与传输注册

全部 77 个操作由 14 个领域处理器承接，公共分派层负责允许的操作集合、Host/请求取消信号及外层错误 envelope。`contracts/operations.mjs` 暂时集中操作 ID，完整参数、错误和客户端映射留待 4C。bootstrap 从 709 行降至 312 行，保留启动与作用域组装，不再包含 RPC 请求分支和 HTTP 注册代码。

HTTP/SSE 注册和 Connection Fetch 下载位于独立模块；旧本地会话入口通过每次请求创建的领域服务取得 handler。插件及 Session 导出依赖按需加载，保持官方 DSH 归属。preset 模型选择作为可直接导入的服务函数验证，不再截取其源码执行。已有两处 Agent 表面架构断言仍检查所属模块的文本；它们不替代行为测试。

| 验证 | 本地结果及范围 |
| --- | --- |
| 全量源码及发行输入 | 888 项通过，0 失败、0 跳过；公开面、快照和历史凭证扫描及 Studio tarball 检查通过 |
| 固定提交行为对照 | 从 `c6f97fb` 录制 77 个操作各一组成功及后端失败结果，共 154 例；返回 envelope、参数归一化和适配器调用相同。使用受控适配器，不是 77 次真实云端操作 |
| 真实 Node HTTP | 401/403、非 POST、坏 JSON、1 MiB 限额、RPC ID、输入 EOF、SSE 字节、断开取消、GET/HEAD 下载和作用域卸载等边界通过 |
| 真实 DSH Host | 官方 Connection/WebServer 的缺 Cookie 401、跨来源 403、官方浏览器 Cookie 200 通过；在真实 Cordis scope 卸载时，本地与云端 SSE 的受控上游均取消，注册回到基线 |
| 真实 Web / Electron | 同一实际安装插件各 28 项通过，渲染错误为 0；Electron 仍为开发宿主 |
| 完整插件生命周期 | 同一真实 DSH Host 加载卸载 20 次，注册、监听器和所属异步资源回到基线 |
| 独立 Harness tarball | 实际导出加载、类型检查、真实 DSH loop / 持久化与卸载通过，使用受控模型适配器 |
| 浏览器产物 | 与 4A、首批 4B 字节相同，保持原始 5% 包体门禁 |

补充测试发现并修复两类旧生命周期缺口：SSE 仅响应客户端断开，未绑定注册作用域；RPC 等待服务初始化后未重新检查 Host 是否已关闭。3 个回归场景先失败后通过。现在每个 HTTP 注册作用域拥有取消信号，晚到的本地 handler 和 RPC 不再在旧作用域启动后续调用；真实 DSH scope 的活跃流卸载也已验证。未改变已提交写操作的重试或回执语义。

机器证据保存为 `routes-all-release-check.log`、`routes-all-real-dsh-http.json`、`routes-all-web-28.json`、`routes-all-electron-28.json`、`routes-all-lifecycle-20.json`、`routes-all-packed-harness.log` 和 `routes-lifetime-{red,green}.log`。固定提交录制保存在 `tests/fixtures/host-route-contracts.json`，测试直接调用当前路由模块，不在运行时执行旧源码。

## 仍需完成

4C 统一 Node 和产品浏览器客户端的操作定义、参数、错误及取消合同，并验证四种启动状态、重启恢复、冻结 Build、工具续接及适用平台的包加载。当前不能宣称阶段 4 全部完成。阶段 4 完整验收后再进入补丁收敛与宿主升级演练，最终交付可开源源码主分支。
