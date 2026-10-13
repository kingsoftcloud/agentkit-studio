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

Windows feed 和 KS3 公开发布须另通过在线下载及真实更新验收；仅生成安装器不能算 Windows 增量升级已通过。

本地 Windows 可配置 DSH checkout 的 `apps/desktop/.env.windows`，然后在 Git Bash 执行 `make desktop-package-win-x64`。`.env.windows` 是忽略文件，构建结束后孤立源码中的临时副本会删除。无签名测试包使用 `desktop-package-win-x64-unsigned`，文件名带 `unsigned`，不发布正式 feed。

## 无签名诊断

设置 `diagnostic_only=true` 可先跑同一 Windows 打包与 Host 检查，跳过 Certum 登录、签名和安装器验收；该运行只保留隔离构建的诊断记录，不发布 feed，不能当作正式 Windows 发布验收。默认值为 `false`，正式流程继续要求签名、安装和实际 App UI 通过。
