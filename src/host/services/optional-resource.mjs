/** A failed optional resource domain must not prevent native Session startup.
 * Failures stay explicit when a resource is actually used; no empty result or
 * substitute executor can silently change the bound Agent's behavior.
 */
export function optionalResourceAdapter(promise) {
  return Promise.resolve(promise).catch(error => {
    const fail = async () => {
      throw Object.assign(new Error('Studio resource service is unavailable'), {
        code: 'RESOURCE_SERVICE_UNAVAILABLE', status: 503,
        details: { causeCode: String(error?.code || 'RESOURCE_INIT_FAILED') },
      });
    };
    return Object.freeze({
      unavailable: true,
      describeMcp: fail, listMcpTools: fail, callMcpTool: fail, loadSkill: fail,
      searchKnowledge: fail, searchMemory: fail, writeMemory: fail,
      close: async () => {},
    });
  });
}
