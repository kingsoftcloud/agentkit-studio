# Windows 发布

新版 Studio 复用 DSH `win-x64` 目标，生成 NSIS `.exe` 安装器、`.exe.blockmap` 和频道 feed。Windows 包与 macOS 包使用同一 Studio 插件、Runtime 合同和 Nexus 图标。

在 GitHub Actions 运行 `Release AgentKit Studio Windows`，传入完整 `studio_ref`、包含该提交的分支及 `build_version`。构建在 Windows x64 Runner 上执行，不需要开发者本地安装 Windows 工具链。

## 签名配置

`studio-signing` Environment 使用 `CERTUM_ACCOUNT`（空时用 `CERTUM_EMAIL`）、`CERTUM_TOTP_SECRET`、`CERTUM_THUMBPRINT`。TOTP 配置支持完整 `otpauth://` URI；仅有 Base32 seed 时按 SimplySign 的 SHA256、6 位、30 秒格式生成。账号已设置不同参数时应使用完整 URI。静态一次性验证码不用于自动发布。

SimplySign 登录后，DSH 通过 Windows 证书存储中的指定叶证书签名。私钥留在 Certum；源码、npm 包和 release artifact 不包含登录凭证、seed 或私钥。云签名安装 action 固定到审阅过的提交，关闭认证截图。

DSH 仍负责签名串行化、失败停止、时间戳、签名缓存、运行时签名和发行者校验。新增的 `certificate-store` 选项只改变 SignTool 选取私钥的方式；默认硬件 token 行为保持可用。

## 验收与停止条件

流水线必须通过：真实签名探针；DSH Windows 打包与内置运行时检查；安装器 Authenticode 指定证书和时间戳检查；在新目录实际运行 NSIS 安装；已安装 App 的签名、真实启动和 Electron 版本检查。证据保存在 `windows-proof`，安装器保存在 `windows-release`。

打包后的 Host 模块检查会解析 `app.asar` 内的真实依赖，拒绝 npm 文件清单遗漏的共享构建文件。官方运行时启动检查按产品名称查找 `AgentKit Studio.exe`，不依赖上游固定可执行文件名。

Windows 运行时检查先把完整签名 App 复制到构建拥有的短路径，再检查签名、ASAR 字节完整性及真实 DOCX/XLSX/PPTX 转换。这样避免孤立源码目录叠加构建目录超过 LibreOffice 原生路径限制；检查结束删除临时副本，安装器仍接受独立的实际安装验收。

签名、安装或实际启动任一失败，流水线失败，停止发布。失败产物不会冒充签名发行包。本机 macOS 源码测试不能替代 Windows Runner 的安装验收。

签名、实际安装和 App 启动验收通过后，可发布独立安装器下载。KS3 版本目录使用 `studio/<version>/AgentKit-Studio-win-x64.exe` 和同名 `.exe.blockmap`，复用现有 KS3 上传器的公开读取和不可覆盖校验；还需核对公网文件的大小、哈希与 Range 下载。GitHub Release 可在同一个桌面版本中同时提供 Mac 和 Windows 包。

Windows feed 位于 `studio/feeds/win-x64/<channel>.yml`，安装器和 blockmap 位于 `studio/<version>/`。已经安装的 `.20261014.7` 查询旧的同 Bucket 路径 `dsh-desk/feeds/win-x64/preview.yml`，发布时为这一版本提供相同内容的迁移入口。迁移不使用旧 Bucket。发布安装器和 blockmap 不代表自动更新已经通过；还需在 Windows 运行线上检查、下载、安装重启和会话数据保留验收。

本地 Windows 可配置 DSH checkout 的 `apps/desktop/.env.windows`，然后在 Git Bash 执行 `make desktop-package-win-x64`。`.env.windows` 是忽略文件，构建结束后孤立源码中的临时副本会删除。无签名测试包使用 `desktop-package-win-x64-unsigned`，文件名带 `unsigned`，不发布正式 feed。

## 无签名诊断

设置 `diagnostic_only=true` 可先跑同一 Windows 打包与 Host 检查，跳过 Certum 登录、签名和安装器验收；该运行只保留隔离构建的诊断记录，不发布 feed，不能当作正式 Windows 发布验收。默认值为 `false`，正式流程继续要求签名、安装和实际 App UI 通过。

## 复用签名候选

`candidate_run_id` 可复用已经通过签名、打包和实际安装检查的运行。`studio_ref` 和 `build_version` 必须与原运行相同；流程从原始日志验证固定源码身份，并校验 GitHub artifact 的 SHA-256 与字节数。`release_tools_ref` 单独固定验收工具提交，不能把新版工具标成已经签名的应用源码。复用仍需重新检查安装器、实际安装、已安装 App 签名以及真实界面；失败的界面检查不会被改写为成功。

## Windows 产品身份与安装界面

Windows 安装包的 Electron 名称为 `agentkit-studio-desktop`，与官方 DSH 的单实例锁和 Electron 设置目录分开。Studio 使用 `.dsh/profiles/desktop-agentkit-studio` 管理插件，并由系统分配本地 Host 端口；DSH 会话、凭证和工作区数据仍保留在原共享目录中。macOS 已发布版本的设置位置保持原样。

安装器的欢迎页、完成页、深色和高 DPI 图片由 Nexus 图标与 AgentKit Studio 字标生成。实际界面验收覆盖原生安装页面的产品图标、点击完成后立即启动的进程路径及 Studio 导航。身份/端口回归测试使用真实 Electron 进程模拟官方身份并占用默认端口；正式发布还要求下载并实际安装官方 DSH，验证两个 App 同时运行、Studio 导航正常且官方插件配置未改动。证据记录官方版本、安装器哈希和两个进程身份；这不代表任意官方版本的全量兼容测试。

## 线上更新验收

运行 `Qualify AgentKit Studio Windows online update`，分别指定验收工具提交、已签名基线运行及源码、基线版本和公网 feed 的目标版本。它实际安装基线，创建一条持久化会话，然后通过安装版原生更新入口从 KS3 下载并确认安装；必须观察到新进程自动重启、目标版本签名有效和原会话可见。模型回复使用隔离的本地测试服务，更新下载、安装器和 App 均为真实发行字节。

`windows-online-update.json` 与原生界面截图记录结果。只有更新器输出完整包与差分下载的实际字节比例时才记录增量下载；全量或缺少下载比例的结果不能称为增量验收。此流程不验证 Windows 回滚。
