# Desktop 的 Node Office 资源

维护源码 `c7e4398390cdd0cf2604ce48acd40d84bd896068` 将 Desktop 的 Office 创作切换到 Node，沿用七个 Office Skill 和原有 LibreOffice 操作。SDK 的独立 Python 默认配置保留；Studio Desktop 准备与使用的资源不含 Python。

## 准备与使用

运行已有 Desktop 准备流程重新生成资源。共享构建器也可直接使用：

```sh
pnpm run build:artifacts
pnpm run prepare:primary-runtime --target mac-arm64 --output /absolute/resource-directory --node-only
```

资源包含独立 Node、pnpm 和 `dependencies/node/node_modules/office.mjs`，没有 Python 目录或 wheel。`runtime.json` 使用 `schemaVersion: 2`，通过 `officeLibrarySha256` 绑定文档库字节。资源解析、离线安装、复用及 Studio 预检均检查该摘要；修改库文件后必须重新准备资源。

`load_workspace_dependencies` 返回绝对 `node` 和 `officeLibraries` 路径。任务脚本用该 Node 执行，通过 `pathToFileURL(officeLibraries)` 导入文档库，不安装 npm 包或寻找系统解释器。Desktop 选择 `authoring: node`；自定义 Office 提供者需显式选择该配置。

模块包含 docx、ExcelJS、PptxGenJS、Arquero、XML/ZIP 辅助接口和第三方许可说明。创建文件使用相应库；修改已有文件使用 `readOfficePackage` 定位部件和 XML 节点。新增、删除部件时调用方负责同步内容类型与关系。未修改的文件部件保留原字节；修改后的 XML 使用 UTF-8。

## 实际验证

本机 macOS arm64 上已执行：

- Node 26.5/22.19 的六个受影响模块各 166 项通过；随后新增两种技能模式、资源迁移和真实 Loader 验证，技能资源模块各 11 项通过。没有运行全量测试。
- 官方锁定 Node 24.21.0、pnpm 11.28.5 在 `PATH=/nonexistent` 下准备资源、离线安装和跨 PID 冷查询；安装后的文档库实际创建、修改、重新打开 DOCX、XLSX、PPTX。
- Word 的粗体、斜体和批注；Excel 的字体、数字格式、公式和缓存结果；PPT 的图表、真实内嵌工作簿和演讲者备注均保留。三份文件的其他 49 个部件字节一致。
- 实际原生 LibreOffice 完成三种格式转 PDF、三种格式转 PNG，以及 Excel 公式重算。重算后 `B1*2` 和结果 84 保留。Excel 验证环境缺少 Calibri，转换结果明确报告该字体缺失。
- 最新产物构建、后续 Host/Client 聚合类型检查、公开 API 文档检查和依赖声明检查通过。

原始日志、文件摘要、PID 和资源证明保存在本地 `.artifacts/native-migration/node-office/`，汇总为 `reviewed-evidence.json`。这些是资源与文档操作验证，不代表完整 Electron 或整个 Native 迁移验收。

## 明确限制

部件编辑不是 Office schema 或排版引擎：调用方负责关系、内容类型、修订结构和公式缓存。压缩方式、ZIP 元数据和数字签名不保留。加密、宏和旧二进制格式不由 OOXML 编辑器支持；既有 LibreOffice 转换仍按自身能力处理。默认限制为压缩包 128 MiB、10,000 项、单部件 64 MiB、解压总量 256 MiB，调用方可显式配置。

完整 Desktop/Electron、其他平台的正常安装、所有文档特性，以及 Native 的云沙箱、A2A、自动化、真实模型与 CLI 等原目标仍需分别验收。总状态见[迁移验收状态](native-migration-status.md)。
