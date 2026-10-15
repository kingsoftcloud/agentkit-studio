# Studio 控制协议与客户端

`src/contracts/operations.mjs` 是操作 ID 的唯一清单，目前有 78 项：保留原有 77 项，另补入前端已调用的只读 `schedules/delivery-targets`。`definitions.mjs` 从清单派生领域、传输通道、输入输出校验、公共错误及取消合同。新增操作必须同时拥有领域处理器和行为测试。

`wire.mjs` 由清单派生 `createOperationClient(connection).methods`，JSDoc 的操作 ID 联合类型也来自同一清单。`pnpm check:contracts` 使用固定 TypeScript 6.0.3 运行 checkJs 和类型探针。JSON 输入及 envelope 是公共边界；Agent、MCP、Build 等字段的业务校验仍由原领域实现负责，保留其参数归一化和错误码。这里没有宣称已为全部业务 DTO 建立逐字段静态类型。

浏览器和 Node 的 Connection 模式复用 `src/remote/control-client.mjs`。浏览器只引入公共传输和 envelope 校验，不打入 Host 操作注册表、Node 适配器或凭证解析。旧的前端模块路径是转发导出，便于已有导入迁移，不保留第二份实现。

```js
import { createStudioHostRemote } from '@kingsoftcloud/agentkit-studio/host-remote';

// connection 由调用方取得并完成 DSH 认证。
const remote = createStudioHostRemote({ connection });
const agents = await remote.operations.methods['agents/list']({}, signal);
```

DSH Connection 的第四个参数直接接收 `AbortSignal`。Host 分派合并请求与所属 Host 的取消信号；HTTP 适配器以响应连接关闭为断开边界，上传 EOF 不等于取消。SSE 继续使用原传输适配器，下载继续经过 Connection Fetch admission。公共失败 envelope、RPC ID、1 MiB 控制请求限额和错误中的领域 status 保留。

没有 Connection 的 `createStudioHostRemote({ baseUrl, fetchImpl, sessionToken })` 保持现有 REST 合同。其消费者包括外部兼容调用者及 `authoring-tools.mjs` 的默认 remoteFactory；实际 Studio Host 为创作工具注入进程内工厂。删除条件是外部消费者完成迁移、默认工厂有替代入口，且旧 REST/SSE 行为测试有明确退役记录。Connection 模式的旧 HTTP/SSE 方法需要可达的 baseUrl 和调用方提供的认证 fetch；该模式不另外实现 Node WebSocket 登录或浏览器凭证读取。

资源适配器属于可选领域。初始化失败后，设置、本地 Agent 和 DSH 原生回合仍可启动；实际调用绑定资源时返回 `RESOURCE_SERVICE_UNAVAILABLE`，不会把失败伪装成空资源。适配器成功但晚于卸载才初始化时，仍由原 owner 立即关闭并拒绝旧任务。

本批验证包括 154 个迁移前成功/失败对照、共享客户端及协议负例、实际 Node HTTP 取消、真实 DSH Connection admission、四种启动状态和开发宿主 UI。真实 DSH 的启动状态使用受控模型，不代表真实模型、云端可用性或已安装桌面更新。阶段 4 最终的冻结 Build、工具续接及适用平台包复核仍以 `refactor-host.md` 的状态为准。
