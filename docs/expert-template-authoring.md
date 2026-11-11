# 专家模板和专家团模板使用说明

这份文档回答两个常见问题：

1. 我想新增一个普通专家，应该怎么做？
2. 我想新增一个专家团，怎样保证它是一个 DSH Native Team，而不是几个互不相干的 Agent？

文档里的“模板”指的是可重复使用的定义。模板本身不会替用户执行任务，也不会替用户保存账号密钥。用户真正召唤模板时，Studio 才会根据当前账号、模型和资源创建运行实例。

## 先分清两种模板

普通专家模板和专家团模板的结果不同：

| 模板 | 召唤后得到什么 | 适合什么场景 |
| --- | --- | --- |
| 普通专家模板 | 一个独立 Agent/Session | 单个角色完成一项工作 |
| 专家团模板 | 一个 DSH Native Team，包含一个 root Session 和多个 child Session | 多个角色分工、通过 Team 消息和共享任务板协作 |

专家团的成员不是按“每个成员创建一个新 Agent”的方式运行。角色是锁定的蓝图，运行时由 DSH Agent Teams 创建 root/child Session。Studio 可以给这些 child Session 绑定角色指令、模型和 `agentPreset`，但不会把 `team-role-*` 合成到普通 Agent 列表里。

## 新增一个普通专家模板

### 最简单的方式：从 Studio 中已有的专家导出

适合已经在本地调好指令、模型和资源的情况：

1. 在 Studio 的“智能体”里创建或编辑一个本地专家。
2. 运行几次真实任务，确认系统指令、输出格式和资源依赖都稳定。
3. 导出模板定义。导出时只保留角色指令、运行时类型、依赖声明和示例，不要把账号密钥、知识库实例 ID、记忆库实例 ID 或本机路径写进模板。
4. 为模板分配新的 `id` 和语义化版本，例如 `research-analyst`、`1.1.0`。
5. 用目录校验和相关测试检查它，再决定放入个人目录、开发目录还是公共目录。

一个普通专家模板的最小结构如下：

```json
{
  "kind": "agent",
  "id": "research-analyst",
  "version": "1.1.0",
  "name": "研究分析师",
  "description": "围绕问题整理证据和可行动结论。",
  "runtimes": ["dsh-native"],
  "recommendedRuntime": "dsh-native",
  "requirements": [],
  "spec": {
    "runtime": { "type": "dsh-native" },
    "instructions": {
      "system": "先界定问题和时间范围，再整理来源、事实、推断和信息缺口。",
      "task": ""
    },
    "bindings": {
      "tools": [],
      "mcpServers": [],
      "skills": [],
      "plugins": [],
      "policyTemplate": "strict"
    }
  },
  "examples": ["对比三种方案的适用场景。", "整理这份资料的证据表。"],
  "deliverable": "带来源的研究简报"
}
```

如果模板需要知识库、记忆库、Skill 或 MCP，只声明“需要什么”，不要写入某个环境里的具体资源 ID。召唤时由用户选择实际资源。

## 新增一个专家团模板

专家团模板分成两层：

1. **Team 定义**：团队名称、协作指令、成员顺序和角色职责。
2. **角色模板**：每个成员的完整 Agent 蓝图。角色模板必须通过 `id + digest` 锁定，保证以后修改角色时不会悄悄改变已经发布的 Team。

一个可发布的 Team 定义示例：

```json
{
  "kind": "team",
  "id": "team-product-research",
  "version": "1.0.0",
  "name": "产品研究专家团",
  "description": "由主理人组织研究、竞品和风险分析。",
  "instructions": "主理人拆解任务，分派给预配成员，收齐报告后审查、汇总并交付。",
  "defaultModel": "deepseek-v4.1-flash-1017",
  "roles": [
    {
      "name": "lead",
      "label": "研究主理人",
      "agentPreset": "preset:product-research-lead",
      "template": {
        "id": "team-product-research-role-lead",
        "version": "1.0.0",
        "digest": "sha256:..."
      }
    },
    {
      "name": "analyst",
      "label": "市场分析师",
      "instructions": "分析市场规模、竞争格局和证据来源。",
      "agentPreset": "preset:product-research-analyst",
      "template": {
        "id": "team-product-research-role-analyst",
        "version": "1.0.0",
        "digest": "sha256:..."
      }
    }
  ]
}
```

### Team 定义里的字段怎么理解

