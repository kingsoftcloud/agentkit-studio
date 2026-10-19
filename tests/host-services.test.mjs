import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createStudioServices } from '../src/host/services/index.mjs';
import { createPlatformServices } from '../src/host/services/platform.mjs';

function mockHostRequests(t, origin, requests) {
  const previous = getGlobalDispatcher(), dispatcher = new MockAgent();
  dispatcher.disableNetConnect(); setGlobalDispatcher(dispatcher);
  t.after(async () => { setGlobalDispatcher(previous); await dispatcher.close(); });
  dispatcher.get(origin).intercept({ path: /ListAgents/, method: 'POST' }).reply(options => {
    const entries = Array.isArray(options.headers) && typeof options.headers[0] === 'string'
      ? Array.from({ length: options.headers.length / 2 }, (_, i) => [options.headers[i * 2], options.headers[i * 2 + 1]]) : options.headers;
    requests.push({ url: new URL(options.path, origin), headers: new Headers(entries) });
    return { statusCode: 200, data: JSON.stringify({ Code: 0, Data: { Agents: [], Total: 0 } }) };
  });
}

function context() {
  const credentials = { label: Symbol('host-credentials') };
  const releases = [];
  return {
    credentials,
    get: name => name === 'credentials' ? credentials : undefined,
    effect: setup => { releases.push(setup()); },
    close: async () => { for (const release of releases.reverse()) await release?.(); },
  };
}

test('fresh cloud Host uses AICP without requiring a saved Server URL', async t => {
  const home = await mkdtemp(join(tmpdir(), 'studio-cloud-default-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests = [];
  mockHostRequests(t, 'https://aicp.api.ksyun.com', requests);
  const services = createPlatformServices(context(), {
    env: { AGENTKIT_HOME: home, KSYUN_REGION: 'pre-online', KSYUN_ACCESS_KEY: 'AKTEST', KSYUN_SECRET_KEY: 'SKTEST' },
    configurationHome: home, portableRuntime: {}, cloudEndpointOptions: {},
  });
  await (await services.serverClientPromise).action('ListAgents', { Page: 1, PageSize: 20 });
  assert.equal(requests[0].url.origin, 'https://aicp.api.ksyun.com');
  assert.equal(requests[0].headers.get('X-KSC-CUSTOM-SOURCE'), 'pre');
  assert.match(requests[0].headers.get('Authorization'), /^AWS4-HMAC-SHA256 /);
});

test('Host keeps an explicitly configured local development bridge', async t => {
  const home = await mkdtemp(join(tmpdir(), 'studio-explicit-bridge-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests = [];
  mockHostRequests(t, 'http://127.0.0.1:31999', requests);
  const services = createPlatformServices(context(), {
    env: { AGENTKIT_HOME: home, AGENTKIT_STUDIO_HOST_URL: 'http://127.0.0.1:31999', AGENTKIT_STUDIO_HOST_SESSION_TOKEN: 'fixture-session' },
    configurationHome: home, portableRuntime: {}, cloudEndpointOptions: {},
  });
  await (await services.serverClientPromise).action('ListAgents', { Page: 1, PageSize: 20 });
  assert.equal(requests[0].url.origin, 'http://127.0.0.1:31999');
  assert.equal(requests[0].headers.get('X-AgentKit-Session'), 'fixture-session');
});

test('composed Host domains keep configuration, agents and resource stores isolated', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'studio-service-graph-'));
  const contexts = [context(), context()];
  const graphs = contexts.map((ctx, index) => {
    const home = join(scratch, String(index));
    return createStudioServices(ctx, {
      env: { AGENTKIT_HOME: home }, storeDir: join(home, 'studio'),
      // A portable graph does not inherit the user's legacy global settings.
      portableRuntime: {}, cloudEndpointOptions: {},
      getAdmission: () => undefined, getModels: () => undefined, getPortableBundles: () => undefined,
    });
  });
  try {
    for (const graph of graphs) await Promise.all(Object.values(graph).filter(value => value instanceof Promise));
    const [left, right] = await Promise.all(graphs.map(graph => graph.agentStorePromise));
    const agent = await left.create({ name: 'Only in left Host', spec: { instructions: { system: 'left fixture' } } });
    assert.equal((await left.get(agent.metadata.id)).metadata.name, 'Only in left Host');
    assert.equal(await right.get(agent.metadata.id), null);
    assert.deepEqual(await right.list(), []);
    const configurations = await Promise.all(graphs.map(graph => graph.configurationPromise));
    await configurations[0].update({ modelName: 'left-model-fixture' });
    assert.equal((await configurations[0].resolve()).values.modelName, 'left-model-fixture');
    assert.equal((await configurations[1].resolve()).values.modelName, undefined);
    const resources = await Promise.all(graphs.map(graph => graph.localMcpStorePromise));
    assert.notEqual(resources[0].root, resources[1].root);
    assert.equal(graphs[0].credentialsService, contexts[0].credentials);
    assert.equal(graphs[1].credentialsService, contexts[1].credentials);
    assert.notEqual(graphs[0].credentialsService, graphs[1].credentialsService);
  } finally {
    for (const graph of graphs) {
      await (await graph.studioSchedulerPromise)?.dispose();
      await (await graph.studioChannelsPromise)?.dispose();
    }
    await Promise.all(contexts.map(ctx => ctx.close()));
    await rm(scratch, { recursive: true, force: true });
  }
});
