import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SKILL_CONTEXT_LIMIT,
  builtinSkillDefinitions,
  formatBuiltinSkillContext,
  hasPlatformResourceBindings,
  mergeSkillDefinitions,
  skillDefinitionsForBindings,
  withBuiltinSkillContext,
  withBuiltinSkillContextForBindings,
} from '../src/builtin-skills.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';
import { createCodexResourceContext } from '../src/providers/codex-resource-context.mjs';
import { parseFrontmatter } from '../src/skill-discovery.mjs';
import { runtimeSkill } from '../src/skill-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', 'src', 'builtin-skills', 'platform-resources', 'SKILL.md');
const BUILTIN = 'agentengine-platform-resources';
const shellPlugin = process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash';

function platformPlugin(kind, { enabled } = {}) {
  const row = { config: { binding: { resource: { id: `platform/${kind}`, resourceId: `platform/${kind}`, kind } } } };
  return enabled === undefined ? row : { ...row, enabled };
}
const knowledgeBindings = { plugins: [platformPlugin('knowledge-base')] };
const memoryBindings = { plugins: [platformPlugin('memory-instance')] };
const skillSpaceBindings = { plugins: [platformPlugin('skill-space')] };

function boundSkill(name, description = `${name} bound skill`) {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n调用绑定的脚本。\n`;
  return runtimeSkill({ name, content, path: join(here, '..', '.tmp', name, 'SKILL.md') });
}

function admissionHarness(record, { getSkillDefinitions } = {}) {
  let definition;
  const admission = new DshPresetAdmission({
    registry: { register: async value => { definition = value; return () => {}; } },
    getAgent: async () => record,
    getSkillDefinitions,
  });
  return { admission, definition: () => definition };
}

function codexRecord(bindings) {
  return {
    metadata: { name: 'Codex Agent' },
    spec: { runtime: { type: 'codex' }, instructions: { system: 'Base Codex instructions.' }, bindings },
  };
}

function createCodexContext(record, resourceAdapter) {
  return createCodexResourceContext({
    agentStore: Promise.resolve({ get: async () => record, getRevision: async () => record }),
    builds: Promise.resolve({ build: { resolve: async () => record } }),
    resources: Promise.resolve(resourceAdapter),
  });
}

test('builtin platform-resources SKILL.md has a parseable frontmatter', () => {
  const content = readFileSync(manifestPath, 'utf8');
  const metadata = parseFrontmatter(content);
  assert.equal(metadata.name, BUILTIN);
  assert.equal(typeof metadata.description, 'string');
  // The description is what DSH shows in the skill catalog, so it must carry
  // the trigger conditions rather than a generic label.
  assert.ok(metadata.description.length >= 40, 'description must describe when to use the skill');
  assert.match(metadata.description, /知识库|记忆|Skill|MCP|工具/);
  assert.ok(content.trim().split(/\r?\n/).length <= 200, 'builtin SKILL.md must stay concise');
});

test('builtin skill definition matches the DSH runtime skill contract', () => {
  const definitions = builtinSkillDefinitions();
  assert.equal(definitions.length, 1);
  const [skill] = definitions;
  assert.equal(skill.name, BUILTIN);
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(typeof skill.description, 'string');
  assert.ok(skill.description.length > 0);
  assert.equal(typeof skill.content, 'string');
  assert.ok(skill.content.trim().length > 0);
  assert.equal(skill.path, manifestPath);
  assert.equal(skill.source, 'custom');
  assert.equal(skill.provider, 'agentkit-studio');
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: dirname(manifestPath) });
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
});

test('bindings gate only counts Agents that bind a real platform resource', () => {
  const falsy = [undefined, null, {}, 'not-bindings', [], { plugins: [] }, { modelProfileIds: ['profile:1'] },
    { plugins: [platformPlugin('knowledge-base', { enabled: false })] }];
  for (const bindings of falsy) {
    assert.equal(hasPlatformResourceBindings(bindings), false, `expected no platform resource for ${JSON.stringify(bindings)}`);
  }
  const truthy = [
    { skills: ['skill/platform-guide'] },
    { tools: ['component_status'] },
    { mcpServers: [{ resourceId: 'mcp/docs' }] },
    knowledgeBindings,
    memoryBindings,
    skillSpaceBindings,
  ];
  for (const bindings of truthy) {
    assert.equal(hasPlatformResourceBindings(bindings), true, `expected platform resource for ${JSON.stringify(bindings)}`);
  }
});

test('a zero-binding Agent receives no builtin skill (previous behavior)', () => {
  assert.deepEqual(skillDefinitionsForBindings({}, []), []);
  assert.deepEqual(skillDefinitionsForBindings(undefined), []);
  // A model profile binding alone is not a platform resource.
  assert.deepEqual(skillDefinitionsForBindings({ modelProfileIds: ['profile:1'] }, []), []);
});

test('a platform-resource Agent receives the builtin skill, builtin first', () => {
  const definitions = skillDefinitionsForBindings(knowledgeBindings, []);
  assert.deepEqual(definitions.map(skill => skill.name), [BUILTIN]);
  assert.equal(definitions[0].path, manifestPath);
  const other = boundSkill('workspace-review');
  const merged = skillDefinitionsForBindings(skillSpaceBindings, [other]);
  assert.deepEqual(merged.map(skill => skill.name), [BUILTIN, 'workspace-review']);
});

test('bound skills keep their order and builtin wins name dedupe', () => {
  const duplicate = boundSkill(BUILTIN, 'shadowed platform guide');
  const other = boundSkill('workspace-review');
  const merged = mergeSkillDefinitions([other, duplicate]);
  assert.deepEqual(merged.map(skill => skill.name), [BUILTIN, 'workspace-review']);
  assert.equal(merged.filter(skill => skill.name === BUILTIN).length, 1);
  // The builtin definition (real manifest content) survives the collision.
  assert.equal(merged[0].path, manifestPath);
  assert.match(merged[0].content, /平台资源使用指南/);
});

test('builtin skill path exists, is readable and stays inside the package', () => {
  const [skill] = builtinSkillDefinitions();
  assert.ok(existsSync(skill.path));
  const content = readFileSync(skill.path, 'utf8');
  assert.ok(content.includes('---'));
  assert.ok(content.includes('平台资源使用指南'));
  assert.equal(dirname(skill.path), skill.resourceBase.path);
});

test('builtin skill definitions are fresh per call so presets cannot mutate the cache', () => {
  const first = builtinSkillDefinitions();
  first[0].name = 'mutated';
  first[0].resourceBase.path = '/mutated';
  const second = builtinSkillDefinitions();
  assert.equal(second[0].name, BUILTIN);
  assert.equal(second[0].resourceBase.path, dirname(manifestPath));
});

test('zero-binding preset keeps the previous composition: no builtin skill, no new plugins', async () => {
  const record = {
    metadata: { id: 'builtin/zero', name: 'Zero Agent', revision: 1, local: true },
    spec: { runtime: { type: 'codex' }, bindings: {} },
  };
  const { admission, definition } = admissionHarness(record, {
    getSkillDefinitions: async agent => skillDefinitionsForBindings(agent.spec.bindings, []),
  });
  await admission.ensure('builtin/zero');
  const plugins = definition().plugins;
  assert.equal(plugins.some(row => row.name === '@deepseek-ai/dsh-tool-skill'), false);
  assert.equal(plugins.some(row => row.name === shellPlugin), false);
  const runtime = plugins.find(row => row.name.endsWith('/dsh-runtime-plugin'));
  assert.equal(runtime.config.skillDefinitions, undefined);
});

test('a platform-resource preset gets the skill loader and platform shell exactly once', async () => {
  const record = {
    metadata: { id: 'builtin/kb', name: 'KB Agent', revision: 1, local: true },
    spec: { runtime: { type: 'harness' }, bindings: knowledgeBindings },
  };
  const { admission, definition } = admissionHarness(record, {
    getSkillDefinitions: async agent => skillDefinitionsForBindings(agent.spec.bindings, []),
  });
  await admission.ensure('builtin/kb');
  const plugins = definition().plugins;
  assert.equal(plugins.filter(row => row.name === '@deepseek-ai/dsh-tool-skill').length, 1);
  assert.equal(plugins.filter(row => row.name === shellPlugin).length, 1);
  const runtime = plugins.find(row => row.name.endsWith('/dsh-runtime-plugin'));
  assert.deepEqual(runtime.config.skillDefinitions.map(skill => skill.name), [BUILTIN]);
  assert.equal(runtime.config.skillDefinitions[0].path, manifestPath);
});

test('bound Skill resources are merged with the builtin and still added once', async () => {
  const other = boundSkill('workspace-review');
  const record = {
    metadata: { id: 'builtin/skill', name: 'Skill Agent', revision: 1, local: true },
    spec: { runtime: { type: 'harness' }, bindings: { skills: ['skill/workspace-review'] } },
  };
  const { admission, definition } = admissionHarness(record, {
    getSkillDefinitions: async agent => skillDefinitionsForBindings(agent.spec.bindings, [other]),
  });
  await admission.ensure('builtin/skill');
  const plugins = definition().plugins;
  assert.equal(plugins.filter(row => row.name === '@deepseek-ai/dsh-tool-skill').length, 1);
  assert.equal(plugins.filter(row => row.name === shellPlugin).length, 1);
  const runtime = plugins.find(row => row.name.endsWith('/dsh-runtime-plugin'));
  assert.deepEqual(runtime.config.skillDefinitions.map(skill => skill.name), [BUILTIN, 'workspace-review']);
});

test('codex context inlines the builtin skill, bounded and after bound resources', async () => {
  const resourceAdapter = {
    searchKnowledge: async () => [{ Segment: { Content: 'KBFACT-42', Document: { Name: 'Guide' } } }],
  };
  const base = await createCodexContext(codexRecord(knowledgeBindings), resourceAdapter)({
    agentId: 'builtin/codex-kb', input: '平台文档里有什么？',
  });
  // The plain Codex resource context never carries the builtin guide by itself.
  assert.equal(base.systemPrompt.includes(BUILTIN), false);
  assert.match(base.systemPrompt, /Relevant resources:/);

  const wrapped = withBuiltinSkillContextForBindings(base, knowledgeBindings);
  assert.ok(wrapped.systemPrompt.includes(BUILTIN));
  assert.ok(wrapped.systemPrompt.includes(JSON.stringify(manifestPath)), 'must expose the absolute SKILL.md path');
  assert.ok(wrapped.systemPrompt.includes(JSON.stringify(dirname(manifestPath))), 'must expose the skill resource directory');
  assert.match(wrapped.systemPrompt, /先读取对应 SKILL\.md/);
  // The builtin block is appended last, after the bound resource contracts.
  assert.ok(wrapped.systemPrompt.indexOf(BUILTIN) > wrapped.systemPrompt.indexOf('Knowledge binding contract'));
  // Non-prompt fields are untouched.
  assert.deepEqual(wrapped.dynamicTools, base.dynamicTools);
  assert.equal(wrapped.agentName, base.agentName);
});

test('codex context without platform bindings stays unchanged', async () => {
  const base = await createCodexContext(codexRecord({}), undefined)({ agentId: 'builtin/codex-empty', input: '你好' });
  const wrapped = withBuiltinSkillContextForBindings(base, {});
  assert.equal(wrapped, base);
  assert.equal(base.systemPrompt.includes(BUILTIN), false);
});

test('non-codex surfaces never receive the builtin context block', async () => {
  const resourceAdapter = { searchKnowledge: async () => [] };
  const base = await createCodexContext(codexRecord(knowledgeBindings), resourceAdapter)({ agentId: 'builtin/non-codex', input: '问题' });
  assert.equal(withBuiltinSkillContext(base), base);
  assert.equal(withBuiltinSkillContext(base, { runtime: undefined }), base);
  for (const runtime of ['dsh-native', 'harness']) {
    assert.equal(withBuiltinSkillContext(base, { runtime }), base);
    assert.equal(withBuiltinSkillContextForBindings(base, knowledgeBindings, { runtime }), base);
  }
});

test('codex injection is idempotent and skips an already-indexed manifest', async () => {
  const resourceAdapter = { searchKnowledge: async () => [] };
  const base = await createCodexContext(codexRecord(knowledgeBindings), resourceAdapter)({ agentId: 'builtin/codex-dup', input: '问题' });
  const once = withBuiltinSkillContextForBindings(base, knowledgeBindings);
  const twice = withBuiltinSkillContextForBindings(once, knowledgeBindings);
  assert.equal(twice.systemPrompt.split(JSON.stringify(manifestPath)).length - 1, 1);
  // A bound Skill index that already points at the same manifest is not duplicated.
  const indexed = { ...base, systemPrompt: `${base.systemPrompt}\n\nSkill index: ${JSON.stringify(manifestPath)}` };
  assert.equal(withBuiltinSkillContext(indexed, { runtime: 'codex' }), indexed);
});

test('codex injection honours the content character budget', () => {
  const [skill] = builtinSkillDefinitions();
  const full = formatBuiltinSkillContext();
  assert.ok(skill.content.length <= BUILTIN_SKILL_CONTEXT_LIMIT, 'shipped body must fit the documented budget');
  assert.ok(full.includes(skill.content));
  const small = formatBuiltinSkillContext({ limit: 400 });
  assert.equal(small.includes(skill.content.slice(-200)), false);
  assert.ok(small.includes('先读取对应 SKILL.md'));
  assert.ok(small.length < skill.content.length, 'truncated block must be smaller than the full body');
});
