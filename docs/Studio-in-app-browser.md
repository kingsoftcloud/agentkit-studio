# Studio 内置浏览器入口

基线：DSH `639ed015`（`0.2.0-rc.2`）。

## 复用与缺口

DSH 的 `ui-sidebar-browser` 已提供桌面 WebView、URL 校验、导航、恢复和安全策略；`sidebarRight.openTab('browser', {params: {url}})` 是公开入口。`ui-chat` 已通过 `ui-chat.linkOpening=sidebar` 打开对话中的 HTTP(S) 链接，默认也是 `sidebar`。Studio 保留该设置及原生链接处理。

此基线没有向 Agent 提供“在当前界面打开网页”的工具。Studio 只补 `studio_open_browser` 和短暂的 UI 命令传递：DSH ToolRegistry → 已认证 Connection → 当前会话的 Sidebar → 界面回执。没有另建浏览器、会话存储、持久化或流式协议。

## 行为

- Agent 请求内置浏览器时调用 `studio_open_browser({url})`；PTC 中通过 `run_code` 调用 `tools.studio_open_browser(...)`。
- 只支持无内嵌凭证的 HTTP(S) URL。本地 HTML 先用本机 HTTP 服务承载；文件仍由 DSH 文件预览处理。
- 请求的会话身份来自 DSH execution，模型不能指定其他会话。界面只领取当前可见会话的请求；异步期间切换会话即失败。
- 工具等待界面确认标签页已打开，30 秒无回执则报错。“标签页已打开”不表示网页已加载，也不表示 Agent 能读取或操作网页。
- 取消、卸载、超时后删除请求，重启或浏览旧的工具记录不会再次打开网页。多窗口通过一次性 claim 避免重复消费。

## 验收

`node --test tests/studio-browser-ui.test.mjs` 覆盖注册、真实客户端入口、工具到界面的往返、切换会话、失败回执、取消和卸载。它是源码回归证据。

正式包还须实际安装并验证：①让原生 Agent 在内置浏览器打开 GitHub；②点击对话内 HTTP(S) 链接；③网页出现在同一会话的右侧并加载成功。截图、AX、签名包源码哈希和安装版本一起记录，完成前不能写“真实验收通过”。
