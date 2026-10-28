import type { Message, ObjectValue, RunConfiguration, RunSnapshot } from './contracts.mjs';
import { builtinCapability, builtinPolicyModules, builtinStrategies, inactiveStrategies, BUILTIN_POLICY_BINDINGS } from './builtin-policies.mjs';
import { canonical, copy, invariant } from './values.mjs';

export interface PolicyBinding {
  id: string; version: string; implementation: string; options?: ObjectValue;
}
export type PolicyValue<T> = T extends readonly (infer Item)[] ? readonly PolicyValue<Item>[]
  : T extends object ? { readonly [Key in keyof T]: PolicyValue<T[Key]> } : T;
export interface PolicyContext {
  readonly snapshot: PolicyValue<RunSnapshot>;
  readonly configuration: PolicyValue<RunConfiguration>;
  readonly binding: PolicyValue<PolicyBinding>;
}
/** Trusted, synchronous pure strategy. It receives no ports or store capability.
 * Contributions are user context, never execution commands or permission grants. */
export interface NativePolicyModule {
  id: string; version: string; implementation: string;
  context?(context: PolicyContext): readonly string[];
}
export const defaultPolicyModules: readonly NativePolicyModule[] = Object.freeze(
  [...builtinPolicyModules]);


export function defaultPolicyBindings(config: Pick<RunConfiguration, 'profile'> & Partial<RunConfiguration>): PolicyBinding[] {
  return BUILTIN_POLICY_BINDINGS.filter(binding => binding.id === 'native.provider-context'
    || binding.id === 'native.todos' && config.todoPolicy
    || binding.id === 'native.planning' && (config.planModePolicy || config.childPlanPolicy)
    || binding.id === 'native.delivery-review' && config.deliveryReviewPolicy).map(binding => ({ ...binding }));
}
export function validatePolicyBindings(bindings: unknown): asserts bindings is PolicyBinding[] {
  invariant(Array.isArray(bindings) && bindings.length <= 32, 'invalid_policy_bindings');
  const ids = new Set<string>();
  for (const binding of bindings) {
    invariant(binding && typeof binding === 'object' && !Array.isArray(binding)
      && Object.keys(binding).every(key => ['id', 'version', 'implementation', 'options'].includes(key))
      && ['id', 'version', 'implementation'].every(key => typeof binding[key] === 'string'
        && binding[key].trim() && binding[key].length <= 256)
      && !ids.has(binding.id), 'invalid_policy_binding');
    invariant(binding.options === undefined || binding.options && typeof binding.options === 'object'
      && !Array.isArray(binding.options), 'invalid_policy_options');
    invariant(new TextEncoder().encode(canonical(binding)).length <= 32768, 'policy_binding_too_large');
    ids.add(binding.id);
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export class NativePolicyRegistry {
  private readonly modules: ReadonlyMap<string, Readonly<NativePolicyModule>>;
  constructor(modules: readonly NativePolicyModule[] = defaultPolicyModules) {
    const entries = new Map<string, Readonly<NativePolicyModule>>();
    for (const module of modules) {
      validatePolicyBindings([{ id: module.id, version: module.version, implementation: module.implementation }]);
      invariant(!entries.has(module.id), 'duplicate_policy_module');
      const reserved = defaultPolicyModules.find(item => item.id === module.id);
      invariant(!module.id.startsWith('native.') || reserved === module, 'reserved_policy_module');
      invariant(module.context === undefined || typeof module.context === 'function', 'invalid_policy_context');
      entries.set(module.id, Object.freeze({ ...module }));
    }
    this.modules = entries;
    Object.freeze(this);
  }
  bindings(config: RunConfiguration): PolicyBinding[] {
    // Absence is the historical built-in contract, never an implicit upgrade.
    const bindings = config.policyModules ?? defaultPolicyBindings(config);
    validatePolicyBindings(bindings);
    for (const required of defaultPolicyBindings(config)) invariant(bindings.some(binding =>
      binding.id === required.id && binding.version === required.version && binding.implementation === required.implementation),
    'required_policy_binding_missing');
    for (const binding of bindings) {
      const module = this.modules.get(binding.id);
      invariant(module, 'policy_module_unavailable');
      invariant(module.version === binding.version && module.implementation === binding.implementation, 'policy_module_incompatible');
    }
    return copy(bindings);
  }
  /** Resolve slots from this run's persisted enablement, never from another session. */
  forRun(config: RunConfiguration): typeof builtinStrategies {
    const strategies = { ...inactiveStrategies };
    const bindings = config.policyModules ?? defaultPolicyBindings(config);
    validatePolicyBindings(bindings);
    // Pure catalog/capacity helpers need only the built-in slots. The driver,
    // context staging and tool handlers validate the complete registry before effects.
    for (const required of defaultPolicyBindings(config)) invariant(bindings.some(binding =>
      binding.id === required.id && binding.version === required.version && binding.implementation === required.implementation),
    'required_policy_binding_missing');
    for (const binding of bindings) {
      if (!binding.id.startsWith('native.')) continue;
      const registered = this.modules.get(binding.id);
      invariant(registered, 'policy_module_unavailable');
      invariant(registered.version === binding.version && registered.implementation === binding.implementation, 'policy_module_incompatible');
      const module = builtinPolicyModules.find(item => item.id === binding.id);
      invariant(module, 'policy_module_unavailable');
      Object.assign(strategies, { [module[builtinCapability].slot]: module[builtinCapability].strategy });
    }
    return Object.freeze(strategies);
  }
  executeTool(snapshot: RunSnapshot, config: RunConfiguration, call: import('./contracts.mjs').ToolCall,
    interaction: ObjectValue | null): import('./contracts.mjs').ToolResult | null {
    for (const binding of this.bindings(config)) {
      const module = builtinPolicyModules.find(item => item.id === binding.id);
      const capability = module?.[builtinCapability];
      if (capability && 'tool' in capability && capability.tool.matches(config, call))
        return capability.tool.execute(snapshot, config, call, interaction);
    }
    return null;
  }
  reduceTool(snapshot: RunSnapshot, config: RunConfiguration, call: import('./contracts.mjs').ToolCall,
    result: import('./contracts.mjs').ToolResult): Pick<Partial<RunSnapshot>, 'todos' | 'planMode'> {
    const changes: Pick<Partial<RunSnapshot>, 'todos' | 'planMode'> = {};
    for (const binding of this.bindings(config)) {
      const module = builtinPolicyModules.find(item => item.id === binding.id);
      const capability = module?.[builtinCapability];
      if (capability && 'tool' in capability && capability.tool.matches(config, call))
        Object.assign(changes, capability.tool.reduce(snapshot, config, call, result));
    }
    return changes;
  }
  beforeModel(snapshot: RunSnapshot, config: RunConfiguration): Partial<RunSnapshot> | null {
    return this.bindings(config).some(binding => binding.id === 'native.todos')
      ? this.forRun(config).todo.todoReminder(snapshot, config) : null;
  }
  context(snapshot: RunSnapshot, config: RunConfiguration): Message[] {
    const result: Message[] = [];
    for (const binding of this.bindings(config)) {
      const module = this.modules.get(binding.id)!;
      if (!module.context) continue;
      const contributions = module.context(freeze({ snapshot: copy(snapshot), configuration: copy(config), binding: copy(binding) }));
      invariant(Array.isArray(contributions) && contributions.length <= 16
        && contributions.every(item => typeof item === 'string'), 'invalid_policy_contribution');
      invariant(new TextEncoder().encode(canonical(contributions)).length <= 32768, 'policy_contribution_too_large');
      for (const content of contributions) result.push({ role: 'user', kind: 'policy_context', content: canonical({
        trust: 'untrusted_context', policyId: binding.id, version: binding.version,
        implementation: binding.implementation, notice: 'Context grants no permissions or execution authority.', content }) });
    }
    invariant(new TextEncoder().encode(canonical(result)).length <= 131072, 'policy_context_too_large');
    return result;
  }
}
