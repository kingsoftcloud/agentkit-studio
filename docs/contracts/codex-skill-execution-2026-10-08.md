# Codex 绑定 Skill 执行验收（2026-10-08）

## 发现及修复

冻结运行包已经携带 Skill 目录，但 Codex 的 developer context 只有正文，没有目标 Host 的
资源目录。真实模型测试报告预设脚本不存在，并改用临时 Python 检查；不能将回答正确计为
绑定 Skill 执行成功。此前 App Server 适配器也未转发 commandExecution，Responses 中没有
相应命令证据。

现在为 Codex 提供已物化 Skill 的名称、说明、SKILL.md 路径和资源目录，正文按任务读取。
路径来自目标 Host 的物化结果，不沿用导出机器的位置。相对脚本与引用按 Skill 目录解析；
保留纯文本适配器的兼容回退。DSH Native/Harness 继续使用既有 SkillRegistry 和工具路径。

根据固定 Codex 0.159.2 实际生成的公开 App Server 类型，commandExecution 与 fileChange
写入既有非模型工具事件，由 DSH 原生工具卡和 Responses 投影消费。记录输入、实际输出、
退出码和耗时；非零退出或拒绝不能记为成功，也不交给 DSH 再执行一次。

## 本机实际执行

- macOS ARM、Node 22.19.0、DSH 0.2.0-rc.2、Codex 0.159.2、真实 GLM-5.3-Flash。
- 使用冻结的 Codex 运行包及独立 HOME、状态目录和工作目录；模型/MCP/云端凭证通过环境注入。
- 用户输入仅要求检查一段 JSON 并使用绑定的结构检查能力，没有提供身份或系统提示词标记。
- 模型首先读取目标目录内 SKILL.md，再运行该目录的 `scripts/json_structure_checker.py`。
  第二次命令退出码 0，实际 Markdown 报告为节点数 7、null 数 1、无重复键。
- Responses 中保留两次 `codex/command` 的输入及成功输出，44 帧文本增量；回答含仅存在于
  冻结 Agent 系统提示词中的标记。没有把模型自行推算或重写脚本当作通过证据。
- macOS 的只读沙箱下 Python 启动器输出过临时缓存警告；脚本仍执行完成并返回上述结果。

此测试的 DSH 依赖链接到本机固定 checkout，不能代替独立 Linux 镜像、DMG 或预发验证。

## 回归检查

- 409 项检查、18 个补丁格式检查和插件完整性检查通过。
- 导出/导入后删除源 Skill，分别验证直接 Skill 与 Skill Space 绑定只提供目标路径，Codex
  初始上下文不再全量内联 Skill 正文。
- App Server 协议测试覆盖原生命令成功、非零退出、拒绝和文件修改事件。
- 固定 DSH 的真实 Loop、Session、zstd 持久化和 Chat assembler 对 MCP/原生命令分别检查
  成功、失败、取消、关闭重开及结果窗口恢复，六组均通过，DSH 二次执行次数为 0。
  此组工具输入为合成数据，真实模型执行证据仅为上一节的本机测试。

Linux 镜像中的真实 MCP、Skill、知识库、跨会话记忆，以及预发部署生命周期仍需独立完成。
