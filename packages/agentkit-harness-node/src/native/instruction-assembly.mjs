import { invariant } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_TOOL_INSTRUCTION_ASSEMBLY = 'admitted-tool-sections/v1';
export const NATIVE_RUNTIME_INSTRUCTION_ASSEMBLY = 'native-owned-sections/v2';
export const NATIVE_INSTRUCTION_ASSEMBLY = 'native-owned-sections/v3';

export const isNativeInstructionAssemblyPolicy = policy =>
  [NATIVE_TOOL_INSTRUCTION_ASSEMBLY, NATIVE_RUNTIME_INSTRUCTION_ASSEMBLY, NATIVE_INSTRUCTION_ASSEMBLY].includes(policy);

// These reserved Host domains describe its engine/application implementation,
// not the Native execution environment. Native's bound model surface owns
// those facts. Selection applies to every named provider in each domain,
// including future providers; it never depends on the provider's prose.
const hostRuntimeDomains = new Set(['harness', 'app']);
// Host UI protocols belong to that UI's execution owner. Native's delivery
// schemas and renderer own the presentation contract for Native tasks.
const hostPresentationDomains = new Set([...hostRuntimeDomains, 'ui']);

// DSH's named section protocol has two families whose source id is not the
// name of a single tool. Keep a family only when its complete interface exists.
const families = new Map([
  ['tool:goal', ['get_goal', 'create_goal', 'update_goal']],
  ['tool:jobs', ['job_output', 'job_kill']],
]);

/** Project trusted Host contributions through one source-ownership rule.
 * v1 selects tool guidance only. v2 also leaves Host operational domains to
 * Native's bound environment, for both instructions and named contexts. v3
 * also leaves Host UI execution protocols to Native's presentation owner.
 * User/persona/business contributions retain their bytes and order. Neither
 * version changes tools, variables, execution policy or permissions. Historical
 * absence, v1 and v2 keep their original semantics during recovery. */
export function nativeInstructionAssembly(assembly, { policy, toolNames = [] } = {}) {
  if (policy === undefined) return assembly;
  invariant(isNativeInstructionAssemblyPolicy(policy) && assembly && typeof assembly === 'object'
    && Array.isArray(toolNames) && toolNames.every(name => typeof name === 'string' && name.trim()),
  'native_instruction_assembly_invalid');
  const names = new Set(toolNames);
  const nativeOwned = policy !== NATIVE_TOOL_INSTRUCTION_ASSEMBLY;
  const hostDomains = policy === NATIVE_INSTRUCTION_ASSEMBLY ? hostPresentationDomains : hostRuntimeDomains;
  const admitted = source => {
    const separator = source.name.indexOf(':');
    if (nativeOwned && separator > 0 && hostDomains.has(source.name.slice(0, separator))) return false;
    if (!source.name.startsWith('tool:')) return true;
    const required = families.get(source.name) ?? [source.name.slice('tool:'.length)];
    return required.every(name => names.has(name));
  };
  const select = (items, code) => {
    invariant(Array.isArray(items) && items.every(item => item
      && typeof item.name === 'string' && typeof item.text === 'string'), code);
    return items.filter(admitted);
  };
  // An opaque renderer has no named contributions to select. v1 must not
  // inspect contexts it historically left untouched.
  if (assembly.sections === undefined && (!nativeOwned || assembly.contexts === undefined)) return assembly;
  return { ...assembly,
    ...(assembly.sections === undefined ? {} : { sections: select(assembly.sections, 'native_instruction_sections_invalid') }),
    ...(!nativeOwned || assembly.contexts === undefined ? {} : { contexts: select(assembly.contexts, 'native_instruction_contexts_invalid') }),
  };
}
