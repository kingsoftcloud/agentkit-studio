import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STUDIO_OPERATION_IDS } from '../src/contracts/operations.mjs';

/**
 * Every control endpoint the browser client calls must be registered.
 *
 * #201 shipped `models/wire` through the service, the route and the RPC, and
 * still could not be clicked: the operation was never added to the allowlist,
 * so the dispatcher answered `agentkit/not-found` and the settings button
 * showed「无效 Server Action」. The service unit tests stayed green the whole
 * time — nothing compared the two lists.
 *
 * This is that comparison. It is deliberately source-level: the client builds
 * its calls from string literals, so the literal list is the contract.
 */

const clientSource = await readFile(new URL('../src/remote/control-client.mjs', import.meta.url), 'utf8');

/** Endpoint ids the browser client reaches for. */
function calledEndpoints(source) {
  const ids = new Set();
  for (const pattern of [/studioCall\(\s*'([^']+)'/g, /studioBridgeOperation\(\s*'([^']+)'/g, /skillBridgeCall\(\s*'([^']+)'/g]) {
    for (const match of source.matchAll(pattern)) ids.add(match[1]);
  }
  return [...ids].sort();
}

test('every control endpoint the browser client calls is registered', () => {
  const registered = new Set(STUDIO_OPERATION_IDS);
  const missing = calledEndpoints(clientSource).filter(endpoint => !registered.has(endpoint));
  assert.deepEqual(missing, [], `unregistered control endpoints: ${missing.join(', ')}`);
});

test('the probe endpoints are registered on both registries', async () => {
  // The allowlist above gates `/agentkit`; the browser actually reaches a
  // control endpoint through `server/action`, which keeps its own dispatch.
  const registered = new Set(STUDIO_OPERATION_IDS);
  const serverSource = await readFile(new URL('../src/host/routes/server.mjs', import.meta.url), 'utf8');
  const dispatched = new Set([...serverSource.matchAll(/action === '([^']+)'/g)].map(match => match[1]));
  for (const endpoint of ['models/probe', 'models/wire', 'models/efforts']) {
    assert.ok(registered.has(endpoint), `${endpoint} must be in STUDIO_OPERATION_IDS`);
  }
  // `models/probe` predates the dispatcher's `models/*` handling and is served
  // by the domain route; only `models/wire` needs the action dispatch. Assert
  // the one that does, so a future refactor cannot drop it silently.
  assert.ok(dispatched.has('models/wire'), 'models/wire must be dispatched by server/action');
});
