import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudSchedules } from '../src/cloud-schedules.mjs';

function setup() {
  const writes = [], ids = new Set(['ar-cloud']);
  const task = { TaskId: 'task-1', AgentId: 'ar-cloud', DisplayName: 'Daily', Prompt: '总结今天的任务', Revision: 3, Enabled: true, Schedule: { kind: 'interval', everySeconds: 3600 } };
  const availability = { Enabled: true, RuntimeContracts: ['agentkit.responses/v1'] };
  const reply = data => ({ data });
  const api = { list: async () => reply({ Tasks: [task], Availability: availability }), get: async () => reply({ Task: task }),
    occurrences: async () => reply({ Occurrences: [{ OccurrenceId: 'occ-1', AgentId: task.AgentId, TaskId: task.TaskId, State: 'succeeded' }] }),
    create: async payload => { writes.push(['create', payload]); return reply({ Task: task }); },
    update: async (id, payload) => { writes.push(['update', id, payload]); return reply({ Task: task }); },
    remove: async id => { writes.push(['delete', id]); return reply({}); },
    run: async id => { writes.push(['run', id]); return reply({}); },
  };
  const service = createCloudSchedules({ client: async () => ({ forAgent: () => ({ schedules: api }) }), agents: async () => ({
    list: async () => ({ items: [...ids].map(id => ({ metadata: { id } })) }),
    get: async id => { if (!ids.has(id)) throw new Error('not owned'); return {}; },
  }) });
  return { service, writes, availability, task };
}

test('cloud lifecycle projects Server tasks, scope and revision without using a local timer', async () => {
  const { service, writes } = setup();
  const catalog = await service.execute('list');
  assert.equal(catalog.availability.alwaysOn, true);
  assert.equal(catalog.availability.triggerActive, true);
  assert.deepEqual(catalog.items[0].target, { agentId: 'ar-cloud' });
  assert.equal(catalog.items[0].command.payload.content, '总结今天的任务');
  await service.execute('create', { agentId: 'ar-cloud', spec: { prompt: '新的计划', displayName: 'New', enabled: true, AgentId: 'untrusted' } });
  assert.deepEqual(writes[0], ['create', { DisplayName: 'New', Prompt: '新的计划', Enabled: true }]);
  await service.execute('update', { agentId: 'ar-cloud', taskId: 'task-1', patch: { enabled: false, expectedRevision: 2 } });
  assert.deepEqual(writes[1], ['update', 'task-1', { Enabled: false, ExpectedRevision: 2 }]);
  await service.execute('run', { agentId: 'ar-cloud', taskId: 'task-1' });
  const rows = await service.execute('occurrences', { agentId: 'ar-cloud', taskId: 'task-1' });
  assert.equal(rows.items[0].state, 'succeeded');
});

test('legacy scheduler and disabled cloud service cannot silently create or run Studio tasks', async () => {
  const { service, writes, availability } = setup();
  availability.RuntimeContracts = ['AgentKernel/v1'];
  assert.equal((await service.execute('list')).availability.triggerActive, false);
  await assert.rejects(service.execute('create', { agentId: 'ar-cloud', spec: {} }), { code: 'CLOUD_SCHEDULE_RUNTIME_UNSUPPORTED' });
  availability.Enabled = false;
  await assert.rejects(service.execute('run', { agentId: 'ar-cloud', taskId: 'task-1' }), { code: 'CLOUD_SCHEDULER_DISABLED' });
  await service.execute('delete', { agentId: 'ar-cloud', taskId: 'task-1' });
  assert.deepEqual(writes, [['delete', 'task-1']], 'cleanup is still available when scheduler is down');
});

test('forged, cross-agent, and cross-account schedule references cannot mutate anything', async () => {
  const { service, task, writes } = setup();
  await assert.rejects(service.execute('create', { agentId: 'legacy-cloud', spec: {} }), /not owned/);
  task.AgentId = 'another-cloud';
  for (const operation of ['run', 'delete', 'update', 'occurrences']) await assert.rejects(service.execute(operation, { agentId: 'ar-cloud', taskId: 'task-1' }), { code: 'CLOUD_SCHEDULE_SCOPE_MISMATCH' });
  assert.deepEqual(writes, []);
  assert.ok((await service.execute('list')).warnings.length);
});


test('a failed catalog is not an empty success and does not hide ready targets', async () => {
  const ids = ['ar-ready', 'ar-unregistered'];
  let failAll = false;
  const service = createCloudSchedules({ agents: async () => ({ get: async () => ({}),
    list: async () => ({ items: ids.map(id => ({ metadata: { id } })) }),
  }), client: async () => ({ forAgent: id => ({ schedules: { list: async () => {
    if (failAll || id === 'ar-unregistered') throw new Error('Action not registered');
    return { data: { Tasks: [], Availability: { Enabled: true, RuntimeContracts: ['agentkit.responses/v1'] } } };
  } } }) }) });
  const partial = await service.execute('list');
  assert.deepEqual(partial.availability.readyAgentIds, ['ar-ready']);
  assert.equal(partial.availability.catalogReadable, true);
  assert.equal(partial.warnings.length, 1);
  failAll = true;
  const unavailable = await service.execute('list');
  assert.deepEqual(unavailable.availability.readyAgentIds, []);
  assert.equal(unavailable.availability.catalogReadable, false);
});

test('delivery is gated by Server capability, scoped and serialized as references only', async () => {
  const { service, writes, availability, task } = setup();
  const target = { channelConfigId: 'config', bindingId: 'binding', url: 'https://untrusted', token: 'private' };
  await assert.rejects(service.execute('create', { agentId: 'ar-cloud', spec: { deliveryTarget: target } }), { code: 'CLOUD_SCHEDULE_DELIVERY_UNAVAILABLE' });
  assert.deepEqual(writes, []);
  availability.DeliveryContracts = ['ChannelOutbox/v1'];
  assert.deepEqual((await service.execute('list')).availability.deliveryReadyAgentIds, ['ar-cloud']);
  await service.execute('create', { agentId: 'ar-cloud', spec: { deliveryTarget: target } });
  assert.deepEqual(writes[0][1], { DeliveryTarget: { ChannelConfigId: 'config', BindingId: 'binding' } });
  task.DeliveryTarget = { ChannelConfigId: 'config', BindingId: 'binding' };
  assert.deepEqual((await service.execute('get', { agentId: 'ar-cloud', taskId: 'task-1' })).deliveryTarget, { channelConfigId: 'config', bindingId: 'binding' });
  await service.execute('update', { agentId: 'ar-cloud', taskId: 'task-1', patch: { enabled: false } });
  assert.equal('DeliveryTarget' in writes.at(-1)[2], false);
  await service.execute('update', { agentId: 'ar-cloud', taskId: 'task-1', patch: { deliveryTarget: null } });
  assert.equal(writes.at(-1)[2].DeliveryTarget, null);
});
