/** Response-only diagnostics. These values never accept or grant a client permission request. */
export const UNATTENDED_EXECUTION_POLICY = Object.freeze({
  format: 'agentkit.execution-policy/v1', permissionMode: 'read-only',
  approvalPolicy: 'never', approvalSource: 'runtime-policy',
});

/** Missing, future or malformed wire values remain unknown. */
export function readExecutionPolicy(value) {
  if (!value || value.format !== 'agentkit.execution-policy/v1'
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(value.permissionMode)
    || !['ask', 'never'].includes(value.approvalPolicy)
    || value.approvalSource !== 'runtime-policy') return null;
  return { format: value.format, permissionMode: value.permissionMode,
    approvalPolicy: value.approvalPolicy, approvalSource: value.approvalSource };
}
