import { createHash } from 'node:crypto';
import { ENGINE_COMMAND_VERIFIER, ENGINE_VERIFICATION } from './engine-service-client.mjs';

const VERSION = '1';

// A standalone, explicit instruction is required. Examples, agent progress,
// model-authored test commands and historical messages cannot set acceptance.
function requestedCommand(goal) {
  const match = /^(?:验收命令|Acceptance command)\s*[:：]\s*`([^`\r\n]{1,1024})`[。.]?$/i.exec(goal.trimEnd().split(/\r?\n/).at(-1).trimStart());
  return match?.[1].trim() || null;
}

export function nativeEngineVerification({ objective, runId }) {
  const command = requestedCommand(objective);
  if (!command) return null;
  const bindingDigest = 'sha256:' + createHash('sha256').update(JSON.stringify([runId, objective, ENGINE_COMMAND_VERIFIER, VERSION])).digest('hex');
  const definition = { contract: ENGINE_VERIFICATION, verifierRef: ENGINE_COMMAND_VERIFIER, verifierVersion: VERSION, bindingDigest,
    evidenceTools: [], contextSourceId: null };

  return { definition, verify(request) {
    const binding = request?.definition;
    if (request?.contract !== ENGINE_VERIFICATION || request.runId !== runId || request.goal !== objective
      || binding?.verifierRef !== ENGINE_COMMAND_VERIFIER || binding.verifierVersion !== VERSION || binding.bindingDigest !== bindingDigest)
      throw Error('engine_verification_binding_mismatch');
    const reply = { contract: ENGINE_VERIFICATION, operationKey: request.operationKey, inputDigest: request.inputDigest };
    const result = (status, reason, safeSummary, evidenceRefs = []) => ({ ...reply, status, reason, safeSummary, evidenceRefs });
    const receipt = request.evidence.calls.find(item => item.call?.name === 'run_command'
      && typeof item.call.arguments?.command === 'string' && item.call.arguments.command.trim() === command);
    const args = receipt?.call.arguments, observed = receipt?.workspaceChangeObservation;
    if (!receipt || args.cwd && args.cwd !== '.' || args.hasEnvironmentOverride || args.background
      || typeof receipt.eventId !== 'string' || !receipt.eventId || !request.workspaceRevision
      || observed?.status !== 'captured' || observed.revision !== request.workspaceRevision
      || receipt.status !== 'ok' || receipt.content?.evidence_incomplete !== false || receipt.content?.status !== 'completed'
      || !Number.isSafeInteger(receipt.content.exit_code))
      return result('blocked', 'acceptance_command_not_observed', '未取得与当前工作区版本匹配的验收命令结果。');
    const passed = receipt.content.exit_code === 0;
    return result(passed ? 'passed' : 'failed', passed ? 'acceptance_command_passed' : 'acceptance_command_failed',
      passed ? '用户指定的验收命令已通过。' : '用户指定的验收命令执行失败。', [receipt.eventId]);
  } };
}
