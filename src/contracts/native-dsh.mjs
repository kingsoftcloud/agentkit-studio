/** Versions used by the DSH host and compatible Harness implementations. */
export const NATIVE_DSH_TURN_CONTRACT = 'agentkit.native-dsh-turn/v1';
export const NATIVE_DSH_MANAGED_TURN_CONTRACT = 'agentkit.native-managed-dsh-turn/v1';
export const NATIVE_DSH_CONTENT_FORMAT = 'agentkit.dsh-content/v1';
export const NATIVE_ENGINE = 'agentkit.native/v1';
export const NATIVE_SCHEMA = 'agentkit.native-run/v1';
export const NATIVE_GOAL_CONTRACT_BINDING = 'agentkit.native-goal-contract/v1';
export const CONTEXT_SOURCE_CONTRACT = 'agentkit.native-context-source/v1';
export const OWNED_COMMAND_OUTPUT_CONTRACT = 'agentkit.owned-command-output/v1';
export const NATIVE_COMPONENT_TOOLS_CONTRACT = 'agentkit.native-component-tools/v1';
export const E2B_COMMAND_TOOLS_CONTRACT = 'agentkit.native-e2b-command-tools/v1';
export const E2B_CODE_TOOLS_CONTRACT = 'agentkit.native-e2b-code-tools/v1';
export const SKILL_EVENT_FILE = '.agentkit-skill-events.jsonl';

const commandTerminalStatuses = new Set(['completed', 'failed', 'canceled', 'timed_out', 'output_limit', 'unknown']);
/** @param {string} status */
export const isTerminalCommandStatus = status => commandTerminalStatuses.has(status);
