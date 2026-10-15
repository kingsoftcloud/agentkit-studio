import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function optionalService(promise, name) {
  return promise.catch(error => {
    console.warn(`[agentkit-studio] ${name} init failed:`, error?.message || error);
    return null;
  });
}

/** Local schedules, evaluations and channels use the current admission from
 * their owning Host. Registrations and shutdown remain in bootstrap.
 */
export function createAutomationServices(ctx, {
  storeDir, agentStorePromise, studioBuildPromise, listLocalBuildTargets,
  deployments, deploymentClientPromise, getAdmission, hostCompatibility,
}) {
  const getService = name => ctx.get(name);
  const assertHostCompatible = () => hostCompatibility?.require('automation');
  const runnerModule = import('../../native-automation-runner.mjs');
  const studioSchedulerPromise = optionalService(Promise.all([
    import('../../studio-scheduler.mjs'), runnerModule,
  ]).then(([{ createStudioScheduler }, { createNativeAutomationRunner }]) => createStudioScheduler({
    storeDir: join(storeDir, 'scheduler'),
    runner: createNativeAutomationRunner({
      getService, assertHostCompatible,
      admit: async agentId => {
        const local = await (await agentStorePromise).get(agentId);
        if (!local) throw Object.assign(new Error('本地自动化目标不存在；云端计划请在云端自动化中创建'), { code: 'SCHEDULE_AGENT_NOT_LOCAL' });
        return getAdmission().ensure(agentId, { agent: local });
      },
    }),
  })), 'scheduler');

  const studioObservabilityPromise = optionalService(
    import('../../studio-observability.mjs').then(({ createStudioObservability }) =>
      createStudioObservability({ storeDir: join(storeDir, 'traces') })),
    'observability',
  );

  const studioEvaluationPromise = optionalService(Promise.all([
    import('../../studio-evaluation.mjs'), runnerModule,
  ]).then(([{ createStudioEvaluation }, { createNativeAutomationRunner }]) => createStudioEvaluation({
    storeDir: join(storeDir, 'evaluations'),
    resolveTarget: async locator => {
      const target = (await listLocalBuildTargets()).find(build => build.id === locator);
      if (!target) throw Object.assign(new Error('评测 Build 不存在，请选择已完成的本地构建'), { code: 'EVALUATION_TARGET_NOT_FOUND' });
      await (await studioBuildPromise).build.resolve(target.agentId, target.id);
      return target;
    },
    runner: async request => createNativeAutomationRunner({
      getService, assertHostCompatible,
      admit: async (agentId, buildId) => {
        const local = await (await agentStorePromise).get(agentId);
        const frozen = await (await studioBuildPromise).build.resolve(agentId, buildId);
        return getAdmission().ensure(agentId, {
          agent: { ...frozen, metadata: { ...local.metadata, ...frozen.metadata, local: true } },
        });
      },
    })({
      ...request, sessionId: `eval-session-${randomUUID()}`,
      occurrenceId: `eval-request-${randomUUID()}`,
    }),
  })), 'evaluation');

  const studioChannelsPromise = optionalService(Promise.all([
    import('../../studio-channels.mjs'), runnerModule,
  ]).then(([{ createStudioChannels }, { createNativeAutomationRunner }]) => createStudioChannels({
    storeDir,
    getAgent: async id => (await agentStorePromise).get(id),
    listAgents: async () => (await agentStorePromise).list(),
    listCloudAgents: async () => (await (await deployments()).agents.list()).items,
    resolveCloudAgent: async id => {
      const agent = await (await deployments()).agents.get(id);
      const identity = await (await deploymentClientPromise).inspectIdentity();
      if (identity.kind !== 'subaccount') throw Object.assign(new Error('云端渠道绑定需要已核验的子账号 AK/SK'), { code: 'CLOUD_SUBACCOUNT_REQUIRED' });
      return { agent, accountId: identity.accountId, userUuid: identity.userUuid };
    },
    runner: createNativeAutomationRunner({
      getService, assertHostCompatible, reuseSession: true,
      admit: async agentId => {
        const local = await (await agentStorePromise).get(agentId);
        if (!local) throw Object.assign(new Error('渠道绑定的本地 Agent 不存在'), { code: 'CHANNEL_AGENT_UNAVAILABLE' });
        return getAdmission().ensure(agentId, { agent: local });
      },
    }),
  })), 'channels');

  const cloudSchedulesPromise = import('../../cloud-schedules.mjs').then(({ createCloudSchedules }) => createCloudSchedules({
    agents: async () => (await deployments()).agents,
    client: () => deploymentClientPromise,
    deliveryTargets: async agentId => (await studioChannelsPromise).deliveryTargets(agentId),
  }));
  return {
    studioSchedulerPromise, studioObservabilityPromise, studioEvaluationPromise,
    studioChannelsPromise, cloudSchedulesPromise,
  };
}
