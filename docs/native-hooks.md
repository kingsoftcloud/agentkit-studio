# Native Hooks 宿主接入

`agentkit.studio-native-hooks/v1` 对应参考 Python 的宿主注册回调能力，支持 `PreToolUse`、`PostToolUse`、`PreCompact`、`Stop`。由受信任的 Node 发行代码注册；Agent 草稿、模型输出和工具结果不能导入代码、注册回调或生成授权。

发行代码可通过包的 `host-bootstrap` 入口挂载 Studio。不要同时再挂载默认 Studio Host。示例中的实现与摘要应来自发行方已验证的固定安装包：

```js
import { mountStudioHost } from '@kingsoftcloud/agentkit-studio/host-bootstrap';
import { sourceDigest, authorize, callback } from './installed-governance.mjs';

await mountStudioHost(ctx, {
  nativeHookRegistrations: [{
    sourceRef: 'plugin://distribution-governance@1.0.0',
    sourceDigest, // sha256:<64 hex>，由发行方验证实际安装来源
    agentIds: ['ar-local-0123456789abcdef'],
    authorize, // async (request, signal) => 'allow' | 'deny'
    authorizationVersion: 'distribution-policy/v1',
    callback, // async ({ signal, ...invocation }) => HookOutput
    configuration: {
      contract: 'agentkit.studio-native-hooks/v1',
      cleanupTimeoutMs: 1000,
      stopContinuationLimit: 0,
      hooks: [{
        hookId: 'distribution-governance',
        events: ['PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'],
        readOnly: true,
        timeoutMs: 5000,
        maxInputBytes: 64000,
        maxOutputBytes: 16000,
        failureMode: 'block',
      }],
    },
  }],
});
```

`authorize` 和 `authorizationVersion` 必须一起提供或一起省略；省略时回调被拒绝。`agentIds` 必须为精确身份，禁止 `*`。来源引用不能重复，同一 Agent 的 Hook ID 不能冲突。每个来源包含 1 至 16 个声明。声明不能提供 `sourceRef`、`bindingDigest`、`executionPolicyDigest`；宿主从精确 Agent 修订、Build、scope、spec、来源摘要、配置和授权版本派生绑定。摘要是可信发行方的来源声明，注册表不负责安装包验证，也不会把摘要字符串视为沙箱或执行权限。

含 `Stop` 的来源必须显式声明非负整数 `stopContinuationLimit`。`0` 仍会执行 Stop 回调，但拒绝回调提出的继续修复；正值独立限制继续次数，不增加模型、工具或墙钟预算。多个来源的 Stop 策略必须一致。

回调返回对象可包含 `action: 'continue' | 'deny' | 'repair'`、`additionalContext: string[]`、`updatedArguments: object | null`，省略字段使用核心默认值。仅前置工具回调可修改参数；修改后的参数仍通过 schema、DSH 权限和审批管线，模型历史保留供应商的原始参数。`repair` 仅适用于 Stop 且必须附带修复信息。回调数据是非授权上下文，不能作为完成、验收通过或工具审批证据。

可选的 `compactionSourceProjection: 'canonical_user'` 仅用于含 `PreCompact` 的声明，投影待压缩历史中的用户角色原文，保留与原消息引用的对应关系；排除工具、助手和宿主衍生上下文。它本身不授予记忆写入权限，也不替代记忆端口对原始来源、候选提取、去重及当前事实的校验。

每次调用、授权及回调前后，端口检查原 Session、Run、轮次、Build、任务链、目标修订、工具计数、当前阶段、运行中的原意图及租约 fence。已结束、被抢占或已提交的意图不能再次获得回调权限。来源退休或 Host 关闭后不再授权；正在执行但无法取得有效结果的修改回调保持结果未知，不能按 `warn` 策略重跑。

`readOnly` 是可信宿主对回调副作用的声明，不是 JavaScript 纯函数沙箱。宿主必须按实际实现声明。截止时间覆盖可用性检查、授权、回调和结果校验；清理等待另有上限。JavaScript 无法强制终止忽略取消的代码，其迟到结果会被丢弃。

冻结配置和账本只保存声明及摘要，不保存函数或凭证。重启与 Frozen Build 恢复需要同一可信发行方重新注册来源；来源、授权策略或配置漂移会在原 Run 派发前被拒绝。此接口不为 Agent 打包可执行回调代码，不解释命令/HTTP Hook 配置，也不提供 Python 插件兼容层。

定向验证：`node --test tests/studio-native-hooks.test.mjs`。实际打包验收：`node scripts/verify-studio-native-harness.mjs --source <维护的 DSH checkout> --mount-host --hooks --recovery --archive <Studio.tgz> --keep`；加 `--frozen` 验证冻结来源。验证真实 Hook 意图与回执、参数修改后的文件字节、DSH 拒绝写入、原轮次冷恢复及默认 DSH 不执行这些回调。
