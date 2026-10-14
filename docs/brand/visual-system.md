# AgentKit Studio 视觉约定

使用 Nexus 图标：蓝色圆角方形、白色三节点和中心环、顶部青色节点。产品名称仍为 AgentKit Studio；应用 ID 和用户数据目录沿用现有值。

`src/brand.js` 是图标的唯一矢量来源。侧栏、对话首页、引导、favicon 和插件图标使用相同几何；`scripts/build-brand.mjs --macos` 生成 1024px PNG，由 DSH 打包器生成 macOS App 图标。重新生成 PNG 需要 rsvg-convert。

产品图标固定使用蓝色 `#1858d6` 和青色 `#78dfec`，在浅色、深色主题中保持一致。字标的 Studio 使用蓝色，其余文字跟随 DSH 主题。

页面继承 DSH 字体和主题变量。按钮使用 DSH 的 primary fill / foreground 配对，深色模式随原生控件切换；普通按钮 36px、输入框 32px、正文 14px。边框、圆角、hover、focus 和 disabled 状态遵循 DSH 控件。

模型设置以分段表单呈现，减少嵌套卡片。输入能力来自模型目录，显示文字、图片或明确的未知状态，不保留手动勾选项。高级连接协议默认收起。

样式只作用于 Studio 页面、设置和引导的组件根节点。DSH 原生对话、Dock、插件中心和全局设置继续由宿主负责。

配置引导参考 DSH `ui-settings-account` 的全屏欢迎页：左右布局、28px 标题、留白和44px主按钮。Studio 自己的 Nexus 图标和模型配置预览替代官方账户插图。点“开始设置”后直接填写模型，保存后进入可跳过的云端凭证步骤；模型设置与常规配置页共用保存和 DSH 同步逻辑。API Key 使用眼睛按钮切换本次输入的可见性，保存清空后重新隐藏。Endpoint 补全协议、默认 `/v1`，去掉已知操作后缀并保留自定义网关前缀。

缺少模型凭证时自动显示，已配置用户不弹出，设置页可手动重开。使用 DSH Modal 的焦点、Escape、主题和 Settings onboarding 完成机制。Studio 产品 profile 关闭 `ui-settings-account`，避免它的独立全屏欢迎和充值流程叠在 Studio 引导上。

Studio 设置与原生偏好设置使用相同的 14px 标签、12px 说明和 16px 行间距。版本号作为普通值展示，不使用状态徽章。手动配置 Agent 使用轻量步骤导航与单一表单分区，窄窗口转为纵向布局。开始前检查只显示已读取的配置事实，不用固定评分表示运行时就绪。
