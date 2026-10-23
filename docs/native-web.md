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

已执行 Node 26 与 Node 22 的相关验证，覆盖本地真实 HTTP、DNS dispatcher、ArtifactStore 落盘、工具策略、Host Run ledger/model 回放和 provider 绑定变化拒绝。标准 preset 的原 Web 插件由整轮 Native preset 排除，防止同一工具名重复注册；其他 runtime 保留原配置。

`node scripts/verify-studio-native-harness.mjs --source <维护宿主构建目录> --mount-host --web --keep` 实际打包并挂载 Studio Host，通过公开 SDK 与认证 preset RPC 连续执行搜索、抓取及模型回放，重启 Host 后续聊。它核对两个 completed Run、四个成功工具调用的持久化 intent/receipt、完整 Unicode ArtifactStore 内容、六次模型请求的公开流与 Session 落盘字节，并验证默认 DSH。Node 26 Revision 与 Node 22 Frozen Build 两种场景均已通过；后者添加 `--frozen`。验证使用 Node-only PATH 和现有本地依赖图。搜索协议使用确定性本地 HTTP 响应；未宣称已验证线上搜索服务、完整冷安装或浏览器 UI，整个 Native 迁移仍有其他能力待完成。

`createWebToolTransport` 是已授权调用共用的 Node 网络实现，供 DSH builtin 适配层使用。它接受真实 Session/call、正式工具定义、JSON 上下文及取消信号，不创建 Native Run 或授予执行权。`createNativeWebTools` 仍在调用该实现前核对完整 Native 身份、冻结定义、授权及上下文。共享实现保留 DNS/SSRF、DOM、按秒超时、搜索提供方及输出持久化回调，未配置搜索返回明确错误。两个 Node 版本各通过原四模块 51 项及新增共用接口 3 项定向验证。

Studio Host 的 DSH Native、Codex builtin 现通过 `createDshNodeBuiltins` 组合原十个 workspace 工具与 Node Web 适配器，沿用实际 DSH ToolRegistry 注册和权限/展示管线。显式 Studio Web 绑定替换标准预设中同名的 Web 插件；没有绑定的普通预设保留原插件。Web 适配器在每个网络、重定向及持久化边界核对原 Agent、Session、callId、参数和原取消信号，公开定义不能修改内部 schema。宿主或注册退役会取消实际 fetch；不合作的网络 Promise 也不能阻止调用及时结束或晚返回成功。

`node scripts/verify-studio-node-builtins.mjs --source <built-maintained-dsh> --archive <Studio.tgz> --keep` 在实际打包 Host、维护版 SDK、生产预设和实际 Session 上，同时检查 DSH Native 与 Codex：本地 HTTP 网页/搜索协议，真实 `pre → guard → around → post → result`，两种拒绝均零 HTTP 请求，后置内容替换及进行中取消。两种 Node 版本均通过，工作区权限、一次性审批和跨 Session 读取状态的原验证保留。仅含 Node 的 PATH、不可用 Python 路径下完成这些工具调用；没有模型请求、没有调用 Codex CLI，普通依赖仍来自固定本地图，不能替代完整模型回归或全新依赖安装。

Legacy Host 已默认绑定 Node 全文存储。`web_fetch` 超过 `max_chars` 后，在工作区外的私有 Host 状态目录保存完整提取正文和元数据，返回 `persisted.path`；如果响应达到网络字节上限，仍保留原 `body_truncated_by_byte_ceiling` 标记，不能把已截断的网络响应说成完整网页。存储按真实 Agent、Session、call、完整参数及正文摘要隔离，原请求与元数据共同决定不可变条目，不创建 Native Run。正文与元数据各自刷盘后，以一次目录重命名发布；并发写入使用各自的暂存目录，冷重开核对完整元数据、字节数及 SHA-256，再复用同一引用。损坏、不完整、链接替换或权限不合要求的已有条目返回保存失败，不覆盖原条目。取消、关闭与原调用漂移同样失败关闭。

定向五模块在 Node 26 与 22 各通过 104 项，另一个嵌套 Node 22 用例首次因探测路径跳过，指定实际二进制后单独通过。文件存储验证包含八个真实进程竞争，以及发布前、发布后真实 SIGKILL 后重开。上述打包验收器也在两种 Node 上，通过实际两条 runtime 和各两个 Session 核对 Unicode 全文、摘要与隔离路径；两种拒绝仍没有 HTTP 请求。验证运行于 macOS，进程强杀证据不等同于所有操作系统或断电持久性证明。

Native 路径继续绑定原 ArtifactStore。其他 builtin 的 Python fallback 及 Frozen 导出能力分类仍须迁移，不能凭这些 Web 工具的通过宣称 Python bridge 已完整移除。
