import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_INSTRUCTION_ASSEMBLY as policy, nativeInstructionAssembly } from '../src/native/instruction-assembly.mjs';

test('Host UI contributions cannot prescribe Native delivery or future UI execution protocols', () => {
  const caller = { name: 'enterprise:output-style', text: 'My instructions mention present and ui:delivery literally; keep these bytes.\n' };
  const sources = [{ name: 'ui:deliverable-file-references', text: 'Use the Host present tool.' },
    { name: 'ui:future-provider', text: 'Use another Host UI execution protocol.' }, caller];
  const assembly = { sections: sources, contexts: sources, tools: [{ name: 'present' }] };
  const current = nativeInstructionAssembly(assembly, { policy, toolNames: ['declare_deliverables', 'present'] });
  assert.deepEqual(current.sections, [caller]); assert.deepEqual(current.contexts, [caller]);
  assert.strictEqual(current.sections[0], caller); assert.strictEqual(current.tools, assembly.tools);
  for (const historical of ['admitted-tool-sections/v1', 'native-owned-sections/v2']) {
    const old = nativeInstructionAssembly(assembly, { policy: historical, toolNames: [] });
    assert.deepEqual(old.sections, sources); assert.deepEqual(old.contexts, sources);
  }
});

test('Native-owned admission selects system and context sources by the same ownership domains', () => {
  const persona = { name: 'deployment:persona-prefix', text: 'Keep literal harness:source and tool:read references in my instructions.\n' };
  const enterprise = { name: 'enterprise:policy', text: 'Exact business policy bytes', interpolate: false };
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'Host engine identity' },
      { name: 'harness:source', text: 'Host implementation checkout guidance' },
      { name: 'harness:new-operational-source', text: 'Another Host operational provider' },
      { name: 'app:web-surface', text: 'Host application development instructions' },
      { name: 'app:other-surface', text: 'Another Host application provider' },
      persona, { name: 'tool:read', text: 'Unavailable tool' },
      { name: 'tool:read_workspace_file', text: 'Admitted Native file tool' }, enterprise,
    ],
    contexts: [
      { name: 'harness:source', text: 'Host implementation checkout', required: true },
      { name: 'app:web-surface', text: 'Host URL', interpolate: false },
      { name: 'tool:read', text: 'Unavailable tool context' },
      { name: 'tool:read_workspace_file', text: 'Admitted Native file context' },
      { name: 'enterprise:context', text: 'Trusted business context', required: true },
    ], tools: [{ name: 'read' }], variables: { source: 'Not scanned or rewritten' },
  };
  const before = structuredClone(assembly);
  const actual = nativeInstructionAssembly(assembly, { policy, toolNames: ['read_workspace_file'] });
  assert.deepEqual(actual.sections.map(s => s.name), ['deployment:persona-prefix', 'tool:read_workspace_file', 'enterprise:policy']);
  assert.deepEqual(actual.contexts.map(s => s.name), ['tool:read_workspace_file', 'enterprise:context']);
  assert.equal(actual.sections[0], persona); assert.equal(actual.sections.at(-1), enterprise);
  assert.equal(actual.contexts.at(-1), assembly.contexts.at(-1));
  assert.equal(actual.tools, assembly.tools); assert.equal(actual.variables, assembly.variables);
  assert.deepEqual(assembly, before);
});

test('tool-owned guidance follows admitted source identities without editing user or business instructions', () => {
  const sections = [
    { name: 'harness:identity', text: 'Host identity' },
    { name: 'deployment:persona-prefix', text: 'User text mentioning read, glob and job_kill remains byte-identical.' },
    { name: 'tool:read', text: 'Legacy read guidance' },
    { name: 'tool:glob', text: 'Legacy glob guidance' },
    { name: 'tool:jobs', text: 'Legacy job output and cancellation' },
    { name: 'tool:subagent', text: 'Legacy delegation' },
    { name: 'tool:read_workspace_file', text: 'The actual file tool' },
    { name: 'tool:web_fetch', text: 'The actual web tool' },
    { name: 'enterprise:business-policy', text: 'Business instructions: preserve ALL original bytes.\n' },
  ];
  const assembly = { sections, tools: [{ name: 'read' }], variables: { model: 'original' } }, before = structuredClone(assembly);
  const projected = nativeInstructionAssembly(assembly, { policy, toolNames: ['read_workspace_file', 'web_fetch'] });
  assert.deepEqual(projected.sections.map(section => section.name), ['deployment:persona-prefix',
    'tool:read_workspace_file', 'tool:web_fetch', 'enterprise:business-policy']);
  assert.equal(projected.sections[0], sections[1]); assert.equal(projected.sections.at(-1).text, sections.at(-1).text);
  assert.equal(projected.tools, assembly.tools, 'selecting instruction sources cannot grant or remove executable tools');
  assert.equal(projected.variables, assembly.variables); assert.deepEqual(assembly, before);
});

test('group source ids require their complete interface and unknown non-tool sections remain intact', () => {
  const assembly = { sections: ['tool:goal', 'tool:jobs', 'tool:custom_tool', 'custom:unrecognized', 'apps', 'harnessX'].map(name => ({ name, text: name })) };
  const select = toolNames => nativeInstructionAssembly(assembly, { policy, toolNames }).sections.map(section => section.name);
  assert.deepEqual(select(['get_goal', 'job_output']), ['custom:unrecognized', 'apps', 'harnessX']);
  assert.deepEqual(select(['get_goal', 'create_goal', 'update_goal', 'job_output', 'job_kill', 'custom_tool']), assembly.sections.map(section => section.name));
});

test('legacy absence preserves the original assembly while unknown policies and malformed source records fail closed', () => {
  const assembly = { sections: [{ name: 'tool:read', text: 'Unchanged legacy instructions' }] };
  assert.equal(nativeInstructionAssembly(assembly), assembly);
  assert.equal(nativeInstructionAssembly({ tools: [] }, { policy }).sections, undefined);
  assert.throws(() => nativeInstructionAssembly(assembly, { policy: 'latest' }), /instruction_assembly_invalid/);
  assert.throws(() => nativeInstructionAssembly(assembly, { policy, toolNames: [null] }), /instruction_assembly_invalid/);
  assert.throws(() => nativeInstructionAssembly({ sections: [{ name: 'tool:read' }] }, { policy }), /instruction_sections_invalid/);
  assert.throws(() => nativeInstructionAssembly({ contexts: [{ name: 'harness:source' }] }, { policy }), /instruction_contexts_invalid/);
});

test('v1 recovery preserves its Host operational sections and contexts without silently adopting Native ownership', () => {
  const assembly = { sections: [
    { name: 'harness:identity', text: 'Original identity' },
    { name: 'harness:source', text: 'Original engine instructions' },
    { name: 'app:web-surface', text: 'Original application instructions' },
    { name: 'tool:read', text: 'Unavailable tool' },
    { name: 'enterprise:policy', text: 'Business policy' },
  ], contexts: [{ name: 'harness:source', text: 'Original context' }] };
  const v1 = nativeInstructionAssembly(assembly, { policy: 'admitted-tool-sections/v1', toolNames: [] });
  assert.deepEqual(v1.sections, assembly.sections.filter(s => s.name !== 'tool:read'));
  assert.equal(v1.contexts, assembly.contexts);
  assert.equal(nativeInstructionAssembly(assembly), assembly);
  assert.deepEqual(nativeInstructionAssembly(assembly, { policy }).sections, [assembly.sections.at(-1)]);
});
