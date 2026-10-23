# Native 与 DSH/Codex 的 Node Browser

参考版本为 `ksadk-python` 的 `feat-ksadk-harness-2` / `355059d78e47ed764bbdb3606304cdf34e9838a3`。
Native 的持久浏览器会话和 DSH legacy 的一次性页面检查是两种执行契约。前者仍通过
现有 `BrowserSessionRef`、Run、恢复和 Verification 端口运行；后者使用真实 DSH
Agent/Session/call，不构造 Native Run、scope 或执行 fence。

## DSH Native / Codex

`browser_inspect_workspace` 在生产 Node builtin 工厂中注册，缺少 Node 工厂时直接
报 `BROWSER_NODE_PORT_UNAVAILABLE`，不会回落到 Python。显式 `e2b` 命令后端返回
`BROWSER_LOCAL_BACKEND_REQUIRED`，保留参考工具仅在本地后端启用的边界。

默认动态加载已安装的 `playwright-core` 并启动 headless Chromium。可使用绝对路径
`AGENTKIT_STUDIO_NATIVE_CHROMIUM_EXECUTABLE` 指定已有浏览器；运行时不下载浏览器，
不启动 Python 或 uv。使用默认路径时，须预先准备与 Playwright 对应的浏览器资产。

每个调用独占 context/page 和工作区 HTTP 服务，视口 1280×720。仅提供所选 HTML
目录中的普通文件，禁止目录列表、目录外 symlink、写请求和外部页面请求；拒绝
弹窗、WebSocket、Service Worker 和未经重新检查的重定向。这是浏览器路由约束，
不能替代操作系统网络隔离。截图在工作区边界内原子发布。

保留 `path/actions/wait_ms/screenshot_path` 输入、默认等待 1000ms、默认截图路径
`.artifacts/browser-check.png`，以及点击、输入、按键、鼠标移动和等待。支持至多
50 个动作；省略 click/fill selector 时使用 body。额外支持 scroll/reload；一次性
检查不提供可跨调用继续使用的 element_ref。显式等待与 held-input 总预算为 30 秒，
完整工具超时 110 秒；非法输入整批拒绝，不先执行较早动作。

返回标题、HTTP 状态、渲染情况、正文预览、动作结果、console/page/request 错误、
视觉元素数、app 子节点数、Canvas 像素诊断和截图路径。Canvas 诊断使用真实 PNG，
隔离截图期间隐藏 HUD 后恢复原节点样式，不从页面 canvas API 读取像素。Node 的
至多 64×64 采样与 16 色 weighted median-cut 和 Pillow 的 thumbnail/quantize 数值
可能不同；保持 colour_buckets、dominant_ratio、entropy_bits、visually_uniform 和
大面积均匀 Canvas 警告语义。均匀画面只形成诊断，不独立判定任务完成。

完整原请求及 Agent revision、Frozen Build、工作区、后端和浏览器路径绑定在创建
浏览器之前写入独立的 `agentkit.dsh-node-browser/v1` 持久记录。完成后的重复调用
返回原回执；执行中断、SIGKILL 或动作结果未知后不重新打开或重放原动作。参数或
绑定改变不能复用旧 call。实际 DSH 策略、审批和后置处理继续生效；Node 端口另在
副作用前检查 standing policy 和精确调用的单次审批。

与参考 Python 的差异：动作开始后若无法确认结果，会停止剩余动作并返回明确的
uncertain，而非继续执行整批；不会以新 call ID 自动重试。显式输入预算、路由限制
和未知状态属于新持久化执行契约，产品中的人工核对入口仍需完整验收。

取消时按 Context → Browser → 文件服务的顺序关闭资源。并发关闭 Context/Browser
曾在实际导航取消时触发 30 秒驱动等待，已修复并以关闭顺序断言覆盖。每个资源关闭
另有 5 秒上限；到期仍继续关闭其他资源，调用回执保留 uncertain，owner.close 明确
抛出 cleanup_unknown。超时只说明清理未知，不能当作 Chromium 已退出的证明。

本批定向验收：Node 26.5.0 与 22.19.0 各 76 项受影响测试通过，未跑全量或跳过
测试。实际 Chromium 覆盖动作、Canvas 像素、网络拒绝、取消/退役/超时、SIGKILL
及新 Node PID 不重放；故障注入另覆盖关闭卡住与迟到资源关闭抛错。Canvas 数值
在首次回执中规范化零值，确保 JSON 持久化与冷恢复不出现 -0/0 差异。

四项实际打包 Host 验证通过（两种 Node × local/E2B 配置）：真实 DSH Native、Codex
注册器、审批/后置处理、重复调用，以及旧 Host 退出后新 PID 读取同一原回执和 PNG。
冷启动前已替换 HTML，仍返回原标题且 PNG/记录字节不变。E2B 配置明确拒绝本地
Browser；E2B 其他工具使用真实 SDK 和刻意拒绝的端点，只证明拒绝/恢复边界。
该验证运行于 Node/bash PATH、Python 不可用环境，依赖固定的已安装依赖图；不代表
全新安装、真实模型/Codex CLI 或在线 E2B 成功。具体日志及归档摘要见迁移证据记录。

已另对照参考的 `studio/native_browser_port.py` 和 `harness/browser_adapters/native_playwright.py`：
Native 持久 Browser 本来就没有上述 Canvas 诊断，且动作上限为 20；目前 Node 同样
保持这一语义。此前把这两项列为 Native 缺口是混淆了两种入口，现已纠正。Native
原有 BrowserSessionRef、BrowserObservation、progressObservationDigest 和 Verification
契约继续独立保留。完整 Python bridge 替换、线上服务、全新安装、模型/CLI 和全
Studio 入口验收继续保留在原迁移目标内。
