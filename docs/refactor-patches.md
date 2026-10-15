# 补丁治理与宿主兼容

生产基线保持 DSH `639ed015397290b3745d163aafe02ffee4aa3f84`，当前补丁集为 31 项。阶段 5A 的清单及宿主 CI 已接入；5B 产品配置和本地运行验证已落地，最终平台验收仍在进行；5C 已加入维护分支归档和自动导出校验，能力握手及事件消费者复核尚未完成。

## 修改和构建入口

`patches/dsh-v0.2.0-rc.2/manifest.json` 记录每项补丁的类别、基线、内容 SHA-256、修改文件及所属包、依赖、合同、风险、维护角色、上游状态、删除条件和验证方式。验证要求是待执行场景，不能用登记记录代替通过证据。

同一文件的后续补丁必须通过依赖链声明前一个修改者。门禁拒绝依赖成环、依赖晚于使用者、混用基线、遗漏修改文件、未登记的补丁和内容摘要变化。文本格式检查使用 Git 解析器，支持新增及删除文件；完整应用检查另在固定基线的独立索引执行。桌面打包在克隆及运行工具前校验清单。

```sh
make patch-manifest-check
make verify-patched-host DSH_ROOT="<固定 DSH checkout>"
```

宿主验证在输出目录创建并锁定独立 checkout，从固定 commit 应用补丁。源码通过独立临时索引形成完整 Git tree，比较清单中的 tree ID 与完整 tree 清单 SHA-256；不依赖 diff 缩写或显示设置，不修改调用方索引。之后安装冻结依赖、构建官方 Web/Host，并把登记的测试路径作为参数交给 Vitest，不执行清单中的命令文本。构建结束再次检查源码指纹，报告实际通过、失败及跳过数量。

打包入口复用源码检查。缓存记录使用完整 tree 指纹；旧记录只在原指纹仍可验证时迁移，不能验证时保留原缓存并要求新输出目录。隔离 Windows checkout 启用长路径，独立 DSH workspace 按自身 packageManager 选择 pnpm。

CI 的 `patched-dsh-host` 在 PR 和 main 提交上使用标准 Linux、Windows runner，并保留报告。Web、Electron、生命周期、冻结 Build、平台包和真实安装更新分别验收，宿主测试不能代替这些结果。

## 已收敛的补丁

- 007 随侧栏改为完整复用 DSH 会话列表而移除；Agent 选择不再过滤历史列表。
- 021 随恢复上游默认更新动作而移除。上游已在空闲和检查失败时强制刷新，并按 available / ready 状态下载或安装；原补丁无条件强制检查会干扰后两种动作。恢复默认后，main-startup 的 114 项行为测试通过。
- 001、002、003、005 由 035 的公开产品文案接口替代。构建输入控制首次渲染，运行时 locale 覆盖由所属 effect 释放；默认 DSH 仍显示原生文案及动画图标。产品值统一来自 Studio 配置。
- 036 同步已有预设组合 API 的生成目录；037 单独修复 Hero 回放的空编辑器初始状态。两项分别维护，不合并到产品接口补丁中。

产品版本、App ID、更新源、默认 bundle、平台图标和发行工作流输入见[产品配置](product-configuration.md)。新建、已有、用户禁用及原生 bundle 四类 Profile 已通过打包内 Desktop Host 的本地验证，每类连续启动两次，检查用户状态、已有插件运行和释放、Host 接口、前端挂载及 IPC 正常退出。验收脚本使用桌面 runtime 的完整依赖图；普通 CLI 的依赖图不包含所有桌面产品插件，不能替代桌面入口。

## 当前证据及缺项

当前 31 项补丁对应 tree `c2426c392335dde1ca31d5373fefef1940cb01db`，14,123 个源码条目。干净源码的官方构建通过，受影响 Host 测试 928 项通过、1 项平台跳过；GUI 测试 9,549 项通过、6 项跳过。默认 DSH 与配置后的产品页面均通过真实浏览器验证。macOS 未签名包已完成构建和打包运行时检查；这不证明签名、安装升级、数据保留或回滚。

