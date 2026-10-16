import { createPlatformServices } from './platform.mjs';
import { createBuildServices } from './builds.mjs';
import { createAgentServices } from './agents.mjs';
import { createResourceServices } from './resources.mjs';
import { createAutomationServices } from './automation.mjs';
import { createDeploymentServices } from './deployments.mjs';
import { createAuthoringServices } from './authoring.mjs';
import { join } from 'node:path';

/** Compose one Host's domains. Late dependencies are explicit callbacks,
 * not module globals; no domain registers an RPC/HTTP transport here.
 */
export function createStudioServices(ctx, options) {
  const platform = createPlatformServices(ctx, options);
  const builds = createBuildServices(options);
  let deployments;
  const getDeployments = () => deployments();
  const agents = createAgentServices({ ...options, ...builds, deployments: getDeployments });
  const resources = createResourceServices(ctx, { ...options, ...platform });
  ({ deployments } = createDeploymentServices({ ...options, ...platform, ...builds, ...resources }));
  const automation = createAutomationServices(ctx, { ...options, ...platform, ...builds, ...agents, deployments });
  const authoring = createAuthoringServices(ctx, { ...platform, ...agents, ...resources });
  let assistantSetupPromise;
  const assistantSetup = () => assistantSetupPromise ||= Promise.all([import('../../assistant-setup.mjs'), platform.configurationPromise,
    platform.serverClientPromise, platform.deploymentClientPromise, agents.agentStorePromise, builds.studioBuildPromise, options.getModels(), deployments()])
    .then(([{ createAssistantSetup }, configuration, serverClient, deploymentClient, agentStore, studio, models, deploymentService]) => createAssistantSetup({
      storeDir: join(options.storeDir, 'assistant-setup'), configuration, serverClient, deploymentClient, agents: agentStore, build: studio.build, models, deployments: deploymentService,
    }));
  return { ...platform, ...builds, ...agents, ...resources, ...automation, ...authoring, deployments, assistantSetup };
}
