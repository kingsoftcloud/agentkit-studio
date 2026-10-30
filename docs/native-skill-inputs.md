# E2B Skill 输入文件

Native 和 DSH/Codex 的 Node Skill 工作流接受可信宿主提供的可选输入文件。
这对应参考提交 `355059d78e47ed764bbdb3606304cdf34e9838a3` 的
`ksadk/skills/runtime/base.py` 中 `SandboxInputFile` 与 E2B 后端的 `input_files`。
参考本地后端明确忽略输入文件，Studio 的 `tool_defs.py` 也没有自动填入该参数。
因此这项能力不代表自动同步工作区或新增了附件界面。本地 Node 后端同样不搬运输入文件。

宿主可以向 `createNativeDshTools` 提供 `skillInputFiles`，或向
`prepareNativeSkillHost` / `createDshNodeSkillWorkflowTools` 提供 `inputFiles`：

```js
[{ source: 'data/source.bin', targetPath: '/workspace/inputs/source.bin', sha256: expectedDigest }]
```

`sha256` 可省略；提供时必须匹配实际读取的字节。源文件必须位于当前实际工作区内，
相对路径以工作区为基准；绝对路径也必须满足相同边界。目标路径必须是规范的 POSIX
路径并位于 `/workspace/inputs/` 下，拒绝重复路径及文件/子路径冲突。模型工具仍只接受
原有的工作流参数，不能通过 `input_files` 或其他参数指定宿主文件。输入描述在激活时
复制，契约 `agentkit.native-skill-input-files/v1` 与描述摘要参与宿主绑定；不把宿主路径
暴露在公开绑定中。DSH 使用原 Agent/Session/call，不能伪造 Native Run。

每次原调用先持久化执行意图，再验证并私有暂存全部输入字节，最后持久化含大小、SHA-256
及源相对路径的清单；这些步骤在创建 E2B 沙箱之前完成。文件不能是符号链接或硬链接，
父目录也不能通过符号链接逃逸。单文件最多 20 MiB，合计最多 50 MiB，最多 500 个文件。
这些是 Node 端明确的文件和产物预算，并非参考实现原有的全部数值限制。

上传使用原沙箱的受保护 SDK 文件端口，读取私有快照并重新核验 SHA-256；已上传字节
再次读回验证。模板中已有的普通输入目录可以复用，遇到符号链接或已有目标文件会失败，
不会覆盖模板文件。目录检查不承诺能阻止同一远端用户并发替换文件的所有 OS 竞态；
沙箱仍须由该调用独立拥有，不应与不可信写入者共享。

工作流脚本可用 `KSADK_SKILL_INPUT_DIR` 读取 `/workspace/inputs`，
`KSADK_SKILL_INPUT_FILES` 是目标绝对路径的 JSON 数组。成功结果的 `input_files.files`
只返回远端路径、SHA-256 和字节数，不含宿主源路径或私有暂存位置。

已完成调用返回原回执，即使源文件后来被修改或删除，也不重新上传或执行。创建、上传、
脚本执行或清理期间中断而未确认结果的调用保持 `uncertain` 和原 runtime/task/sandbox
定位信息；不能自动创建替代沙箱，也不能自动重复上传或脚本。需要明确核对原调用；
完整核对/清理界面仍是迁移的独立验收门槛。

定向验证覆盖实际 NativeKernel/SQLite 工具意图、原审批管线、Native 与 DSH 宿主、
真实文件和 Bash、精确二进制交付、模板目录/链接边界，以及创建前和上传应用后真实
SIGKILL。恢复使用不同 Node PID 并断言原记录不变、SDK 调用不增加。E2B 控制面使用
明确的 SDK 替身；这些验证不证明线上 E2B、完整产品界面或整体迁移完成。