当前 31 项补丁在公开 CI 任务 `38693027148` 完成 Linux 和 Windows 宿主构建及测试，分别为 928 项通过 / 1 项跳过和 926 项通过 / 3 项跳过；两端源码 tree 均为上述指纹。任务 `38696259649` 在 Studio `b9dd36d` 上完成 Windows 未签名安装包构建、打包运行时冒烟和真实 app.asar 的 144 模块检查；签名未执行，真实安装升级、数据保留和回滚仍未验收。前一次归档检查的 JSON 加载器失败已保留并修复。

当前候选的 Web 回放先因缺少 WebKit 失败；安装 owning workspace 指定的 WebKit 后，受影响的两个文件共 10 项全部通过。合并原全量记录和补跑结果为 602 项通过、16 项原有跳过，无剩余失败；这是组合证据，不是第二次全量运行。维护来源工具加入后，940 项 Studio 源码测试及 538 文件实际 tarball 检查通过。维护分支的本地恢复、确定性导出和构建预检已通过，导出后的源码树不变；新工具在平台 CI 的执行结果另行记录。失败轮次、诊断和原始验收报告保存在忽略的 `.artifacts/refactor/stage-5/`，后续报告必须关联实际源码及包指纹。

## 维护来源和升级

上游状态区分 `not-submitted`、`pending`、`merged-unreleased` 和 `in-baseline`。没有核验回执时使用 `unverified`；删除前必须确认当前产品基线具有等价行为。

固定基线上的维护提交是宿主修改来源，`.patch` 是生成结果。维护分支以标准 Git bundle 保存在 `host-source/dsh-v0.2.0-rc.2/maintenance.bundle`，只包含基线之后的提交；上游许可证随归档保留。`patches/dsh-v0.2.0-rc.2/source.json` 固定分支、基线、提交顺序、最终源码树、各项导出摘要和 bundle 摘要，manifest 再固定该描述文件。维护归档不进入运行时 npm 包。

```sh
# DSH_ROOT 提供固定上游基线的 Git 对象；目标目录必须尚不存在。
make patch-source-import DSH_ROOT=../deepseek-harness DSH_MAINTENANCE_ROOT=../studio-dsh-maintenance

# 在维护分支修改、测试并提交。每项补丁对应一个提交，保留 Studio-Patch: NNN trailer。
# 修改已有项时整理对应提交及后续提交；新增项先登记 manifest 的合同、路径、归属和依赖。
make patch-source-export DSH_MAINTENANCE_ROOT=../studio-dsh-maintenance
make patch-source-verify DSH_ROOT=../deepseek-harness
```

导出要求工作目录干净、提交从基线线性延伸、编号和清单顺序一致。导出会更新补丁、摘要、源码指纹和 bundle，不替代合同、依赖和验收登记；缺失的评审字段仍会失败。重复导出保留相同归档字节。导入只创建新目录，不覆盖已有维护分支或用户源码。

`make public-gate` 中的 `patch-source-check` 无需 DSH checkout，核对描述文件、归档和导出文件摘要。`patch-source-verify` 用基线对象在独立临时 Git 仓库恢复归档，检查父提交和 trailer，逐项重新生成补丁并比较字节。桌面打包、预检、开发安装及补丁应用检查均执行完整校验；Linux/Windows 宿主 CI 也在构建前执行并记录结果。仅改补丁并重写清单摘要仍会被完整校验拒绝。归档文件丢失时需取得源码仓库，不能从运行时包推断维护来源。

通用修复与会话持久化扩展分别评审；[持久化复核](refactor-persistence.md) 区分真实日志恢复和节点投影，并记录尚未接受的事件消费者。启动握手需表达基线、兼容版本和所需能力。候选升级只在独立 checkout 演练，记录需保留、已有等价实现、需重做的差异及耗时，失败不能自动切换生产基线或删除补丁。
