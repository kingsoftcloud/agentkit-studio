# Studio Expert Catalog

独立的 DSH 目录服务插件。Studio 默认携带并启用它，提供 6 类场景、18 个自有单专家模板。模板使用现有 `spec.runtime / instructions / bindings / memory`；创建后的专家仍由 Studio 原有 Agent Store、Revision、Build 和运行时管理。

## 接线

- `src/index.mjs`：Cordis 插件入口，提供 `studioTemplates` 服务。服务的 `list/get/prepare` 返回隔离副本，版本和摘要共同固定模板内容。
- `src/catalog.mjs`：目录校验、准备创建初值、从普通 Agent Revision 导出公共定义。公共种子不得包含作者的模型、知识库、记忆库或连接引用。
- `src/seed.mjs`：自有内容、分类、示例和资源需求。没有 WorkBuddy 网络或文件依赖。
- `src/client.mjs`：可嵌入的 React 页面工厂；Studio 构建时嵌入其 UI，并注入现有创建页和 Host RPC。插件不复制 Agent 编辑器。

Studio Host 的桥接契约为 `agentkit.studio.templates/v1`：`templates/list`、`templates/prepare`、`templates/export`。创建仍调用 `agents/create-local`，编辑仍调用 `agents/update-local`。Host 校验固定来源版本及当前身份可用资源，重新生成平台绑定；来源保存在 `metadata.templateSource`。

知识库检索与记忆读写沿用 Studio 的平台资源适配器。模板只声明资源需求，创建者选择自己的资源。启用记忆时必须选择记忆库，可选显式写入或候选写入策略。目录中的“多运行时”是定义兼容范围，不能替代模型和绑定资源的实际运行验证。

## 内容整理与发布

1. 从已验证的 Agent Revision 通过 `exportTemplateDefinition` 导出已有定义字段。导出会移除环境绑定并生成资源需求；不支持的插件依赖会阻止导出。提示词属于作者内容，仍须审核其中是否手工写入私密信息。
2. 为定义补充稳定 ID、语义版本、分类、标签、至少两个示例、交付物、来源与验证记录。首期内容统一维护在 `seed.mjs`，不引入另一套 Agent 文件格式。
3. 运行 `pnpm test` 和 Studio 根目录 `pnpm check`，验证普通创建、编辑、Revision、Build 的往返。用真实 Host 验证目标运行时、知识检索和记忆行为；结果独立记录。
4. `pnpm pack:catalog` 生成独立插件包；Studio `pnpm pack` 同时携带它和相同版本的客户端种子，离线可浏览。变更内容必须增加模板版本和目录 revision。

Studio 可通过配置连接不可变版本目录和按需资源下载服务。未配置时只提供内置原创目录，不携带开发者的个人导入或账号授权。团队协作复用官方 Agent Teams；成员准入、配置冻结和运行限制见 [专家目录与本地团队](../../docs/expert-catalog.md)。公共内容发布前必须审核来源与许可，个人导入文件不能直接作为公共发行内容。
