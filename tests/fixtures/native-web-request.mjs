import { nativeWebToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/web-tools';

/** Complete trusted Run context for adapter tests; explicit overrides remain
 * intact so invalid identities and drift tests exercise the actual port. */
export function webRequest(request) {
  return { scope: { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' },
    runId: 'run', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain',
    operationKey: 'web-operation', executionFence: 1,
    definition: nativeWebToolDefinitions().find(definition => definition.name === request.call?.name), ...request };
}
