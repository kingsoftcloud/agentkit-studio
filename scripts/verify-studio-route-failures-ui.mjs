/** Negative RPCs exercise the real authenticated Host without making writes. */
import assert from 'node:assert/strict';

export async function verifyStudioRouteFailures(page) {
  const cases = [
    { method: 'credentials/put', payload: { name: 'invalid name', value: 'fixture-value' }, code: 'CREDENTIAL_NAME_INVALID' },
    { method: 'credentials/put', payload: { name: 'REFACTOR_EMPTY_VALUE', value: '' }, code: 'CREDENTIAL_VALUE_MISSING' },
    { method: 'mcp/update', payload: { resourceId: '' }, code: 'MCP_NOT_FOUND' },
    { method: 'resources/delete', payload: { resourceId: '', scope: 'local' }, code: 'MCP_ID_INVALID' },
    { method: 'builds/download', payload: { agentId: 'refactor-fixture', buildId: 'invalid' }, code: 'BUILD_ID_INVALID' },
  ];
  const results = await page.evaluate(async cases => {
    const results = [];
    for (const [index, item] of cases.entries()) {
      const rpcId = `refactor-negative-${index}`;
      const response = await fetch('/agentkit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: item.method, payload: item.payload, rpcId }),
      });
      const message = await response.json();
      results.push({ method: item.method, status: response.status, rpcIdMatches: message.rpcId === rpcId,
        type: message.type, ok: message.result?.ok, code: message.result?.error?.code,
        leakedValue: JSON.stringify(message).includes('fixture-value') });
    }
    return results;
  }, cases);
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 200, `${result.method} must retain its RPC transport status`);
    assert.equal(result.type, 'server-response');
    assert.equal(result.rpcIdMatches, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, cases[index].code, `${result.method} must retain its existing failure code`);
    assert.equal(result.leakedValue, false);
  }
  return results.map(result => ({ ...result, passed: true }));
}
