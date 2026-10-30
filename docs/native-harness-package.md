# Native Harness 包接入

Native 内核和 Node 适配器在独立的 `ksadk-harness` 仓库维护。Studio 使用 `@kingsoftcloud/agentkit-harness-core` 和 `@kingsoftcloud/agentkit-harness-node` 包，产品侧的会话、资源和界面适配留在 Studio。

当前两个包以固定版本的 tarball 放在 `vendor/native/`，随 Studio 打包；尚未发布到 npm 仓库。更新时先在 Native 仓库运行 `npm ci --ignore-scripts` 和 `npm run build`，分别打包 core 和 node 包，再将产物放入 `vendor/native/`，同步 Studio 的依赖版本、pnpm override 和锁文件。运行 `node scripts/verify-native-dependencies.mjs`，并验证 Studio 打包及 Host 的 Native 任务链路。

Node 包提供独立进程接口，供其他语言通过 JSON-RPC 接入；具体协议见 [Native 外部进程接口](./native-rpc.md)。Python SDK 桥接不在本次迁移范围内。
