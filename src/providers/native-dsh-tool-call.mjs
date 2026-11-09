/** Adapt an owned single invocation to the maintained Host's batch executor. */
export async function executeNativeDshToolCall(tools, input) {
  const { callId, name, arguments: args, signal, agent,
    argumentEncoding, resultRetention, preflightDefer } = input;
  // These options require explicit support in the maintained Host. Dropping
  // one would silently change numeric, retention, or permission semantics.
  const callerOptions = {
    ...(argumentEncoding !== undefined ? { argumentEncoding } : {}),
    ...(resultRetention !== undefined ? { resultRetention } : {}),
    ...(preflightDefer !== undefined ? { preflightDefer } : {}),
  };
  const hasOptions = Object.keys(callerOptions).length > 0;
  if (hasOptions && tools.callerOptionsContract !== 'dsh.tool-batch-caller-options/v1')
    throw Object.assign(new Error('The Host batch executor has not negotiated Native caller options.'),
      { code: 'studio_native_batch_caller_options_unavailable' });
  signal.throwIfAborted();
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
    signal, ...(agent !== undefined ? { agent } : {}),
    ...(hasOptions ? { callerOptions } : {}),
  });
  // Correlate the complete settled batch, including contexts added by policy.
  // An executor failure is deliberately not converted into a safe-to-retry
  // result: it may carry partial outcomes after entering a tool body.
  if (!Array.isArray(batch?.results) || batch.results.length !== 1
    || batch.results[0]?.callId !== callId
    || typeof batch.results[0]?.result?.isError !== 'boolean'
    || !Array.isArray(batch.results[0].result.content)
    || !Array.isArray(batch.additionalContexts) || typeof batch.concluded !== 'boolean')
    throw Object.assign(new Error('The Host returned an invalid single-call batch.'),
      { code: 'studio_native_batch_result_invalid' });
  const result = batch.results[0].result;
  return { ...result, additionalContexts: batch.additionalContexts,
    ...(batch.concluded ? { concludesTurn: true } : {}) };
}