- `roles[0]` 必须是 `lead`。它对应 DSH Native Team 的 root Session。
- 其他角色对应 DSH Native Team 的 child Session。角色名必须唯一，只使用小写英文和连字符，例如 `market-analyst`。
- `template` 是角色蓝图的不可变引用，必须包含 `id` 和 `digest`；如果没有填写 `version`，Studio 会继承 Team 版本以兼容旧目录。
- `agentPreset` 是可选的角色运行 preset。填写后，召唤时会保留并校验它；模板旧版本曾经丢失这个字段，当前实现已经补上。
- `defaultModel` 是推荐默认模型。用户在召唤界面选择其他可用模型时可以覆盖它；没有填写时使用当前 Studio 模型配置的默认值。
- `one-team-model` 只是旧测试或旧配置中的占位值，不能出现在新模板、角色蓝图或模型绑定里。推荐默认值是 `deepseek-v4.1-flash-1017`。
- 成员 allowlist 由 `roles` 中除 `lead` 外的角色自动生成。它用于 Studio 对预配成员的映射和 preset 绑定。
- DSH 官方 Team 工具仍由 DSH 原生服务负责。Lead 可以按任务需要通过官方工具创建额外 Team 成员；这些额外成员不属于模板预配角色，也不会被错误地写入普通 Agent 列表。

### 角色蓝图必须满足的条件

角色对应的 Agent 定义应满足：

- `kind` 为 `agent`。
- `teamRoleOnly` 为 `true`，避免角色模板被当作普通专家单独展示或召唤。
- `spec.runtime.type` 为 `dsh-native` 或 `harness`。
- 有非空的 `spec.instructions.system`。
- 有 `spec.bindings`，但里面不能写环境专属密钥或实例 ID。
- 不声明 `subAgents` 或 `sub_agents`。Team 的协作关系由 DSH Native Team 建立，不能在成员里面再套一层普通 subagent。
- 模型绑定不能使用 `one-team-model`。

## 自定义一个专家团

如果只是自己使用，不需要先发布公共模板：

1. 先准备好两个或更多本地 DSH Native/Harness 专家，或者从模板召唤后再调整指令。
2. 在 Studio 的 Team 编辑器里选择主理人和成员，填写每个成员的职责。
3. 保存后得到一个本地 TeamDefinition。
4. 运行 Team 时，Studio 只把成员蓝图交给 DSH Team runtime，创建一个 root Session 和 child Sessions。
5. 可以修改 Team 名称、协作说明和成员职责；已经开始的 TeamRun 仍使用启动时冻结的角色快照。

这种自定义不会自动改写公共模板，也不会覆盖已有 Agent。需要分享给其他账号时，再把 Team 定义整理成上面的公共模板格式。

## 发布到预发和线上

公共模板的发布顺序固定为“资源 → Server catalog → KS3 快照 → 当前环境 `latest.json`”。普通用户只能读取 catalog，发布动作由受控维护任务执行。

### 预发发布

1. 审核提示词、图片、Skill/MCP 包的来源和再分发授权。
2. 为每个不可变资源计算 SHA-256，上传到 `studio-templates/pre-online/v1/` 对应的内容寻址路径。
3. 在预发 Server 执行 `scripts/publish_studio_templates.py`，生成不可变 catalog 和快照目录。
4. 上传预发快照，最后更新预发 `latest.json`。
5. 清空 Studio 模板缓存，读取预发 catalog，至少验证一个普通专家和一个专家团。

### 线上发布

预发验收通过后，重复同样的步骤，但使用线上 Server、线上数据库和 `studio-templates/online/v1/`。线上不能直接指向预发快照，也不能在 Team 角色里引用预发资源 URL。

### 发布前的本地检查

```bash
# 合同、召唤、Team 运行和 catalog 审计
node --test \
  tests/team-template-contract.test.mjs \
  tests/team-template-summon.test.mjs \
  tests/team-template-audit.test.mjs \
  tests/studio-teams.test.mjs

# 审计一个本地 catalog
node scripts/verify-team-template-catalog.mjs \
  --input ./catalog.json \
  --require-role-definitions

# 只读审计公开预发/线上快照
node scripts/verify-team-template-catalog.mjs \
  --input https://agentkit.ks3-cn-beijing.ksyuncs.com/studio-templates/pre-online/v1/latest.json \
  --require-role-definitions
node scripts/verify-team-template-catalog.mjs \
  --input https://agentkit.ks3-cn-beijing.ksyuncs.com/studio-templates/online/v1/latest.json \
  --require-role-definitions
```

验收时重点看四件事：

1. Team 目录中存在 `kind=team` 条目，且每个角色引用的 digest 都能找到。
2. 角色定义标记为 `teamRoleOnly=true`，没有嵌套普通 subagent。
3. 模型不是 `one-team-model`，默认模型能解析到 `deepseek-v4.1-flash-1017` 或用户明确选择的模型。
4. 召唤后只有一个 Team root 和对应 child Sessions；不会按成员数量新增独立 Agent。

## 修改和回滚原则

- 改角色职责、模型或资源依赖时，增加角色模板版本并重新计算 digest。
- 改 Team 的成员顺序、协作说明或角色引用时，增加 Team 版本。
- 不要覆盖旧对象；KS3 使用内容寻址路径保存历史版本。
- 新 catalog 只影响以后召唤的 Team。已经创建的 Agent、TeamDefinition 和 TeamRun 保留原来的冻结快照。
- 线上出现问题时，重新激活同一环境的历史 `latest.json` 即可回滚，不需要删除用户已经创建的 Team。

