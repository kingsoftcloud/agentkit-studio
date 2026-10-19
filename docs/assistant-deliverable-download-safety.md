# 云端产物下载的安全边界

## 当前结论

固定 DSH 基线 `687f282e8625c6b8d11ff58211a90524be2e4317` 提供两种不同的文件事实：

- 原生消息中的 `file` 内容块携带 `attachmentId`、`bytes` 和可选 `name`，指向持久化附件。Studio 可以先核对当前云端 Session 的公开内容引用，再通过官方 `AttachmentStore.readFileStream` 完整读取、限定大小并核验 SHA-256 后下载。
- `deliverables/presented` 只有路径声明，没有不可变字节或附件回执。该类产物保持 `metadata-only`，不能因为文件附件可下载，就宣称所有云端产物都可下载。

快照中的 `display.files` 只表示原生附件文件的下载能力；`display.deliverables` 必须明确为 `metadata-only`。界面不得把文件名、路径、URL，或 `presented` 声明上额外出现的伪附件字段升级为下载权限。实际读取仍由服务端对绑定的云端 Session 重新核验，前端能力显示不承担授权。

## 核查过的官方接口

路径均相对于固定 DSH checkout：

1. `packages/deliverables/tool-present/src/index.ts` 和 `types.ts`：`present` 检查当前文件后写入 `{ turn, callId, files: [{ path, description? }] }`。它不复制文件，不调用附件保存接口，也不产生 `attachmentId`。
2. `packages/client/ui-deliverables/src/present-open.ts`：`registerPresentOpen` 注册 `/api/present.open`。内部处理器从 `sessionQuery.readEvent` 取得原生事件及 `seq/index`，调用 `workspaceFiles.stat`，再交给 `sessionController.openWorkspacePath`。读取事件前要求 Host desktop 可用。返回值是应用列表或打开确认，不是文件字节、快照或下载回执。
3. `packages/api/session-controller/src/index.ts`：`openWorkspacePath` 核验路径并启动 Host 原生打开动作，没有“只返回快照”选项。复用这个接口会误把云端下载变成在服务端打开文件。
4. `packages/api/workspace-files/src/index.ts`：公开的 `WorkspaceFiles.readBytes(scope, path, {}, signal)` 返回 `{ absolutePath, version, bytes?, offset, data, eof }`，通过组合的 `ctx.fs` 读取。Session cwd 是相对路径基准，不是文件读取的强制隔离边界；此服务按设计允许读取文件系统授权的工作区外文件。
5. `packages/fs/fs-local/src/fsio.ts` 的 `readWholeBytes`：先 `statRegularFile`，再 `createReadStream(target.targetKey, ...)`。字节上限可限制文件增长，但没有固定已核验文件的描述符，也没有阻止最后一级或祖先目录在检查后被换成符号链接。
6. `packages/api/session-controller/src/commands.ts` 的 `attachment`：这条现有 RPC 只查 `referencedImage` 并调用 `readImage`，不能当成通用文件读取接口。通用文件读取使用 `packages/attachment/attachment/src/index.ts` 的公开 `AttachmentStore.readFileStream`，并需要调用方独立完成 Session 归属授权。
7. `AttachmentStore.saveFile` 和 `saveFileStream` 接受已经取得的字节或流，不接受已验证路径。它们不能替代路径读取安全检查，也没有现成的 `presented` 到附件回执桥接。

上述 API 均不能直接构成满足“禁止符号链接和检查后替换越界”的路径产物下载。额外做一次 `lstat`、`realpath`、目录前缀比较，或比较前后大小，都不固定随后打开的文件。绕过组合文件系统直接使用 Node 路径读取也会绕开后端权限语义；Studio 不使用此类替代实现。

## 可复现的合成探针

在已安装依赖并构建的固定 checkout 上运行：

```sh
AGENTKIT_DSH_ROOT=/path/to/pinned-dsh node scripts/verification/verify-assistant-deliverable-boundary.mjs .artifacts/assistant-deliverable-boundary.json
```

探针只在自己的临时目录内创建、读取并清理合成文件，不读取用户文件，不连接账号、网络或模型，不修改上游源码或补丁，也不启动本机打开器。它调用真实构建的公开 `LocalFileSystem` 和 `WorkspaceFiles`；确定性的文件替换使用上游已经存在的 `inspectReadBytesAfterStat` 测试接缝。

六个断言覆盖：正常文件、请求前已有符号链接的拒绝、检查后最终路径被换成符号链接、检查后祖先目录被换成符号链接、超限文件拒绝、检查后文件增长的拒绝。两个替换案例实际取得 `synthetic outside fixture`，并断言其不同于预期工作区内容；两个合成内容长度相同，因此返回的字节数检查也通过。

探针成功只证明上述基线行为可复现，报告始终标记 `safeForPathDeliverableDownload: false` 和 `pathDeliverableDownload: blocked`。它不是下载安全验收通过。若未来上游阻止了替换，反例断言会失败，提示重新审查接口及其保证，而不是静默开启能力。

## 后续开放条件

需要上游提供可公开使用、属于对应组合文件系统的安全快照能力，或让 `present` 本身返回持久化附件回执。安全快照必须固定实际打开的对象，保证最终分量和祖先替换不会越过授权边界，核验已打开对象为普通文件并实施硬字节上限；不能只是路径检查后再重新打开。

Studio 的未来入口只能接收绑定云端会话及原生事件 `seq/index`，不接收客户端路径、URL、任意 Session ID 或本机执行目标。服务端读取原生事件取得路径，按照其 Session cwd 和对应文件系统权限获取快照，完成大小、类型、完整性验证后才返回下载回执。取消、文件变化或验证失败必须无字节返回；浏览器以附件下载处理内容，不把活动文档嵌入同源页面。接入前需补齐身份、越界、并发替换、大小、取消及损坏反例的真实后端测试。
