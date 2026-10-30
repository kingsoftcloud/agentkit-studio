/** DSH reserves run_code for PTC. Native keeps its original formal name;
 * only the registry transport and legacy DSH catalog use this explicit alias. */
export const SANDBOX_CODE_NAME_CONTRACT = 'agentkit.sandbox-code-registry-name/v1';
export const SANDBOX_CODE_NAME = 'sandbox_run_code';
export const sandboxRegistryName = name => name === 'run_code' ? SANDBOX_CODE_NAME : name;
