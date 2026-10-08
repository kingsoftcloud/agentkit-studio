/** Acceptance assertions shared by the remote probe and its false-positive tests. */
const requireEvidence = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};

export function validateDeploymentCases(cases, manifest) {
  requireEvidence(Array.isArray(cases) && cases.length > 0 && cases.length <= 20, 'PROBE_CASES_INVALID');
  const ids = new Set();
  for (const item of cases) {
    requireEvidence(item && /^[a-z0-9-]{1,64}$/.test(item.id) && !ids.has(item.id), 'PROBE_CASES_INVALID');
    ids.add(item.id);
    requireEvidence(typeof item.input === 'string' && item.input.trim() && item.input.length <= 128000, 'PROBE_CASES_INVALID');
    requireEvidence(!item.restart && !item.delayMs && !item.continueFrom, 'PROBE_LIFECYCLE_CASE_UNSUPPORTED');
    for (const field of ['expectedText', 'expectedTools']) {
      requireEvidence(item[field] === undefined || (Array.isArray(item[field]) && item[field].length <= 20
        && item[field].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096)), 'PROBE_CASES_INVALID');
    }
    for (const field of ['expectedStreamPrefix', 'expectedToolArguments', 'expectedToolResult']) {
      requireEvidence(item[field] === undefined || (typeof item[field] === 'string' && item[field].length > 0 && item[field].length <= 4096), 'PROBE_CASES_INVALID');
    }
    for (const pattern of item.expectedTools || []) {
      try { new RegExp(pattern); } catch { requireEvidence(false, 'PROBE_TOOL_PATTERN_INVALID'); }
    }
    if (item.isolatedKnowledge) {
      const resources = manifest.resources;
      requireEvidence(resources.remote?.length > 0 && resources.remote.every(resource => resource.kind === 'knowledge-base')
        && !resources.mcps.length && !resources.skills.length, 'PROBE_KNOWLEDGE_NOT_ISOLATED');
    }
  }
}

export function verifyDeploymentCase(frames, item, manifest) {
  const completed = frames.find(frame => frame.type === 'response.completed');
  requireEvidence(completed && !frames.some(frame => frame.type === 'response.failed'), 'PROBE_COMPLETION_MISSING');
  requireEvidence(completed.metadata?.agentkit?.agentId === manifest.agentId
    && completed.metadata?.agentkit?.buildId === manifest.buildId, 'PROBE_BUILD_IDENTITY_MISMATCH');
  requireEvidence(Array.isArray(completed.output) && typeof completed.output_text === 'string', 'PROBE_OUTPUT_INVALID');
  const calls = completed.output.filter(output => output.type === 'function_call');
  const success = call => frames.some(frame => frame.type === 'response.tool_result' && frame.call_id === call.call_id
    && frame.is_error === false && Array.isArray(frame.output));
  for (const expected of item.expectedText || []) requireEvidence(completed.output_text.includes(expected), 'PROBE_ANSWER_MISMATCH');
  for (const pattern of item.expectedTools || []) {
    const matches = calls.filter(call => new RegExp(pattern).test(call.name));
    requireEvidence(matches.length, 'PROBE_BOUND_TOOL_MISSING');
    requireEvidence(matches.some(success), 'PROBE_TOOL_SUCCESS_MISSING');
  }
  const executed = calls.filter(call => (!(item.expectedTools?.length)
    || item.expectedTools.some(pattern => new RegExp(pattern).test(call.name)))
    && (!item.expectedToolArguments || String(call.arguments).includes(item.expectedToolArguments)));
  if (item.expectedToolArguments) requireEvidence(executed.some(success), 'PROBE_SCRIPT_EXECUTION_MISSING');
  if (item.expectedToolResult) requireEvidence(frames.some(frame => frame.type === 'response.tool_result' && frame.is_error === false
    && executed.some(call => call.call_id === frame.call_id) && frame.output?.some(part => String(part.text || '').includes(item.expectedToolResult))), 'PROBE_TOOL_RESULT_MISMATCH');
  if (item.isolatedKnowledge) requireEvidence(calls.length === 0, 'PROBE_KNOWLEDGE_EXTERNAL_TOOL');
  const deltas = frames.filter(frame => frame.type === 'response.output_text.delta');
  requireEvidence(deltas.length > 1, 'PROBE_INCREMENTAL_STREAM_MISSING');
  if (item.expectedStreamPrefix) requireEvidence(deltas.map(frame => frame.delta || '').join('').startsWith(item.expectedStreamPrefix), 'PROBE_SYSTEM_PREFIX_MISSING');
  requireEvidence(completed.usage?.input_tokens > 0 && completed.usage?.output_tokens > 0, 'PROBE_USAGE_MISSING');
  return { passed: true, responseId: completed.id, toolNames: calls.map(call => call.name), textFrames: deltas.length,
    usage: completed.usage, ...(item.isolatedKnowledge ? { isolatedKnowledge: true } : {}) };
}
