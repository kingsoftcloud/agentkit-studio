import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioServices } from '../src/host/services/index.mjs';

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
