import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentForm } from '../src/client/pages/agent-form.mjs';
import { nativeChildRoles } from '../src/providers/native-subagents.mjs';

const walk = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(walk)] : [];
function form(initialAgent) {
  const state = [], effects = []; let cursor = 0, effectCursor = 0, updated;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(value => value != null && value !== false) }),
    Fragment: 'fragment',
    useState: initial => { const at = cursor++; if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial;
      return [state[at], value => { state[at] = typeof value === 'function' ? value(state[at]) : value; }]; },
    useEffect: (effect, deps) => { const at = effectCursor++; if (!effects[at] || deps.some((value, index) => value !== effects[at][index])) {
      effects[at] = deps; effect(); } },
  };
  const Form = createAgentForm({ ui: { React, BRAND: {}, ALLOWED_RUNTIME_TYPES: ['harness', 'codex', 'dsh-native'],
    RUNTIME_LABELS: {}, buttonStyle: () => ({}), inputStyle: () => ({}), SectionHeading: 'heading', PlatformResourcePicker: 'platform', Pill: 'pill' },
    hostRemote: { resources: async value => (typeof value === 'string' ? value : value.kind) === 'model'
      ? { items: [{ resourceId: 'fixture', displayName: 'Fixture' }], defaultModel: 'fixture' }
      : { items: [{ resourceId: 'read_workspace_file', displayName: 'read_workspace_file', contract: { sideEffect: 'none' } },
        { resourceId: 'write_workspace_file', displayName: 'write_workspace_file', contract: { sideEffect: 'workspace' } }] },
    updateAgent: async (id, spec, revision) => { updated = { id, spec, revision }; return { metadata: { id, revision: revision + 1 } }; } } });
  let nodes;
  const render = () => { cursor = 0; effectCursor = 0; nodes = walk(Form({ initialAgent, onCreated() {}, onBack() {} })); };
  const button = text => nodes.find(node => node.type === 'button' && node.children.includes(text));
  const aria = text => nodes.find(node => node.props['aria-label'] === text);
  render();
  return { render, button, aria, nodes: () => nodes, result: () => updated,
    flush: async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); render(); },
    next: () => { button('下一步').props.onClick(); render(); } };
}
const existing = roles => ({ source: 'local', metadata: { id: 'role-agent', name: 'Role Agent', revision: 7 }, spec: {
  runtime: { type: 'harness' }, instructions: { system: 'Parent instructions' }, security: { allowedPermissions: ['process:host-user'] },
  bindings: { modelProfileId: 'fixture', modelProfileIds: ['fixture'], tools: [{ resourceId: 'read_workspace_file' }] }, sub_agents: roles,
} });

test('editing a Native role preserves advanced legacy options and publishes with the loaded revision', async () => {
  const original = existing([{ name: 'reader', instructions: 'Read evidence', tools: ['read_workspace_file'],
    max_turns: 5, max_tool_calls: 2, timeout_seconds: 90, inherit_skills: false, model_profile_id: 'fixture',
    output_schema: { type: 'object', properties: { evidence: { type: 'string' } } }, concurrent_safe: false }]);
  const editor = form(original); await editor.flush(); editor.next(); editor.next();
  editor.aria('角色 1 任务说明').props.onChange({ target: { value: 'Read the original evidence' } }); editor.render();
  editor.next(); await editor.button('保存 Agent').props.onClick();
  const { spec, revision } = editor.result(); assert.equal(revision, 7); assert.equal(spec.sub_agents, undefined);
  const roles = nativeChildRoles(spec); assert.equal(roles[0].instructions, 'Read the original evidence');
  assert.equal(roles[0].maxTurns, 5); assert.equal(roles[0].maxToolCalls, 2); assert.equal(roles[0].timeoutSeconds, 90);
  assert.equal(roles[0].inheritSkills, false); assert.deepEqual(roles[0].outputSchema, original.spec.sub_agents[0].output_schema);
  assert.deepEqual(spec.security, original.spec.security); assert.deepEqual(original.spec.sub_agents[0].instructions, 'Read evidence');
});

test('removing a parent tool blocks saving its dependent child rather than silently broadening or dropping the role', async () => {
  const editor = form(existing([{ name: 'reader', instructions: 'Read evidence', tools: ['read_workspace_file'] }]));
  await editor.flush(); editor.next();
  const toolLabel = editor.nodes().find(node => node.type === 'label' && walk(node).some(child => child.type === 'strong' && child.children.includes('read_workspace_file')));
  walk(toolLabel).find(node => node.type === 'input').props.onChange({ target: { checked: false } }); editor.render();
  editor.next(); editor.next(); await editor.button('保存 Agent').props.onClick(); editor.render();
  assert.equal(editor.result(), undefined);
  assert.ok(editor.nodes().some(node => node.props.role === 'alert' && node.children.some(value => typeof value === 'string' && value.includes('未绑定'))));
});

test('editing another Harness preserves its original role metadata and offers no Native role controls', async () => {
  const original = existing({ planner: 'vendor-owned-role-configuration' }); original.spec.runtime.type = 'dsh-native';
  const editor = form(original); await editor.flush(); editor.next(); editor.next();
  assert.equal(editor.button('添加子任务角色'), undefined);
  editor.next(); await editor.button('保存 Agent').props.onClick();
  assert.deepEqual(editor.result().spec.sub_agents, original.spec.sub_agents); assert.equal(editor.result().spec.subAgents, undefined);
});

test('an inherited concurrent-safe role can be repaired explicitly before adding a write tool', async () => {
  const original = existing([{ name: 'writer', instructions: 'Write an isolated file', tools: ['write_workspace_file'], concurrent_safe: true }]);
  original.spec.bindings.tools.push({ resourceId: 'write_workspace_file' });
  const editor = form(original); await editor.flush(); editor.next(); editor.next(); editor.next();
  await editor.button('保存 Agent').props.onClick(); editor.render(); assert.equal(editor.result(), undefined);
  assert.ok(editor.nodes().some(node => node.props.role === 'alert' && node.children.some(value => typeof value === 'string' && value.includes('并发安全'))));
  editor.aria('角色 1 要求并发安全').props.onChange({ target: { checked: false } }); editor.render(); editor.next();
  await editor.button('保存 Agent').props.onClick();
  assert.equal(nativeChildRoles(editor.result().spec)[0].concurrentSafe, false);
});

test('a newly authored role inherits no additional tool permission and passes the production role parser', async () => {
  const editor = form(existing([])); await editor.flush(); editor.next(); editor.next();
  editor.button('添加子任务角色').props.onClick(); editor.render();
  for (const [label, value] of [['角色 1 标识', 'reader'], ['角色 1 任务说明', 'Read the provided evidence']]) {
    editor.aria(label).props.onChange({ target: { value } }); editor.render();
  }
  editor.aria('角色 1 工具 read_workspace_file').props.onChange({ target: { checked: true } }); editor.render();
  editor.next(); await editor.button('保存 Agent').props.onClick();
  const roles = nativeChildRoles(editor.result().spec);
  assert.deepEqual(roles[0].tools, ['read_workspace_file']); assert.equal(roles[0].modelProfileId, null);
  assert.equal(roles[0].inheritMcp, false); assert.equal(roles[0].maxTurns, 4);
});
