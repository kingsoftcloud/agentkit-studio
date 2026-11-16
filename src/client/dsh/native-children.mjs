import { createNativeChildPanel as createPanel } from '@kingsoftcloud/agentkit-harness-ui/host/native-run-panel';
import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { createDshA2aPanel } from './dsh-a2a.mjs';
import { HARNESS_SERVICE_PRESET_SUFFIX } from '../../harness-service-preset.mjs';

/** Product preset identity and other runtimes stay in the Studio adapter. */
export function createNativeChildPanel(options) {
  return createPanel({ ...options, resolveAgentFromPreset: (presetId, agents) => typeof presetId === 'string' && presetId.endsWith(HARNESS_SERVICE_PRESET_SUFFIX)
    ? null : agentFromSessionPreset(presetId, agents), createForeignRuntimePanel: createDshA2aPanel });
}
