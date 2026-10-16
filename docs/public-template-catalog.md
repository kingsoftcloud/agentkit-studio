# 公开模板目录

新安装 Studio 默认读取预发目录，无需本机 3210 服务，也无需先安装模板包。已配置云凭证时优先读取预发 Server 的四个模板 Action；未配置凭证或接口暂不可用时，读取同一个 Server 目录的 KS3 匿名快照。失败后短暂退避，避免每张图片重复尝试不可用接口。

公开 bucket 为 `agentkit`，环境通过目录隔离：

| 环境 | 资源和快照根目录 |
| --- | --- |
| 预发 | `studio-templates/pre-online/v1/` |
| 线上 | `studio-templates/online/v1/` |

`AGENTKIT_TEMPLATE_ENVIRONMENT=pre-online|online` 或用户存储目录下 `template-source.json` 的 `environment` 字段选择环境。模板环境只作用于模板读接口，知识库、记忆库、部署等继续使用原云资源设置。`AGENTKIT_TEMPLATE_SERVER_URL` 和 `template-source.json.origin` 保留为显式本地开发入口；离线自有目录需要显式 `source: local` 或 `AGENTKIT_TEMPLATE_CATALOG_FILE`。

目录列表仅加载摘要。点卡片上的“召唤”仍走现有 Agent 创建服务：按摘要获取完整定义、按需下载资源、核验 ZIP 文件清单、安装 Skill、检查 MCP，再创建普通可编辑 Agent。专家团仍锁定角色模板并通过 agent-teams 创建、编辑成员和运行。知识库和记忆库绑定仍走同一套现有绑定逻辑。

DMG 只内置客户端和少量离线种子；迁移包与图片均留在 KS3。首次浏览需要目录与图片流量；只有安装相关技能或召唤专家时才下载 ZIP。模板缓存按环境和用户身份隔离，下载支持进度、续传、取消和摘要校验。已有 Agent 不随目录更新而被覆盖。

维护端先审核来源并保留原始许可信息，确认再分发授权后依次发布资源、Server 目录、匿名快照，最后更新本环境 `latest.json`。使用 `scripts/templates/publish-public.mjs assets|snapshot`，必须显式给出 `--environment`、`--bucket`、`--owner` 和输出目录。`assets` 还要求 `--catalog`、`--paths`（资源 SHA 到本地原文件的映射）、`--revision` 及 `--redistribution-confirmed`。`snapshot` 要求 Server 维护工具导出的 `--snapshot` 目录。凭证只从 Host 配置读取，不写入快照。线上发布需独立执行，禁止跨环境引用文件。
