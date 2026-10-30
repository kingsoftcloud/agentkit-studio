import { createNativeChildPanel as createPanel } from '@kingsoftcloud/agentkit-harness-ui/host/native-run-panel';
import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { createDshA2aPanel } from './dsh-a2a.mjs';

/** Product preset identity and other runtimes stay in the Studio adapter. */
export function createNativeChildPanel(options) {
  return createPanel({ ...options, resolveAgentFromPreset: agentFromSessionPreset, createForeignRuntimePanel: createDshA2aPanel });
}
