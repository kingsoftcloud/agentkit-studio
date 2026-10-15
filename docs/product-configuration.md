# 产品配置

阶段 5B 正在实施。`src/product.json` 是 Studio 产品输入的定义，`scripts/product-config.mjs` 是构建侧解析接口。当前已接入插件品牌、Makefile 默认值和隔离桌面打包；DSH 核心中的品牌文案、发行工作流及完整默认产品验收仍待迁移，不能据此标记 5B 完成。

| 输入 | 维护位置与解析规则 |
| --- | --- |
| 产品名称、简称 | `brand`，插件展示与桌面标题共享 |
| 插件版本 | `package.json#version`，配置只声明来源，不再维护第二份版本号 |
| 桌面版本 | 显式 build version 优先，否则使用固定 DSH 版本；仍由官方打包 CLI 接收 |
| App ID | `desktop.appId`，进入临时平台配置 |
| 更新源和通道 | `desktop.updates` 提供默认值；平台发行文件可显式选择 HTTPS origin、stable/preview 与环境，统一由解析接口校验 |
| 默认 bundle、插件入口包 | `desktop.defaultBundles`、`desktop.pluginRoots` |
| 图标和平台输入 | `desktop.platforms`，相对路径解析至当前源码目录，拒绝目录逃逸 |

发布签名、证书和凭证继续由 `.env.macos` / `.env.windows` 持有。临时配置将公开产品设置与原有发行设置组合，保留凭证值和相对证书路径的既有处理；不将签名材料写入产品 JSON、报告或客户端。打包结束清除临时发行文件。

配置只声明桌面默认 bundle。已有 Profile 的安装、用户禁用与迁移仍由 DSH 的产品默认 bundle 机制处理，不能通过重新写入 bundle 列表来强制启用用户已禁用的插件。最终 5B 验收还需在实际 DSH 上验证新 Profile、旧 Profile 和禁用后重启，并验证不加载 Studio 配置时的默认 DSH 行为。

后续将品牌文案迁到可卸载的宿主产品接口，替换修改 DSH 固定文案的补丁，再将发行工作流的产品字面量接入此配置。每次删除补丁继续要求原行为用例及最终宿主和安装包验收。
