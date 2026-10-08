# 云端 Codex 命令错误与流式显示验收

本次使用已核验子账号、真实 KOP、私有 KS3 运行包、GLM-5.3-Flash，以及隔离的 DSH
Web Host 和 Chrome。测试 Agent 仅绑定模型，未绑定知识库、记忆库、MCP、Skill 或插件。
用户消息要求运行 `python3 -c "print(7)"`，不包含系统提示词中的验收前缀。

## 命令错误

Codex 0.159.2 在 Bubblewrap 启动失败时会返回原始函数结果，但可能没有高层
`commandExecution` 事件。原桥接因此只显示模型对错误的描述，没有真实工具卡。

修复启用固定 CLI 支持的 `experimentalRawEvents`，仅补充 `exec_command` 的匹配调用与结果；
不采集原始消息或推理作为工具，不重新执行命令。已有高层终态优先，未知结果不标为成功。

- 实际 Linux CLI + loopback 模型的最小复现，修复前工具事件为 0，修复后为开始和失败两条；
  最终镜像中独立运行同一诊断也通过。此项是实际 CLI、模拟模型检查。
- 真实云端旧镜像 `0.0.1-94abbbd` 的回答只有错误文本，没有命令事件。
- 同一 Agent 升级到 `0.0.1-3212d78` 后，真实 SSE 返回一次 `codex/command` 调用与一次
  `is_error=true` 的结果：退出码 1，输出 `bwrap: Failed to make / slave: Permission denied`。
- 原生页面未选择工作区，使用冻结的 GLM-5.3-Flash；展开工具组及工具卡，能查看命令参数
  和实际输出。停止验收 Host 后读取 DSH 压缩日志，仍有一条开始和一条失败事件。

**这证明错误展示得到修复，不证明命令执行或脚本 Skill 可用。** 本机 Docker 的 DSH
沙箱检查仍报 `SANDBOX_UNAVAILABLE`，云端 Codex Bubblewrap 仍被宿主权限拒绝。
没有增加权限或关闭沙箱来规避限制。

## 多段流式文本

浏览器实测还发现正文重复。云端按输出项发送快照，本地桥接却只保存最后一段同类文本；
正文和思考交错后，较早输出项的 done 会覆盖当前块或再次追加文本。

使用真实 Responses projector → 云端适配器构造最小回归，先确认失败，再按输出项及内容
序号修复。完成快照只与自己的增量核对；不同输出项里的相同文字仍保留。已关闭旧项的
内容修订明确报错，不覆盖新项。修复后的隔离 Host 连接同一旧镜像，以及升级后的新镜像，
两次真实原生对话均只显示一份正文。

Studio 提交 `3212d78` 包含 Codex 工具修复，`76a6738` 包含本地云端文本桥接修复。
`make check` 511 项通过，`make pack` 通过；真实 DSH AgentLoop / Session / 工具卡及磁盘
重开诊断通过。模型原始事件诊断与真实云端模型、浏览器结果分别记录，互不替代。

## 云端版本与范围

候选镜像固定为
`sha256:a44f7bcda7625da3985072be04a284bd6c0156810b9ca8fb5edf309914c10a17`，
只加入 `pre-online / cn-beijing-6` 的 preview 目录，没有切换默认版本。
三种运行时在最终镜像中的离线入口、系统提示词传递、Responses 流、幂等重放和历史恢复
检查通过；这些使用 loopback 模型，不能视为完整资源验收。

升级通过同一云端 Agent 的 UpdateAgent 完成，冻结 Build 不变，实际镜像切换，20 GiB
持久卷保留。控制面及鉴权入口核对一致后才显示就绪。升级后的旧原生会话明确提示开启
新会话，历史仍可查看；页面错误码标签目前显示 UNKNOWN，具体错误提示正确。

随后通过同一部署记录回滚到初始镜像，入口以新的回滚标识确认就绪；原持久卷仍为同一块。
同样的真实命令请求在回滚后恢复旧版的无工具事件行为，完成旧版 → 修复版 → 旧版对比。
这次是镜像切换验证，冻结 Build 没有改变，不扩大为 Codex 资源增删的升级回滚验收。

验收后经 KOP 删除独立 Agent，GetAgent 返回 404；对应 Namespace、PVC 和 PV 均确认
回收。三个专属私有运行包核对归属后删除，逐个下载返回 404。隔离 Host 已停止，日常
Host 未改动。候选镜像保留供后续预发使用；最终账单结算不在本次证明范围。

最终 `make release-check` 通过 511 项测试、18 个补丁格式检查和包完整性检查。

此项不覆盖全部资源组合、KOP 调度 Action 开通、跨子账号 IAM 矩阵或完整 Linux 沙箱。
渠道及定时投递的独立实测见 [WPS 三运行时验收](wps-runtime-acceptance-2026-10-09.md)。

## 命令沙箱环境补验

同一候选镜像另建隔离容器，分别运行 DSH 公共 SandboxProvider 和官方 Codex CLI 的只读
Python 探测。标记文件可读、实际写入被拒绝且命令成功返回，才记为通过；不请求模型。

- 真实预发容器 UID 为 1000，有效 capabilities 为 0，外层 seccomp 未启用；用户命名空间创建成功。
- DSH 成功执行并拒绝写入，报告 Landlock `enforcement: partial`，不代表完整隔离。
- Codex 未执行到脚本，Bubblewrap 仍报 `Failed to make / slave: Permission denied`；写入结果记为未知。
- AppArmor 为 `cri-containerd.apparmor.d (enforce)`。默认挂载限制是首要嫌疑，仍需节点策略及审计日志确认；未使用特权容器或关闭沙箱。

`agentengine-images` 提交 `4692d46` 提供 `make studio-runtime-sandbox-check` 和可在实际
Pod 中从标准输入运行的检查器，镜像 smoke 也改为要求 DSH 与 Codex 各自通过。Node 定向
测试 3 项、镜像目录/发布 Python 测试 12 项通过；本地 Docker 的完整 smoke 在沙箱门槛
失败，不能记为通过。详见该仓库 `deploy/studio-runtime/acceptance-sandbox-environment-2026-10-09.md`。

此次隔离 Agent 已删除且 GetAgent 为 404，命名空间和 PV 均为 NotFound，独占的 1 个私有
运行包删除后下载为 404。没有生成新镜像或修改日常 Host。这些结果早于后续的
[控制面版本变化](cloud-control-plane-2026-10-09.md)。
