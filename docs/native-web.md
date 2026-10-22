# Native Web 工具

`runtime.type="harness"` 的 builtin `web_fetch` 与 `web_search` 已接入 Node 工具入口。Agent 必须显式绑定对应工具；同名 MCP 工具继续使用其原绑定。工具经过现有 DSH 策略管线，完整调用身份、正式定义、取消信号及执行 fence 由 Native Run 提供。模型不能选择搜索服务端点或凭据。

`web_fetch` 默认只访问公共 HTTP(S) 地址。每次跳转重新检查目标，最多五次请求；实际连接的 DNS 结果也经过地址检查。IPv4、IPv6 私网、环回、保留、多播等地址拒绝连接，混合公私地址的 DNS 答案整体拒绝。每次调用的截止时间覆盖 DNS、所有跳转及响应体读取。超时返回 `error_type="timeout"`；用户取消向原执行者传播。

HTML 使用现有 parse5 解析器提取文本，排除脚本、样式等节点；预览按 Unicode 码点截断。超过 `max_chars` 的文本写入当前 scope 的 ArtifactStore，返回 `persisted.path`；落盘失败明确返回 `persisted.failed`。响应体另有 10 MiB 读取上限，达到上限时返回 `body_truncated_by_byte_ceiling`，不会把被截断的响应称为完整输出。

搜索服务从 Host 启动环境读取，并在 preset 创建时固定：

| 配置 | 用途 |
| --- | --- |
| `KSADK_WEB_SEARCH_PROVIDER` | `http`、`ksyun`；`fake` 仅用于确定性验证 |
| `KSADK_WEB_SEARCH_BASE_URL` | HTTP 搜索地址；Ksyun 可省略以使用参考默认地址 |
| `KSADK_WEB_SEARCH_API_KEY` | 搜索服务 Bearer 凭据 |
| `KSADK_WEB_SEARCH_SCOPE` | Ksyun 搜索范围，默认 `webpage` |
| `KSADK_WEB_SSRF_POLICY_JSON` | `web_fetch` 地址策略，默认禁止私网 |

保留参考实现的 `OPENCLAW_WEB_SEARCH_*` 配置兼容，以及 Ksyun 的备用密钥变量。仅布尔值 `allow_private:true` 或 `allowPrivate:true` 允许模型抓取私网；字符串 `"false"` 不启用。可信 Host 配置的搜索服务可部署在私网，无需放开模型 URL 的地址策略。搜索不跟随服务端跳转发送凭据。对外配置删除凭据和 URL 查询串；完整路由及凭据的摘要参与 Run 绑定，配置变化不能继续同一已封存 Run。

对照版本为 KsADK `feat-ksadk-harness-2` 的 `355059d`。保留模型可见的请求、结果及主要错误语义；HTML 解析和网络异常类名允许 Node 与 Python 的差异，Node 额外显式报告响应体上限。

已执行 Node 26 与 Node 22 的相关验证，覆盖本地真实 HTTP、DNS dispatcher、ArtifactStore 落盘、工具策略、Host Run ledger/model 回放和 provider 绑定变化拒绝。搜索协议使用确定性本地 HTTP 响应；未宣称已验证线上搜索服务、完整冷安装或浏览器 UI。实际打包 Host 验收另行记录，模块通过不代表整个 Native 迁移完成。
