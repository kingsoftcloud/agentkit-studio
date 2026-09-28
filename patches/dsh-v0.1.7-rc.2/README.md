# DSH v0.1.7-rc.2 补丁集

本目录保存 AgentKit Studio 对官方 DSH `v0.1.7-rc.2` 的**可审计、版本锁定的临时兼容补丁**。补丁不是 Studio 的运行时依赖，也不会被浏览器直接加载；它们只在官方 DSH 尚未提供等价公开扩展点时，供宿主构建或本地复现使用。

## 基线

- DSH 版本：`0.1.7-rc.2`
- 基线 commit：`477b4f420553e8a52c2fbccc464d7561b239c443`
- 上游 checkout：由 `DSH_ROOT` 指定，不能写死本机路径

## 补丁顺序

按文件名的数字顺序应用。每个补丁都只允许修改补丁头中列出的 DSH 文件；应用前先确认 checkout 没有未提交改动。

```sh
DSH_ROOT=/path/to/deepseek-harness
PATCH_ROOT=/path/to/agentkit-studio/patches/dsh-v0.1.7-rc.2

test "$(git -C "$DSH_ROOT" rev-parse HEAD)" = \
  477b4f420553e8a52c2fbccc464d7561b239c443
for patch in "$PATCH_ROOT"/*.patch; do
  git -C "$DSH_ROOT" apply --check "$patch"
done
for patch in "$PATCH_ROOT"/*.patch; do
  git -C "$DSH_ROOT" apply "$patch"
done
```

已经通过宿主分支或本地 profile 应用过的 checkout 不要重复应用。升级 DSH 版本时，复制本目录为新的 `dsh-v<version>/`，重新生成补丁并更新本说明；禁止在同一目录混放不同版本的补丁。

## 补丁清单

| 文件 | 作用 | 删除条件 |
| --- | --- | --- |
| `001-chat-thinking-copy.patch` | 将思考态文案改为产品中性的“正在思考中” | 上游提供可配置文案或 Studio 公共 locale slot |
| `002-generated-conversation-copy.patch` | 调整会话输入占位文案 | 上游提供可配置 placeholder |
| `003-generated-locale-brand.patch` | 移除 DSH 默认 Hero 品牌文案 | 上游提供稳定品牌 slot 并覆盖所有 fallback locale |
| `004-sidebar-panel-lifecycle.patch` | 修复动态面板注册后的侧栏选择 | 上游侧栏生命周期修复进入发布版本 |
| `005-studio-fallback-brand.patch` | 宿主启动慢时不闪现 DSH Hero 品牌 | 上游 fallback 已提供产品级品牌扩展点 |

每个补丁都应在对应 DSH 升级时重新执行 `git apply --check`、Web/Desktop 构建和品牌/会话 smoke；上游具备等价能力后删除补丁，不保留“永久 patch”。
