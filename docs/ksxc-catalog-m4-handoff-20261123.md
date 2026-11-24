# KSXC Catalog 与 M4 联调交接（2026-11-23）

## 已交付

| 项目 | 结果 |
| --- | --- |
| Studio | feat/ksxc-studio-v2，HEAD 9a0efd95，已 push。包含托管 MCP 的 ID-only 资源凭证引用校验、env_refs/envRefs 兼容读取和回归测试。 |
| Server 源码 | feat/ksxc-mcp-apikey-test1105，HEAD 93243184，已 push。远端 test-1105 当前已继续前进到 c231bacb，且包含 93243184。 |
| Server Host 镜像 | hub.kce.ksyun.com/bigdata-ai/agentengine-server:pre-0.0.0-254-c231bacb27990e1f9859aeca9126d7923139ee4d，digest sha256:6fe9ea80f770ab86c3d6c4642abaefe9f2328b8518bc0094202bd6844109e428，已在预发滚动发布。 |
| KSXC 运行时 | 1.8.0-studio.0.0.22-a4156fe5-relay.10，镜像 digest sha256:16017351f618b8c72a3ec4c45f0c8526ab599852c2bdeceef14b4d3726a22906。 |

## Server 分支处理

用户要求 Server 从 dev-1113 合入 test-1105。核对最新远端后，dev-1113 中相关候选提交在 test-1105 已经等价存在，直接完整 merge 会把大量无关差异带入测试分支。因此采用当前 test-1105 为基线，保留等价改动并提交 93243184，最终 origin/test-1105 与该提交一致。

Server 定向测试结果为 271 passed, 3 skipped。覆盖 tests/test_dsh_resource_contract.py 和 DSH MCP 资源代理 HTTPS 归一化测试。3 个 skip 仅因为未配置专用生命周期 PostgreSQL。

## Catalog 与 Agent 证据

- Catalog 版本为 1.8.0-studio.0.0.22-a4156fe5-relay.10，输入只使用 version、baseUrl、installerUrl、code、image、sha256、manifestSha256 和 helmRevision，由 Server 同步时补齐 manifestFormat 与 resourceContract。
- 新建 Agent ar-20261123201208-3766d025 已达到 RUNNING、ReadyReplicas=1、DeploymentState.Phase=READY。
- 观测版本 ID e28c3c26-d777-42d9-a678-f1674b28e91b。
- Manifest SHA-256 25ebe6e5d0e15cb29955882ecd10765152db347a58862259866e8d781f97ff91。
- Pod init verifier 已通过 KSXC payload 完整性校验，KSXC payload SHA-256 为 e3a78ecd7eecded8ee4c4fa8234825899813b713ae578b36d0b351a45c4e36d6。
- Server 资源代理实际返回 200，并返回 HTTPS mcp_endpoint 以及 Authorization 的显式凭证引用。

## M4 真实单账号结果

- MCP mcp-20261123201156-y1i90h 已部署并 Ready。
- MCP Pod 本体通过直连 Streamable HTTP 发现 add、echo，直连调用 add(2, 3) 返回 5。
- Agent 会话 m4-180-tool-apikey-tls-1795436988 已创建，Run 已完成，模型返回 5。
- 该 Run 没有注册 add 工具，也没有产生 mcp_approval_request，所以不能把它记为工具调用或审批通过。

## 网络配置结论

- MCP 公网 DNS A 记录当前为 111.31.99.49，TTL 600 秒。
- 预发 serverless-public-ingress-controller 和 agentengine-gateway-gateway 当前 LoadBalancer 地址为 120.92.44.162。
- 使用 DNS 地址 111.31.99.49 访问 POST /mcp 返回 503 upstream timeout。使用同一 Host 强制解析到 120.92.44.162，Bearer API Key 初始化返回 200，tools/list 返回 add、echo，tools/call add(2,3) 返回 5。
- 内部 Serverless Ingress（地址已脱敏）加 MCP 内部 Host 也返回 200。
- 现象说明 DNS 仍指向旧或错误的公网入口，公网 POST 没有到达当前 MCP Ingress。B 需要让 MCP 公网 DNS 指向当前 120.92.44.162，或修复 111.31.99.49 对应入口的 MCP POST 转发。

## 当前剩余阻塞

预发 MCP 网关在托管 Agent Pod 到公网 MCP Endpoint 的 Streamable HTTP POST /mcp 上仍未形成可用链路。直连 API Key 的 GET 能到达网关，但初始化 POST 出现 503 upstream connect error or disconnect/reset before headers，部分重试会返回 401 Missing ae_ui_session cookie。因此问题已从 Host 凭证传递收敛到预发 MCP 网关的 POST 转发/鉴权配置，不能用当前结果宣称工具和审批验收通过。

## 第二个 WPS 账号

第二个真实 WPS 企业账号仍未提供。本账号不能伪造第二身份。B 需要用第二个已获准账号完成连接隔离、模型权限、会话隔离、工具调用和审批验收，并回填两个账号的 AgentId、SessionId、RunId 与审批结果。

机器证据见同目录 ksxc-m4-evidence/catalog-m4-live-evidence-20261123.json。交接材料不包含账号、Cookie、API Key 或其他明文凭证。
