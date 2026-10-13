# 公开发布边界

公开版保留工程说明、AGENTS.md 和金山云服务域名。内网可达性与是否允许公开域名是两回事；已批准的客户端地址包含 aicp.inner.api.ksyun.com、iam.inner.api.ksyun.com，以及历史引用中的 aicp.internal.api.ksyun.com 和 inner.api.ksyun.com。

审计仍阻止真实密钥、URL 中的真实凭证、个人认证配置、用户数据目录和本地运行产物。历史文档中的分类标记、旧 checkout 路径，以及经确认的示例凭证不等于真实凭证；密钥扫描仍覆盖它们，AGENTS.md 也没有豁免密钥检查。

运行 `make public-gate` 检查当前源码及 main 可达历史；在完整仓库备份或克隆上运行 `node scripts/public-history-audit.mjs --all-refs` 检查所有分支和 tag。发布前另外以 Gitleaks 的 `--log-opts=--all` 扫描完整 Git 历史，报告仅保留脱敏结果。

源码检查通过不代表安装包验收完成。签名包还需通过包内模块检查、实际启动、Agent 绑定与执行、交付物展示及更新验证；未通过的包不更新线上 feed。
