# 会话持久化复核

补丁 016 为非 surface 事件开放已有的 `ignorable: true` 参数。默认事件仍是必需事件，产生模型消息的事件不能使用该标记；没有改变 Session 格式版本，也没有新增一套日志编解码器。未知但带标记的事件由 DSH 保留，未知必需事件继续拒绝读取。

## 真实 Host 验收

```sh
node scripts/verify-studio-persistence.mjs \
  --source <对应的已构建DSH源码> \
  --runtime <安装包组装出的dsh目录> \
  --node <打包附带的Node可执行文件> \
  --report <报告.json>
```

命令使用独立临时 home，运行安装包中的 Desktop Host，经过真实 Loader、SessionStore 和 JSONL 后端。默认不覆盖后端的 Zstd 编码配置；`--compression none` 单独验证未压缩模式。五个阶段分别为资源缺失时写入、停用 Studio 后读取、重新启用后读取、恢复资源并继续追加、再次停用后读取。每个阶段核验旧 v3 日志可读、未知必需事件被拒绝、模型消息哈希不变，以及 IPC 完整退出。

资源调用经过安装包内实际的 LocalResourceAdapters 与 checkedResource，Skill Service 则是受控的本机 HTTP 服务，先返回 404，再返回有效的空 Skill Space。前一次调用留下带 ignorable 标记的失败记录，恢复后追加成功记录。它证明资源错误不会破坏历史及后续恢复，不证明真实云端资源可用或模型推理成功。

旧 v3 日志和未知必需事件的 v4 日志是独立编写、每次验收仅创建一次的夹具。验收逐阶段比较已有 generation 文件的字节；读取或切换插件不能重写它们，恢复写入须保留原文件的完整前缀。报告只记录事件数量、状态及文件和模型消息哈希，不保存会话正文。

测试遵循官方 Session 发布顺序：先取得写句柄，再进入和公告 Session；恢复时先通过该句柄写入构造阶段产生的 resume marker，再发布后续实时事件。该标记同样只追加，不修改已有事件。

`verify-dsh-node-store.mjs` 继续负责 ConversationNodeAssembler 和 goal 投影。清单把它登记为 node-projection；它没有日志落盘和重启过程，不能替代 persistence 验收。

## 事件使用范围

| 事件 | 生产和消费 | 复核状态 |
| --- | --- | --- |
| `studio/resource-check` | checkedResource 记录资源调用状态，运行结果和页面展示读取这些事实 | 已通过实际生产函数、磁盘重开、插件停用和资源恢复场景 |
| `agentkit/codex-tool` | 只提供工具卡；本地 Codex 的模型事实另以原生 `user/message` 保存 | 真实 DSH 循环的成功、失败、取消共 6 场景通过 Zstd 重开和下一轮验证；2 个旧日志场景验证补录幂等及替换后不恢复；最终安装包回归另行验收 |
| `studio/runtime-model` | 旧版请求模型展示记录；新运行不再写入，重放不读取它 | 新请求通过原生已接收消息的指纹校验；旧请求通过原生 `request/header` 重建实际模型路由，缺少权威信息时拒绝模型相关重放 |

冻结运行时将输入和模型键的 SHA-256 指纹交给支持 `promptFingerprintVersion = 1` 的原生 SessionController，由它在接收消息时保存到 `user-rpc` 来源。相同请求 ID 的重试必须保留相同指纹（包括缺失状态），冲突在接收前拒绝。原生 `agent/inbox/spliced` 的首次入队记录保留该身份，消息已被领取或从队列取消也不能复用 ID 接收另一个请求；取消后提交新任务使用新的 ID。同 Session 的重放检查在串行执行队列内先于模型选择、权限设置及写入。旧无指纹消息仍可读取；重放按首个模型输出之前生效的原生请求头校验路由，必要时跨页寻找继承的请求头。缺少权威路由信息返回 `RUNTIME_REQUEST_METADATA_UNAVAILABLE`，不能用可忽略事件补足。

Codex 请求使用 DSH 的有效模型消息。即使读取方不识别工具卡事件，原生观察仍可被恢复；替换掉原生观察后不会从工具卡重新生成。旧日志补录规则见[Codex 上下文边界](refactor-lifecycle.md#codex-上下文边界)。这些验证使用实际 DSH AgentLoop、Session、JSONL 和 Chat assembler，Codex 流由受控 provider 提供；它们不等同整个安装包的进程重启和升级验收。

本页记录的是 5C 的持久化复核进度。维护来源、补丁同步、宿主能力握手、候选基线升级及最终安装更新仍分别验收。
