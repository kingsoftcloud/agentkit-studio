import { apply as applyProof } from './studio-native-harness.mjs';

export const name = 'studio-native-mounted-host-verification';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer'];
export async function apply(ctx, options) { await applyProof(ctx, { ...options, mountHost: true }); }
