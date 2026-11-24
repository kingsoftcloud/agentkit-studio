import { createHash } from 'node:crypto';
import { ENGINE_COMMAND_VERIFIER, ENGINE_VERIFICATION } from './engine-service-client.mjs';

const VERSION = '1';
const MAX_EVIDENCE_REFS = 16;
const COMMAND_DECLARATION = /^(?:验收命令|Acceptance command)\s*[:：]\s*/i;

// A standalone, explicit instruction is required. Examples, agent progress,
// model-authored test commands and historical messages cannot set acceptance.
function requestedCommands(goal) {
  const commands = [];
  let malformed = false;
  for (const line of goal.trimEnd().split(/\r?\n/).reverse()) {
    const declaration = line.trim();
    const prefix = COMMAND_DECLARATION.exec(declaration);
    if (!prefix) break;
    const match = /^`([^`\r\n]{1,1024})`[。.]?$/.exec(declaration.slice(prefix[0].length));
    const command = match?.[1].trim();
    if (command) commands.push(command);
    else malformed = true;
  }
  return { commands: [...new Set(commands.reverse())], malformed };
}

function currentCommandReceipt(request, command) {
  const receipt = request.evidence.calls.find(item => item.call?.name === 'run_command'
    && typeof item.call.arguments?.command === 'string' && item.call.arguments.command.trim() === command);
  const args = receipt?.call.arguments, observed = receipt?.workspaceChangeObservation;
  const exitCode = receipt?.content?.exit_code;
  const commandStatus = receipt?.content?.status;
  if (!receipt || args.cwd && args.cwd !== '.' || args.hasEnvironmentOverride || args.background
    || typeof receipt.eventId !== 'string' || !receipt.eventId || !request.workspaceRevision
    || observed?.status !== 'captured' || observed.revision !== request.workspaceRevision
    || receipt.status !== 'ok' || receipt.content?.evidence_incomplete !== false
    || !Number.isSafeInteger(exitCode) || !['completed', 'failed'].includes(commandStatus)
    || commandStatus === 'failed' && exitCode === 0) return null;
  return { exitCode, eventId: receipt.eventId };
}

export function nativeEngineVerification({ objective, runId }) {
  const { commands, malformed } = requestedCommands(objective);
  if (!commands.length && !malformed) return null;
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
    if (malformed)
      return result('blocked', 'acceptance_command_invalid', '验收命令必须在反引号内写成一条非空的单行命令。');
    if (commands.length > MAX_EVIDENCE_REFS)
      return result('blocked', 'acceptance_command_count_exceeded', '验收命令数超出验证回执上限。请合并相关验收命令后重试。');
    const receipts = commands.map(command => currentCommandReceipt(request, command));
    const failed = receipts.findIndex(receipt => receipt && receipt.exitCode !== 0);
    const label = index => commands.length === 1 ? '验收命令' : `第 ${index + 1} 项验收命令`;
    if (failed !== -1) {
      const { exitCode, eventId } = receipts[failed];
      return result('failed', 'acceptance_command_failed', `用户指定的${label(failed)}执行失败，退出码为 ${exitCode}。`, [eventId]);
    }
    const missing = receipts.indexOf(null);
    if (missing !== -1)
      return result('blocked', 'acceptance_command_not_observed', `未取得与当前工作区版本匹配的${label(missing)}结果。`);
    return result('passed', 'acceptance_command_passed', '用户指定的验收命令已通过。', [...new Set(receipts.map(receipt => receipt.eventId))]);
  } };
}
