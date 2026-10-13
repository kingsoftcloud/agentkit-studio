# AgentKit Studio 视觉约定

使用 Nexus 图标：蓝色圆角方形、白色三节点和中心环、顶部青色节点。产品名称仍为 AgentKit Studio；应用 ID 和用户数据目录沿用现有值。

`src/brand.js` 是图标的唯一矢量来源。侧栏、对话首页、引导、favicon 和插件图标使用相同几何；`scripts/build-brand.mjs --macos` 生成 1024px PNG，由 DSH 打包器生成 macOS App 图标。重新生成 PNG 需要 rsvg-convert。

产品图标固定使用蓝色 `#1858d6` 和青色 `#78dfec`，在浅色、深色主题中保持一致。字标的 Studio 使用蓝色，其余文字跟随 DSH 主题。

页面继承 DSH 字体和主题变量。按钮使用 DSH 的 primary fill / foreground 配对，深色模式随原生控件切换；普通按钮 36px、输入框 32px、正文 14px。边框、圆角、hover、focus 和 disabled 状态遵循 DSH 控件。

模型设置以分段表单呈现，减少嵌套卡片。输入能力来自模型目录，显示文字、图片或明确的未知状态，不保留手动勾选项。高级连接协议默认收起。

样式只作用于 Studio 页面、设置和引导的组件根节点。DSH 原生对话、Dock、插件中心和全局设置继续由宿主负责。
