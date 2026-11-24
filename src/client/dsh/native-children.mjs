import { createNativeChildPanel as createPanel } from './native-run-panel.mjs';
import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { createDshA2aPanel } from './dsh-a2a.mjs';
import { HARNESS_SERVICE_PRESET_SUFFIX } from '../../harness-service-preset.mjs';

/** Product preset identity and other runtimes stay in the Studio adapter. */
export function createNativeChildPanel(options, panel = createPanel) {
  return panel({ ...options, resolveAgentFromPreset: (presetId, agents) => typeof presetId === 'string' && presetId.endsWith(HARNESS_SERVICE_PRESET_SUFFIX)
    ? null : agentFromSessionPreset(presetId, agents), createForeignRuntimePanel: createDshA2aPanel });
}
