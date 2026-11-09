import assert from 'node:assert/strict';

// Host test peers receive the same raw batch as the real DSH ToolService.
export function nativeDshBatchPeer(tools) {
  return {
    ...tools,
    executeSingle: tools.execute,
    callerOptionsContract: 'dsh.tool-batch-caller-options/v1',
    async execute({ calls, signal, agent, callerOptions }) {
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.equal(call.type, 'tool-call');
      const args = JSON.parse(call.arguments, (_key, value, context) => {
        if (callerOptions?.argumentEncoding === 'dsh.raw-json-number/v1' && typeof value === 'number'
          && (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
          return JSON.rawJSON(context.source);
        return value;
      });
      const result = await this.executeSingle({ callId: call.id, name: call.name, arguments: args, signal, agent, ...callerOptions });
      return { results: [{ callId: call.id, result }], additionalContexts: result.additionalContexts ?? [],
        concluded: result.concludesTurn === true };
    },
  };
}
