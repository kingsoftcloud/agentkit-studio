// Declared Host consent/audit double for transport/Kernel boundary tests.
// Actual maintained ApprovalService audit coverage lives in
// scripts/verify-a2a-host-decisions.mjs; this is not evidence of human consent.
import { A2A_HOST_DECISION, a2aDecisionDigest } from '../../src/providers/native-a2a-decision.mjs';
export function controlConsent({ command, readOnly }) {
  if (readOnly) return 'allow';
  return { decision: 'allow', commandDigest: a2aDecisionDigest(command), receipt: {
    contract: A2A_HOST_DECISION, sessionId: 'session', presetId: 'fixture', requestId: `fixture:${command.commandId}`,
    callId: `fixture:${command.commandId}`, toolName: `a2a_${command.kind}_task`, requestDigest: a2aDecisionDigest(command),
    outcome: 'allowed-once', askedSeq: 0, decidedSeq: 1,
  } };
}
