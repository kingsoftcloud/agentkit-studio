# DSH 维护源码

`maintenance.bundle` 是基于官方 `dsh-v0.2.1-rc.2` 的线性维护分支，引用为 `refs/heads/codex/studio-dsh-v0.2.1-rc.2`。许可证见 [LICENSE](LICENSE)。

它只包含固定基线之后的产品维护提交。每项提交以 `Studio-Patch` trailer 对应 [补丁清单](../../patches/dsh-v0.2.1-rc.2/manifest.json) 中的一项，确定性导出摘要由同目录 `source.json` 固定。归档用于开发与校验，不进入桌面运行时包。

当前只支持 0.2.1-rc.2；较早的归档只供发布追溯。
