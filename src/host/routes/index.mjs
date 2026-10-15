import { createResourceRoutes } from './resources.mjs';
import { createCredentialRoute } from './credentials.mjs';
import { createBuildRoutes } from './builds.mjs';
import { createDeploymentRoutes } from './deployments.mjs';
import { createModelRoutes } from './models.mjs';
import { createAgentRoutes } from './agents.mjs';
import { createSkillRoutes } from './skills.mjs';
import { createPluginRoutes } from './plugins.mjs';
import { createSessionRoutes } from './sessions.mjs';
import { createScheduleRoutes } from './schedules.mjs';
import { createTraceRoutes } from './traces.mjs';
import { createEvaluationRoutes } from './evaluations.mjs';
import { createChannelRoutes } from './channels.mjs';
import { createServerActionRoutes } from './server.mjs';
import { createIntegrationServices } from '../services/integrations.mjs';

/** Each domain captures only its declared dependencies from this Host. */
export function createStudioRoutes(ctx, services) {
  const deps = { ...createIntegrationServices(ctx), ...services, ctx };
  const resources = createResourceRoutes(deps);
  const credentials = createCredentialRoute(deps);
  const builds = createBuildRoutes(deps);
  const models = createModelRoutes(deps);
  return Object.freeze({
    resources, mcp: resources,
    credentials: (_endpoint, payload) => credentials(payload),
    builds, operations: builds,
    deployments: createDeploymentRoutes(deps),
    models, settings: models,
    agents: createAgentRoutes(deps),
    skills: createSkillRoutes(deps),
    plugins: createPluginRoutes(deps),
    sessions: createSessionRoutes(deps),
    schedules: createScheduleRoutes(deps),
    traces: createTraceRoutes(deps),
    evaluations: createEvaluationRoutes(deps),
    channels: createChannelRoutes(deps),
    server: createServerActionRoutes(deps),
  });
}
