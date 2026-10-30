import { nativeChildRoles } from './providers/native-subagents.mjs';

/** Validate at preset admission without turning omitted budgets into explicit legacy limits. */
export function nativeChildRoleDeclarations(spec) {
  nativeChildRoles(spec);
  return structuredClone(spec.subAgents ?? spec.sub_agents ?? []).map(role => Object.fromEntries(
    Object.entries(role).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value])));
}
